// The booking-idempotency PENDING-TTL race — reproduction + regression.
//
// `bk:idem:{key}` used to carry a `'PENDING'` sentinel with a FIXED 30s TTL while a
// booking request was in flight. The lease was sized against a guess about how long
// the route takes, and the route can legitimately outrun it: /api/book does a
// bookable-date scan, a deposit read, Zelle proof sealing (encrypt + blob PUT), a
// booking save, an ops email and a Stripe checkout create. When the owning request
// crossed 30s the reservation silently evaporated — a retry then saw a free key and
// created a SECOND booking for one customer submission. Two bookings, two booking
// numbers, two deposits owed, one date double-held.
//
// This is a DUPLICATE-BOOKING defect, not a duplicate-AiJob defect: each booking gets
// its own token, so their AI jobs are correctly distinct. The bug is that the second
// booking exists at all.
//
// Everything below runs on a fake Upstash with REAL expiry semantics driven by a
// virtual clock, so "the lease expired" is modelled by time passing rather than by
// reaching into the store. No network, no model call, no Stripe.
import assert from 'node:assert/strict'
import test, { beforeEach, afterEach, mock } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'

process.env.KV_REST_API_URL = 'http://idem-race-kv.local'
process.env.KV_REST_API_TOKEN = 'test-token'
delete process.env.STRIPE_SECRET_KEY
delete process.env.RESEND_API_KEY
delete process.env.OWNER_SMS

const KV = 'http://idem-race-kv.local'

// ── Fake Upstash: virtual clock + honest TTLs ───────────────────────────────
type Entry = { value: string; expiresAt: number | null }
const store = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

let clock = 1_000_000

/**
 * Advance time for BOTH the store's expiry clock and the runtime's timers, in
 * lock-step. The heartbeat that keeps a live reservation alive is a real
 * `setInterval` inside lib/kv-lock, so a test that only moved the store's clock
 * would "prove" the fix by starving the very mechanism under test. Stepping in 1s
 * slices lets each beat fire and its async renewal land before more time passes.
 */
async function advance(ms: number) {
  const STEP = 1_000
  // Fine-grained only across the window where a lease could lapse and a beat could
  // save it; past that the outcome is settled, so a long jump stays a long jump.
  const fine = Math.min(ms, 150_000)
  for (let done = 0; done < fine; done += STEP) {
    const slice = Math.min(STEP, fine - done)
    clock += slice
    mock.timers.tick(slice)
    await tick()          // let the renewal's fetch round-trip settle
    await tick()
  }
  if (ms > fine) { clock += ms - fine; mock.timers.tick(ms - fine); await tick() }
}

function live(key: string): Entry | undefined {
  const e = store.get(key)
  if (!e) return undefined
  if (e.expiresAt !== null && e.expiresAt <= clock) { store.delete(key); return undefined }
  return e
}

