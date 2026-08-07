// Issue #178 — ownership at the write boundary.
//
// PR #176 replaced the fixed 30s PENDING TTL with a renewable lease, so a request
// that merely TAKES a long time can no longer be duplicated. It left one hole: the
// write path never re-verified that it still owned the lease.
//
//   A acquires the lease → A's heartbeat cannot reach the store for a full window →
//   A's lease lapses → B legitimately acquires the SAME key → A resumes and writes
//   anyway → two bookings, two deposits owed, one date double-held.
//
// The heartbeat is a `setInterval` doing compare-and-extend. Break only that one
// call and the lease decays exactly as it would under a partial store failure,
// while ordinary reads and writes keep working — which is precisely the state in
// which the old code produced a duplicate.
//
// The fix does NOT bolt an ownership assertion onto the write (see the design note
// in lib/booking-idempotency.ts): it makes the FINAL key an atomic SET-NX claim, so
// exclusivity at the write boundary stops depending on lease timing at all. These
// tests therefore assert the invariant — "one submission, one booking" — rather
// than asserting that any particular guard was called.
import assert from 'node:assert/strict'
import test, { beforeEach, afterEach, mock } from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'

process.env.KV_REST_API_URL = 'http://idem-own-kv.local'
process.env.KV_REST_API_TOKEN = 'test-token'
delete process.env.STRIPE_SECRET_KEY
delete process.env.RESEND_API_KEY
delete process.env.OWNER_SMS

const KV = 'http://idem-own-kv.local'

type Entry = { value: string; expiresAt: number | null }
const store = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

let clock = 1_000_000
/** When true, only the heartbeat's compare-and-extend fails. Everything else works. */
let breakRenew = false
/** When true, the booking write fails — for the "claim must not dangle" case. */
let breakSave = false

async function advance(ms: number) {
  const STEP = 1_000
  const fine = Math.min(ms, 150_000)
  for (let done = 0; done < fine; done += STEP) {
    const slice = Math.min(STEP, fine - done)
    clock += slice
    mock.timers.tick(slice)
    await flush(); await flush()
  }
  if (ms > fine) { clock += ms - fine; mock.timers.tick(ms - fine); await flush() }
}

function live(key: string): Entry | undefined {
  const e = store.get(key)
  if (!e) return undefined
  if (e.expiresAt !== null && e.expiresAt <= clock) { store.delete(key); return undefined }
  return e
}

type Gate = { reached: Promise<void>; open: () => void }
let gate: Gate | null = null
let gateHold: (() => Promise<void>) | null = null
function armGate(): Gate {
  let hit!: () => void, release!: () => void
  const reached = new Promise<void>(r => { hit = r })
  const opened = new Promise<void>(r => { release = r })
  gate = { reached, open: release }
  gateHold = async () => { hit(); await opened }
  return gate
}

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== KV) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const parts = JSON.parse(String(init?.body)) as (string | number)[]
  const cmd = String(parts[0]).toUpperCase()
  const key = String(parts[1])
  const args = parts.slice(2).map(String)

  // Suspend the first request to reach the booking-number counter: past validation,
  // immediately before the irreversible write.
  if (cmd === 'INCR' && key.includes('counter') && gateHold) {
    const hold = gateHold; gateHold = null
    await hold()
  }
  if (breakSave && cmd === 'SET' && key.startsWith('bk:') && !key.startsWith('bk:idem:')) {
    throw new Error('booking write transport failure')
  }

  let result: unknown = null
  switch (cmd) {
    case 'GET': result = live(key)?.value ?? null; break
    case 'SET': {
      const nx = args.some(a => a.toUpperCase() === 'NX')
      const pxAt = args.findIndex(a => a.toUpperCase() === 'PX')
      const ttl = pxAt >= 0 ? Number(args[pxAt + 1]) : null
      if (nx && live(key)) { result = null; break }
      store.set(key, { value: args[0], expiresAt: ttl ? clock + ttl : null })
      result = 'OK'
      break
    }
    case 'DEL': result = store.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(live(key)?.value ?? 0) + 1; store.set(key, { value: String(n), expiresAt: null }); result = n; break }
    case 'PEXPIRE': { const e = live(key); if (e) { e.expiresAt = clock + Number(args[0]); result = 1 } else result = 0; break }
    case 'EXPIRE': { const e = live(key); if (e) { e.expiresAt = clock + Number(args[0]) * 1000; result = 1 } else result = 0; break }
    case 'EVAL': {
      const script = key
      const n = Number(parts[2])
      const k = String(parts[3])
      const argv = parts.slice(3 + n).map(String)
      if (script.includes('pexpire') && breakRenew) throw new Error('renew transport failure')
      const cur = live(k)?.value ?? null
      if (script.includes('del')) { if (cur === argv[0]) { store.delete(k); result = 1 } else result = 0 }
      else if (script.includes('pexpire')) { const e = live(k); if (cur === argv[0] && e) { e.expiresAt = clock + Number(argv[1]); result = 1 } else result = 0 }
      break
    }
    case 'ZADD': z(key).set(args[1], Number(args[0])); result = 1; break
    case 'ZREM': result = z(key).delete(args[0]) ? 1 : 0; break
    case 'ZSCORE': result = z(key).get(args[0]) ?? null; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE': case 'ZRANGEBYSCORE':
      result = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m); break
    case 'ZREVRANGE': {
      const stop = Number(args[1])
      result = [...z(key).entries()].sort((a, b) => b[1] - a[1])
        .slice(Number(args[0]), stop < 0 ? undefined : stop + 1).map(([m]) => m); break
    }
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

