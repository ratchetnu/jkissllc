// Stranded-claim recovery — the availability edge left open by #179.
//
// #179 made the final key an atomic SET NX claim taken BEFORE the write, which is
// what guarantees exactly one booking per key. The cost: the claim is now written
// before there is anything behind it. If `saveBooking` fails AND the compare-and-
// delete rollback also fails — one store outage causes both, since they share a
// transport — the key is left holding a claim with no booking, and every retry is
// told "already being processed" for the full 24h TTL.
//
// Not a duplicate defect. A stranding/availability defect: the customer is refused
// a booking that was never made.
//
// The fix does not shorten the TTL and does not go back to lease-based correctness.
// It makes the claim a two-state record — `claimed:` → `committed:` — so a retry can
// tell "someone is mid-flight" from "someone died holding this", and recover from
// the second WITHOUT ever being able to disturb the first. Proof of non-commitment
// is the absence of the booking record itself, never elapsed time.
import assert from 'node:assert/strict'
import test, { beforeEach, afterEach, mock } from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'

process.env.KV_REST_API_URL = 'http://idem-rec-kv.local'
process.env.KV_REST_API_TOKEN = 'test-token'
delete process.env.STRIPE_SECRET_KEY
delete process.env.RESEND_API_KEY
delete process.env.OWNER_SMS

const KV = 'http://idem-rec-kv.local'

type Entry = { value: string; expiresAt: number | null }
const store = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

let clock = 1_000_000
/** Booking-record writes fail — the store is unavailable for the save. */
let breakSave = false
/** Lua fails — so the rollback compare-and-delete and the heartbeat both fail too. */
let breakEval = false