// A gate that suspends the next request to reach the booking-number counter. That
// point is past all validation and immediately before the booking is written, which
// is exactly "the owning request is still legitimately working". Rebuilt per test —
// a module-level gate would fire once and silently no-op for every later test.
type Gate = { reached: Promise<void>; open: () => void }
let gate: Gate | null = null
function armGate(): Gate {
  let hit!: () => void, release!: () => void
  const reached = new Promise<void>(r => { hit = r })
  const opened = new Promise<void>(r => { release = r })
  gate = { reached, open: release }
  gateHold = async () => { hit(); await opened }
  return gate
}
let gateHold: (() => Promise<void>) | null = null

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== KV) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const parts = JSON.parse(String(init?.body)) as (string | number)[]
  const cmd = String(parts[0]).toUpperCase()
  const key = String(parts[1])
  const args = parts.slice(2).map(String)

  if (cmd === 'INCR' && key.includes('counter') && gateHold) {
    const hold = gateHold
    gateHold = null             // only the FIRST arrival is suspended
    await hold()                // hold this request in flight
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
    case 'INCR': {
      const n = Number(live(key)?.value ?? 0) + 1
      store.set(key, { value: String(n), expiresAt: null }); result = n; break
    }
    case 'PEXPIRE': {
      const e = live(key)
      if (e) { e.expiresAt = clock + Number(args[0]); result = 1 } else result = 0
      break
    }
    case 'EXPIRE': {
      const e = live(key)
      if (e) { e.expiresAt = clock + Number(args[0]) * 1000; result = 1 } else result = 0
      break
    }
    case 'EVAL': {
      // The two kv-lock scripts: compare-and-delete, compare-and-extend.
      const script = key                        // KEYS[0] slot holds the script here
      const n = Number(parts[2])
      const k = String(parts[3])
      const argv = parts.slice(3 + n).map(String)
      const cur = live(k)?.value ?? null
      if (script.includes("del")) {
        if (cur === argv[0]) { store.delete(k); result = 1 } else result = 0
      } else if (script.includes("pexpire")) {
        const e = live(k)
        if (cur === argv[0] && e) { e.expiresAt = clock + Number(argv[1]); result = 1 } else result = 0
      }
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
import { listBookings, getBookingByToken } from '../app/lib/bookings'
import { getAvailability } from '../app/lib/availability'
import { NextRequest } from 'next/server'

const PHOTOS = [
  'https://idem-race.public.blob.vercel-storage.com/a.jpg',
  'https://idem-race.public.blob.vercel-storage.com/b.jpg',
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
    name: 'Grace Hopper', email: 'grace@example.com', phone: '555-0142',
    service: 'junk-removal', loadSize: 'half', date: await openDate(), window: '8am–10am',
    photos: PHOTOS, paymentMethod: 'stripe', idempotencyKey: 'race-key-1', ...over,
  }
}

beforeEach(() => {
  store.clear(); zsets.clear(); clock = 1_000_000
  // Only setInterval — the heartbeat. Leaving setTimeout real keeps `tick()` and any
  // incidental awaits working normally.
  mock.timers.enable({ apis: ['setInterval'] })
})
afterEach(() => { mock.timers.reset() })

// ── The race itself ─────────────────────────────────────────────────────────

test('RACE: a request that outruns the old 30s lease cannot be duplicated by a retry', async () => {
  // A starts and is suspended mid-flight, past validation, before its booking write.
  const g = armGate()
  const body = await payload()
  const aPromise = book(body)
  await g.reached

  // 45s of wall clock passes while A is still legitimately working. Under the old
  // fixed 30s PENDING TTL the reservation is now GONE and the key looks free.
  await advance(45_000)

  // B is the customer's retry (same key, same submission). It must NOT be allowed to
  // create a second booking for the same idempotency key.
  const b = await book(body)
  g.open()
  const a = await aPromise

  const all = await listBookings(50)
  const numbers = all.map(x => x.bookingNumber).sort()
  assert.equal(
    all.length, 1,
    `one submission must yield ONE booking; got ${all.length}: ${numbers.join(', ')}`,
  )

  // Both responses point the customer at the SAME booking — neither is orphaned.
  const aTok = String(a.json.token ?? '')
  const bTok = String(b.json.token ?? '')
  const tokens = [aTok, bTok].filter(Boolean)
  assert.ok(tokens.length > 0, 'at least one response carries a booking token')
  assert.equal(new Set(tokens).size, 1, `both responses must reference one booking, got ${tokens.length} distinct`)
  assert.equal(all[0].token, tokens[0])
})

test('RACE: the in-flight reservation survives well past 30s and is still enforced', async () => {
  const g = armGate()
  const body = await payload({ idempotencyKey: "race-key-long" })
  const aPromise = book(body)
  await g.reached

  await advance(120_000)              // two minutes — far beyond any fixed lease
  const b = await book(body)
  assert.notEqual(b.status, 200, 'a retry mid-flight must not be handed a fresh booking')

  g.open()
  await aPromise
  assert.equal((await listBookings(50)).length, 1)
})

// ── Everything the fix must not break ───────────────────────────────────────

test('a normal first booking still succeeds', async () => {
  const { status, json } = await book(await payload({ idempotencyKey: 'plain-1' }))
  assert.equal(status, 200, JSON.stringify(json))
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  assert.equal(all[0].token, json.token)
})

test('an immediate duplicate submission returns the original booking', async () => {
  const body = await payload({ idempotencyKey: 'dup-1' })
  const first = await book(body)
  const second = await book(body)
  assert.equal(second.json.duplicate, true)
  assert.equal(second.json.token, first.json.token)
  assert.equal((await listBookings(50)).length, 1)
})

test('concurrent same-key requests yield exactly one booking', async () => {
  const body = await payload({ idempotencyKey: 'concurrent-1' })
  const results = await Promise.all([book(body), book(body), book(body), book(body)])
  const all = await listBookings(50)
  assert.equal(all.length, 1, `4 concurrent submissions → 1 booking, got ${all.length}`)
  assert.equal(results.filter(r => r.status === 200).length >= 1, true, 'at least one caller succeeds')
  const tokens = new Set(results.map(r => String(r.json.token ?? '')).filter(Boolean))
  assert.ok(tokens.size <= 1, 'no caller sees a booking other than the one that exists')
})

test('different idempotency keys remain fully independent', async () => {
  await book(await payload({ idempotencyKey: 'indep-a' }))
  await book(await payload({ idempotencyKey: 'indep-b' }))
  const all = await listBookings(50)
  assert.equal(all.length, 2)
  assert.equal(new Set(all.map(b => b.bookingNumber)).size, 2)
})

test('a request with no idempotency key is unaffected', async () => {
  await book(await payload({ idempotencyKey: undefined }))
  await book(await payload({ idempotencyKey: undefined }))
  assert.equal((await listBookings(50)).length, 2, 'no key = no dedupe, unchanged')
})

test('a FAILED owner request releases the key so a retry can proceed', async () => {
  // An unbookable date fails AFTER the reservation is taken. The customer fixing the
  // date and resubmitting under the same key must not be told "already processing".
  const bad = await payload({ idempotencyKey: 'fail-1', date: '2001-01-01' })
  const failed = await book(bad)
  assert.equal(failed.status, 409, 'unbookable date still rejected')
  assert.equal((await listBookings(50)).length, 0, 'nothing persisted')

  const good = await book(await payload({ idempotencyKey: 'fail-1' }))
  assert.equal(good.status, 200, 'the retry is not blocked by the failed attempt')
  assert.equal((await listBookings(50)).length, 1)
})

test('a crashed reservation eventually recovers (no indefinite lock)', async () => {
  // Model a hard crash: the owner claims the key and never returns — no release, no
  // heartbeat. The lease must lapse on its own so the key is not poisoned forever.
  const { acquireLock } = await import('../app/lib/kv-lock')
  const orphan = await acquireLock('bk:idem:lock:crash-1', { ttlMs: 20_000 })
  assert.ok(orphan, 'reservation taken')

  await advance(60_000)               // no heartbeat ran, because the owner died

  const after = await book(await payload({ idempotencyKey: 'crash-1' }))
  assert.equal(after.status, 200, 'a stale reservation must not block forever')
  assert.equal((await listBookings(50)).length, 1)
})

test('one request cannot release another request\'s reservation', async () => {
  const { acquireLock } = await import('../app/lib/kv-lock')
  const a = await acquireLock('bk:idem:lock:own-1', { ttlMs: 30_000 })
  assert.ok(a)
  await advance(31_000)                                   // A's lease lapses
  const b = await acquireLock('bk:idem:lock:own-1', { ttlMs: 30_000 })
  assert.ok(b, 'B takes the key after A lapsed')

  assert.equal(await a!.release(), false, 'A must NOT delete the key B now owns')
  assert.equal(await b!.heldNow(), true, 'B still holds it')
  assert.equal(await b!.release(), true, 'B releases its own')
})

test('a retry long after success still returns the original booking', async () => {
  const body = await payload({ idempotencyKey: 'late-retry' })
  const first = await book(body)
  await advance(6 * 60 * 60_000)                          // six hours later
  const later = await book(body)
  assert.equal(later.json.duplicate, true, 'the final mapping outlives any lease')
  assert.equal(later.json.token, first.json.token)
  assert.equal((await listBookings(50)).length, 1)
})

// ── The sibling intake path shares the same key namespace ──────────────────

test('persistQuoteRequest: a slow request cannot be duplicated by a retry either', async () => {
  const { persistQuoteRequest } = await import('../app/lib/booking-requests')
  const input = { name: 'Grace Hopper', serviceType: 'junk-removal' as const, photos: PHOTOS, idempotencyKey: 'quote-race-1' }

  armGate()
  const aPromise = persistQuoteRequest(input)
  await gate!.reached
  await advance(45_000)                     // past the old fixed lease

  const b = await persistQuoteRequest(input)
  gate!.open()
  const a = await aPromise

  assert.equal((await listBookings(50)).length, 1, 'one submission → one booking')
  assert.equal(b, null, 'the retry is told "in progress", never handed a new booking')
  assert.ok(a, 'the owner still returns its booking')
})

test('persistQuoteRequest: a completed request still dedupes a later retry', async () => {
  const { persistQuoteRequest } = await import('../app/lib/booking-requests')
  const input = { name: 'Grace Hopper', serviceType: 'junk-removal' as const, photos: PHOTOS, idempotencyKey: 'quote-dup-1' }
  const first = await persistQuoteRequest(input)
  await advance(60_000)
  const again = await persistQuoteRequest(input)
  assert.equal(again?.token, first?.token)
  assert.equal((await listBookings(50)).length, 1)
})

test('the two intake paths do not deadlock each other on distinct keys', async () => {
  const { persistQuoteRequest } = await import('../app/lib/booking-requests')
  await book(await payload({ idempotencyKey: 'cross-book' }))
  const q = await persistQuoteRequest({
    name: 'Grace Hopper', serviceType: 'junk-removal', photos: PHOTOS, idempotencyKey: 'cross-quote',
  })
  assert.ok(q)
  assert.equal((await listBookings(50)).length, 2, 'independent keys, independent bookings')
})

test('the deduped booking carries exactly one AI job', async () => {
  const body = await payload({ idempotencyKey: 'ai-dedupe' })
  await book(body)
  await book(body)
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  const b = (await getBookingByToken(all[0].token))!
  assert.equal(b.aiJob?.status, 'queued')
  assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1, 'one job, not two')
})