import { POST } from '../app/api/book/route'
import { persistQuoteRequest } from '../app/lib/booking-requests'
import { listBookings, getBookingByToken } from '../app/lib/bookings'
import { getAvailability } from '../app/lib/availability'
import { acquireLock } from '../app/lib/kv-lock'
import { NextRequest } from 'next/server'

const PHOTOS = [
  'https://idem-own.public.blob.vercel-storage.com/a.jpg',
  'https://idem-own.public.blob.vercel-storage.com/b.jpg',
]

async function openDate(): Promise<string> {
  const { dates } = await getAvailability(120, 1)
  assert.ok(dates.length > 0)
  return dates[0]
}

type Body = Record<string, unknown>
async function book(body: Body) {
  const req = new NextRequest('http://localhost/api/book', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await POST(req, undefined)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function payload(over: Body = {}): Promise<Body> {
  return {
    name: 'Barbara Liskov', email: 'liskov@example.com', phone: '555-0177',
    service: 'junk-removal', loadSize: 'half', date: await openDate(), window: '8am–10am',
    photos: PHOTOS, paymentMethod: 'stripe', idempotencyKey: 'own-key', ...over,
  }
}

beforeEach(() => {
  store.clear(); zsets.clear(); clock = 1_000_000
  breakRenew = false; breakSave = false; gateHold = null
  mock.timers.enable({ apis: ['setInterval'] })
})
afterEach(() => { mock.timers.reset() })

// ── The #178 race ───────────────────────────────────────────────────────────

test('#178: an owner that LOST its lease mid-flight cannot also persist', async () => {
  breakRenew = true                       // the heartbeat can no longer reach the store
  armGate()
  const body = await payload({ idempotencyKey: 'lost-lease' })
  const aPromise = book(body)
  await gate!.reached                     // A is past validation, before its write

  await advance(45_000)                   // every beat fails → A's lease lapses

  const b = await book(body)              // B legitimately acquires the freed key
  gate!.open()
  const a = await aPromise

  const all = await listBookings(50)
  assert.equal(
    all.length, 1,
    `a lost lease must not licence a second write; got ${all.length}: ${all.map(x => x.bookingNumber).join(', ')}`,
  )

  // Whichever request won, both callers must be pointed at that ONE booking — no
  // caller may walk away believing it created a different one.
  const tokens = [String(a.json.token ?? ''), String(b.json.token ?? '')].filter(Boolean)
  assert.equal(new Set(tokens).size, 1, 'both callers reference one booking')
  assert.equal(all[0].token, tokens[0])
})

test('#178: the same race on the persistQuoteRequest path', async () => {
  breakRenew = true
  armGate()
  const input = { name: 'Barbara Liskov', serviceType: 'junk-removal' as const, photos: PHOTOS, idempotencyKey: 'lost-lease-quote' }
  const aPromise = persistQuoteRequest(input)
  await gate!.reached
  await advance(45_000)
  const b = await persistQuoteRequest(input)
  gate!.open()
  const a = await aPromise

  const all = await listBookings(50)
  assert.equal(all.length, 1, `one submission → one booking; got ${all.length}`)
  const tokens = [a?.token, b?.token].filter(Boolean) as string[]
  assert.equal(new Set(tokens).size, 1, 'both callers reference one booking')
})

test('#178: a heartbeat failure ALONE never duplicates, even with no competitor', async () => {
  // Invariant 3: losing the lease is not, by itself, allowed to cost the customer a
  // booking OR create a spare one. With nobody racing, the request must simply win.
  breakRenew = true
  const { status, json } = await book(await payload({ idempotencyKey: 'solo-lost-lease' }))
  assert.equal(status, 200, 'a lone request must still succeed after losing its lease')
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  assert.equal(all[0].token, json.token)
})

// ── Invariants that must survive the fix ────────────────────────────────────

test('a healthy owner still persists normally', async () => {
  const { status, json } = await book(await payload({ idempotencyKey: 'healthy' }))
  assert.equal(status, 200)
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  assert.equal(all[0].token, json.token)
})

test('a slow but healthy request keeps its lease and persists', async () => {
  armGate()
  const body = await payload({ idempotencyKey: 'slow-healthy' })
  const aPromise = book(body)
  await gate!.reached
  await advance(120_000)                  // two minutes, heartbeat working
  const b = await book(body)              // retry mid-flight
  gate!.open()
  const a = await aPromise

  assert.equal(a.status, 200, 'the healthy owner still wins')
  assert.notEqual(b.status, 200, 'the mid-flight retry is refused, not given a new booking')
  assert.equal((await listBookings(50)).length, 1)
})

test('heartbeat renewal actually extends the lease (the mechanism is live)', async () => {
  const lock = await acquireLock('bk:idem:lock:beat-check', { ttlMs: 30_000, renew: true })
  assert.ok(lock)
  await advance(90_000)                   // 3x the lease
  assert.equal(await lock!.heldNow(), true, 'renewals kept it alive')
  assert.equal(await lock!.release(), true)
})

test('a crashed owner is still recoverable', async () => {
  const orphan = await acquireLock('bk:idem:lock:crash-178', { ttlMs: 20_000 })
  assert.ok(orphan)
  await advance(60_000)                   // no heartbeat — the owner died
  const after = await book(await payload({ idempotencyKey: 'crash-178' }))
  assert.equal(after.status, 200, 'a dead owner must not poison the key')
  assert.equal((await listBookings(50)).length, 1)
})

test('a failed write does not strand the key against a retry', async () => {
  breakSave = true
  await book(await payload({ idempotencyKey: 'save-fail' })).catch(() => ({}))
  assert.equal((await listBookings(50)).length, 0, 'nothing persisted')

  breakSave = false
  const retry = await book(await payload({ idempotencyKey: 'save-fail' }))
  assert.equal(retry.status, 200, 'the claim was released, so the retry proceeds')
  assert.equal((await listBookings(50)).length, 1)
})

test('concurrent same-key requests produce one logical booking', async () => {
  const body = await payload({ idempotencyKey: 'concurrent-178' })
  const res = await Promise.all([book(body), book(body), book(body), book(body), book(body)])
  const all = await listBookings(50)
  assert.equal(all.length, 1, `5 concurrent → 1 booking, got ${all.length}`)
  const tokens = new Set(res.map(r => String(r.json.token ?? '')).filter(Boolean))
  assert.ok(tokens.size <= 1, 'no caller sees a booking other than the one that exists')
})

test('a retry after success returns the original booking', async () => {
  const body = await payload({ idempotencyKey: 'retry-178' })
  const first = await book(body)
  await advance(60_000)
  const again = await book(body)
  assert.equal(again.json.duplicate, true)
  assert.equal(again.json.token, first.json.token)
  assert.equal((await listBookings(50)).length, 1)
})

test('different keys remain independent', async () => {
  await book(await payload({ idempotencyKey: 'indep-x' }))
  await book(await payload({ idempotencyKey: 'indep-y' }))
  assert.equal((await listBookings(50)).length, 2)
})

test('cleanup stays ownership-safe: one request cannot release another\'s lease', async () => {
  const a = await acquireLock('bk:idem:lock:own-178', { ttlMs: 30_000 })
  assert.ok(a)
  await advance(31_000)
  const b = await acquireLock('bk:idem:lock:own-178', { ttlMs: 30_000 })
  assert.ok(b, 'B takes the lapsed key')
  assert.equal(await a!.release(), false, 'A cannot delete the key B now owns')
  assert.equal(await b!.heldNow(), true)
})

test('an eligible photo booking still yields exactly one AiJob', async () => {
  const body = await payload({ idempotencyKey: 'ai-178' })
  await book(body)
  await book(body)
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  const b = (await getBookingByToken(all[0].token))!
  assert.equal(b.aiJob?.status, 'queued')
  assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1)
})

test('a lost lease during an eligible photo booking still yields one AiJob', async () => {
  breakRenew = true
  armGate()
  const body = await payload({ idempotencyKey: 'ai-lost-lease' })
  const aPromise = book(body)
  await gate!.reached
  await advance(45_000)
  await book(body)
  gate!.open()
  await aPromise

  const all = await listBookings(50)
  assert.equal(all.length, 1)
  const b = (await getBookingByToken(all[0].token))!
  assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1, 'one job, not two')
})