async function advance(ms: number) {
  const STEP = 1_000
  const fine = Math.min(ms, 150_000)
  for (let done = 0; done < fine; done += STEP) {
    const slice = Math.min(STEP, fine - done)
    clock += slice; mock.timers.tick(slice)
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

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== KV) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const parts = JSON.parse(String(init?.body)) as (string | number)[]
  const cmd = String(parts[0]).toUpperCase()
  const key = String(parts[1])
  const args = parts.slice(2).map(String)

  // The booking RECORD write fails; idempotency bookkeeping keeps working, which is
  // what isolates this to "save failed" rather than "everything failed".
  if (breakSave && cmd === 'SET' && key.startsWith('bk:') && !key.startsWith('bk:idem:')) {
    throw new Error('booking write transport failure')
  }
  if (breakEval && cmd === 'EVAL') throw new Error('eval transport failure')

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
      const cur = live(k)?.value ?? null
      if (script.includes("'del'") || script.includes('del')) {
        if (script.includes('set')) {          // compare-and-set
          if (cur === argv[0]) { store.set(k, { value: argv[1], expiresAt: clock + Number(argv[2]) }); result = 1 } else result = 0
        } else if (cur === argv[0]) { store.delete(k); result = 1 } else result = 0
      } else if (script.includes('pexpire')) {
        const e = live(k); if (cur === argv[0] && e) { e.expiresAt = clock + Number(argv[1]); result = 1 } else result = 0
      } else if (script.includes('set')) {
        if (cur === argv[0]) { store.set(k, { value: argv[1], expiresAt: clock + Number(argv[2]) }); result = 1 } else result = 0
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
import { persistQuoteRequest } from '../app/lib/booking-requests'
import { listBookings, getBookingByToken } from '../app/lib/bookings'
import { getAvailability } from '../app/lib/availability'
import { NextRequest } from 'next/server'

const PHOTOS = [
  'https://idem-rec.public.blob.vercel-storage.com/a.jpg',
  'https://idem-rec.public.blob.vercel-storage.com/b.jpg',
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
    name: 'Radia Perlman', email: 'radia@example.com', phone: '555-0199',
    service: 'junk-removal', loadSize: 'half', date: await openDate(), window: '8am–10am',
    photos: PHOTOS, paymentMethod: 'stripe', idempotencyKey: 'rec-key', ...over,
  }
}

/** The raw claim record, for asserting the state machine directly. */
const claimOf = (key: string) => live(`bk:idem:${key}`)?.value ?? null

beforeEach(() => {
  store.clear(); zsets.clear(); clock = 1_000_000
  breakSave = false; breakEval = false
  mock.timers.enable({ apis: ['setInterval'] })
})
afterEach(() => { mock.timers.reset() })

// ── The stranding failure ───────────────────────────────────────────────────

test('STRANDED: save fails AND rollback fails — a retry must still recover', async () => {
  // A wins the claim, its write fails, and its rollback cannot reach the store
  // either. Nothing was persisted, yet the key is now held.
  breakSave = true; breakEval = true
  await book(await payload({ idempotencyKey: 'stranded' })).catch(() => ({}))

  assert.equal((await listBookings(50)).length, 0, 'nothing was persisted')
  assert.ok(claimOf('stranded'), 'the claim is still present — this is the stranding')

  // The customer retries. Under #179 this is a 409 for the next 24h.
  //
  // The outage also stopped A's lease being released, so recovery waits out the
  // LEASE (30s, the existing crash-recovery window) — not the 24h claim TTL. That
  // distinction is the whole point and is asserted on its own below.
  breakSave = false; breakEval = false
  await advance(31_000)
  const retry = await book(await payload({ idempotencyKey: 'stranded' }))
  assert.equal(retry.status, 200, 'a retry must recover from a claim that never committed')
  const all = await listBookings(50)
  assert.equal(all.length, 1, 'exactly one booking results')
  assert.equal(all[0].token, retry.json.token)
})

test('STRANDED: the same stranding on the persistQuoteRequest path', async () => {
  breakSave = true; breakEval = true
  const input = { name: 'Radia Perlman', serviceType: 'junk-removal' as const, photos: PHOTOS, idempotencyKey: 'stranded-quote' }
  await persistQuoteRequest(input).catch(() => null)
  assert.equal((await listBookings(50)).length, 0)
  assert.ok(claimOf('stranded-quote'), 'claim stranded')

  breakSave = false; breakEval = false
  await advance(31_000)
  const retry = await persistQuoteRequest(input)
  assert.ok(retry, 'the retry recovers rather than being refused')
  assert.equal((await listBookings(50)).length, 1)
})

test('STRANDED: recovery costs the 30s lease window, NOT the 24h claim TTL', async () => {
  breakSave = true; breakEval = true
  await book(await payload({ idempotencyKey: 'no-wait' })).catch(() => ({}))
  breakSave = false; breakEval = false

  // The claim is still sitting there with its full 24h TTL...
  assert.match(claimOf('no-wait') ?? '', /^claimed:/, 'the uncommitted claim persists')

  // ...yet one lease window is all it takes. Under #179 this same wait changed
  // nothing and the key stayed refused for the rest of the day.
  await advance(31_000)
  const retry = await book(await payload({ idempotencyKey: 'no-wait' }))
  assert.equal(retry.status, 200, 'recovered after a lease window, not a TTL')
  assert.equal((await listBookings(50)).length, 1)

  // And the recovery genuinely took over the old claim rather than waiting it out:
  // the surviving record points at the NEW booking, under a committed state.
  assert.equal(claimOf('no-wait'), `committed:${retry.json.token}`)
})

// ── A committed booking is immutable ────────────────────────────────────────

test('a COMMITTED result can never be taken over, however long it sits', async () => {
  const first = await book(await payload({ idempotencyKey: 'committed' }))
  assert.equal(first.status, 200)
  assert.match(claimOf('committed') ?? '', /^committed:/, 'success marks the claim committed')

  await advance(150_000)          // long enough for any lease to be long gone
  const again = await book(await payload({ idempotencyKey: 'committed' }))
  assert.equal(again.json.duplicate, true, 'the committed booking is returned, never re-created')
  assert.equal(again.json.token, first.json.token)
  assert.equal((await listBookings(50)).length, 1)
})

test('a booking that WAS persisted but whose commit flip failed is healed, not duplicated', async () => {
  // The nastiest ordering: the write lands, then the claimed→committed transition
  // cannot reach the store. The record exists; the claim still says `claimed`.
  // Proof of commitment is the booking's existence, so a retry must adopt it.
  breakEval = true
  const first = await book(await payload({ idempotencyKey: 'flip-failed' }))
  assert.equal(first.status, 200)
  const all = await listBookings(50)
  assert.equal(all.length, 1, 'the booking really was persisted')
  assert.match(claimOf('flip-failed') ?? '', /^claimed:/, 'but the claim never flipped')

  breakEval = false
  const retry = await book(await payload({ idempotencyKey: 'flip-failed' }))
  assert.equal(retry.json.duplicate, true, 'the retry must find the existing booking')
  assert.equal(retry.json.token, all[0].token)
  assert.equal((await listBookings(50)).length, 1, 'and must NOT create a second one')
  assert.match(claimOf('flip-failed') ?? '', /^committed:/, 'the state is healed on the way past')
})

// ── The commit helper's own state machine, exercised directly ───────────────
//
// The route short-circuits on a committed key long before reaching the commit
// helper, so these drive `commitIdempotently` itself. Without them the helper's
// terminal-state branch is never executed by any test — mutation testing caught
// exactly that gap.

test('commitIdempotently refuses to save over a COMMITTED claim', async () => {
  const { commitIdempotently } = await import('../app/lib/booking-idempotency')
  store.set('bk:idem:direct-committed', { value: 'committed:winner-token', expiresAt: null })
  store.set('bk:winner-token', { value: '{"token":"winner-token"}', expiresAt: null })

  let saved = false
  const out = await commitIdempotently('direct-committed', 'my-token', async () => { saved = true })

  assert.equal(saved, false, 'save() must never run against a committed key')
  assert.deepEqual(out, { ok: false, winnerToken: 'winner-token' })
  assert.equal(store.get('bk:idem:direct-committed')!.value, 'committed:winner-token', 'untouched')
})

test('commitIdempotently takes over a claim with no booking behind it', async () => {
  const { commitIdempotently } = await import('../app/lib/booking-idempotency')
  store.set('bk:idem:direct-stranded', { value: 'claimed:dead-token', expiresAt: null })
  // deliberately NO bk:dead-token — the claim is provably uncommitted

  let saved = false
  const out = await commitIdempotently('direct-stranded', 'my-token', async () => { saved = true })

  assert.equal(saved, true, 'the recovering request may persist')
  assert.deepEqual(out, { ok: true })
  assert.equal(store.get('bk:idem:direct-stranded')!.value, 'committed:my-token')
})

test('commitIdempotently defers to a claim whose booking DOES exist', async () => {
  const { commitIdempotently } = await import('../app/lib/booking-idempotency')
  store.set('bk:idem:direct-landed', { value: 'claimed:real-token', expiresAt: null })
  store.set('bk:real-token', { value: '{"token":"real-token"}', expiresAt: null })

  let saved = false
  const out = await commitIdempotently('direct-landed', 'my-token', async () => { saved = true })

  assert.equal(saved, false, 'a landed booking is never written over')
  assert.deepEqual(out, { ok: false, winnerToken: 'real-token' })
  assert.equal(store.get('bk:idem:direct-landed')!.value, 'committed:real-token', 'healed to terminal')
})

test('a COMMITTED claim is honoured even if its booking record is gone', async () => {
  // The committed STATE is authoritative on its own — not merely a hint backed up by
  // the record's existence. If a booking is later purged or expires, its key must
  // still not be taken over and re-created behind the customer's back. This is the
  // case that distinguishes the terminal-state check from the existence check.
  const { commitIdempotently } = await import('../app/lib/booking-idempotency')
  store.set('bk:idem:committed-gone', { value: 'committed:vanished-token', expiresAt: null })
  // deliberately NO bk:vanished-token

  let saved = false
  const out = await commitIdempotently('committed-gone', 'my-token', async () => { saved = true })

  assert.equal(saved, false, 'a committed key is never re-persisted, record present or not')
  assert.deepEqual(out, { ok: false, winnerToken: 'vanished-token' })
  assert.equal(store.get('bk:idem:committed-gone')!.value, 'committed:vanished-token', 'not overwritten')
})

test('commitIdempotently treats a legacy bare token as committed', async () => {
  const { commitIdempotently } = await import('../app/lib/booking-idempotency')
  store.set('bk:idem:legacy', { value: 'legacy-bare-token', expiresAt: null })
  store.set('bk:legacy-bare-token', { value: '{"token":"legacy-bare-token"}', expiresAt: null })

  let saved = false
  const out = await commitIdempotently('legacy', 'my-token', async () => { saved = true })

  assert.equal(saved, false, 'a #179-era record must not be re-created')
  assert.deepEqual(out, { ok: false, winnerToken: 'legacy-bare-token' })
})

// ── Everything that must survive ────────────────────────────────────────────

test('normal success commits and returns one booking', async () => {
  const { status, json } = await book(await payload({ idempotencyKey: 'normal' }))
  assert.equal(status, 200)
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  assert.equal(all[0].token, json.token)
})

test('save failure with a WORKING rollback still frees the key', async () => {
  breakSave = true
  await book(await payload({ idempotencyKey: 'rollback-ok' })).catch(() => ({}))
  assert.equal((await listBookings(50)).length, 0)
  assert.equal(claimOf('rollback-ok'), null, 'the claim was rolled back cleanly')

  breakSave = false
  const retry = await book(await payload({ idempotencyKey: 'rollback-ok' }))
  assert.equal(retry.status, 200)
  assert.equal((await listBookings(50)).length, 1)
})

test('concurrent same-key submissions still produce exactly one booking', async () => {
  const body = await payload({ idempotencyKey: 'concurrent-rec' })
  const res = await Promise.all([book(body), book(body), book(body), book(body), book(body)])
  const all = await listBookings(50)
  assert.equal(all.length, 1, `5 concurrent → 1 booking, got ${all.length}`)
  const tokens = new Set(res.map(r => String(r.json.token ?? '')).filter(Boolean))
  assert.ok(tokens.size <= 1)
})

test('a stranded claim cannot be recovered by TWO retries into two bookings', async () => {
  breakSave = true; breakEval = true
  await book(await payload({ idempotencyKey: 'double-recover' })).catch(() => ({}))
  breakSave = false; breakEval = false
  await advance(31_000)

  const body = await payload({ idempotencyKey: 'double-recover' })
  const res = await Promise.all([book(body), book(body), book(body)])
  const all = await listBookings(50)
  assert.equal(all.length, 1, `concurrent recovery must still yield ONE booking, got ${all.length}`)
  const tokens = new Set(res.map(r => String(r.json.token ?? '')).filter(Boolean))
  assert.ok(tokens.size <= 1, 'no caller sees a booking other than the one that exists')
})

test('different keys remain independent', async () => {
  await book(await payload({ idempotencyKey: 'ind-1' }))
  await book(await payload({ idempotencyKey: 'ind-2' }))
  assert.equal((await listBookings(50)).length, 2)
})

test('a crashed owner is still recoverable', async () => {
  const { acquireLock } = await import('../app/lib/kv-lock')
  const orphan = await acquireLock('bk:idem:lock:crash-rec', { ttlMs: 20_000 })
  assert.ok(orphan)
  await advance(60_000)
  const after = await book(await payload({ idempotencyKey: 'crash-rec' }))
  assert.equal(after.status, 200)
  assert.equal((await listBookings(50)).length, 1)
})

test('an eligible photo booking still produces exactly one AiJob', async () => {
  const body = await payload({ idempotencyKey: 'ai-rec' })
  await book(body); await book(body)
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  const b = (await getBookingByToken(all[0].token))!
  assert.equal(b.aiJob?.status, 'queued')
  assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1)
})

test('recovery from a stranded claim still yields exactly one AiJob', async () => {
  breakSave = true; breakEval = true
  await book(await payload({ idempotencyKey: 'ai-stranded' })).catch(() => ({}))
  breakSave = false; breakEval = false
  await advance(31_000)

  const retry = await book(await payload({ idempotencyKey: 'ai-stranded' }))
  assert.equal(retry.status, 200)
  const all = await listBookings(50)
  assert.equal(all.length, 1)
  const b = (await getBookingByToken(all[0].token))!
  assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1, 'one job, not two')
})
