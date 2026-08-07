// Issue #173 — POST /api/book must enqueue the durable photo AI job.
//
// /api/book is the "lock my date now" TERMINAL intake on the /quote wizard's review
// step — the sibling of "Request My Quote" (→ persistQuoteRequest, which DOES
// enqueue). Nothing downstream backfills it: record-payment and the Stripe webhook
// never touch aiJob, and runDueAiJobs selects on isDue(), which returns false for a
// booking that carries no aiJob at all. So a photo-bearing junk booking reserved
// through this route used to strand with an empty AI panel forever.
//
// These drive the REAL route handler over an in-memory Upstash — no network, no
// model call, no Stripe. Eligibility itself lives in needsAiJob/supportsPhotoAi and
// is covered by book-now-ai.test.ts + photo-ai-moving-gate.test.ts; what is proven
// here is that /api/book HONORS it — including PR #172's AI_PHOTO_ESTIMATE_MOVING
// gate, which until now only ever reached the /api/quote path.
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

process.env.KV_REST_API_URL = 'http://book-route-kv.local'
process.env.KV_REST_API_TOKEN = 'test-token'
// No Stripe → the route skips checkout and returns the plain bookingUrl.
delete process.env.STRIPE_SECRET_KEY
delete process.env.RESEND_API_KEY
delete process.env.OWNER_SMS

const KV = 'http://book-route-kv.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  // Any non-KV call (email/SMS providers) succeeds silently; none is asserted on.
  if (String(url) !== KV) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const [rawCmd, ...args] = JSON.parse(String(init?.body)) as string[]
  const key = args[0]
  let result: unknown = null
  switch (rawCmd.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': {
      const nx = args.some(a => String(a).toUpperCase() === 'NX')
      if (nx && kv.has(key)) result = null
      else { kv.set(key, args[1]); result = 'OK' }
      break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(key).delete(args[1]) ? 1 : 0; break
    case 'ZSCORE': result = z(key).get(args[1]) ?? null; break
    case 'ZRANGE': case 'ZRANGEBYSCORE': {
      result = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m)
      break
    }
    case 'ZREVRANGE': {
      const start = Number(args[1]); const stop = Number(args[2])
      result = [...z(key).entries()].sort((a, b) => b[1] - a[1]).slice(start, stop < 0 ? undefined : stop + 1).map(([m]) => m)
      break
    }
    case 'ZCARD': result = z(key).size; break
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${rawCmd}`)
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

import { POST } from '../app/api/book/route'
import { getBookingByToken, listBookings } from '../app/lib/bookings'
import { getAvailability } from '../app/lib/availability'
import { needsAiJob, aiJobIdempotencyKey, isDue } from '../app/lib/book-now-ai'
import { persistQuoteRequest } from '../app/lib/booking-requests'
import { NextRequest } from 'next/server'

const PHOTOS = [
  'https://book-route.public.blob.vercel-storage.com/a.jpg',
  'https://book-route.public.blob.vercel-storage.com/b.jpg',
]

// The route rejects any date the real availability logic does not offer, so take a
// genuinely open one instead of hardcoding a date that rots.
async function openDate(): Promise<string> {
  const { dates } = await getAvailability(120, 1)
  assert.ok(dates.length > 0, 'availability must offer at least one bookable date')
  return dates[0]
}

type BookBody = Record<string, unknown>
async function book(body: BookBody) {
  const req = new NextRequest('http://localhost/api/book', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await POST(req, undefined)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

let keySeq = 0
async function submit(over: BookBody = {}) {
  return book({
    name: 'Ada Lovelace', email: 'ada@example.com', phone: '555-0100',
    service: 'junk-removal', loadSize: 'half', date: await openDate(), window: '8am–10am',
    photos: PHOTOS, paymentMethod: 'stripe', idempotencyKey: `bk-test-${++keySeq}`,
    ...over,
  })
}

// PR #172's eligibility flag, restored exactly — these tests must not leak it.
async function withMovingFlag(fn: () => Promise<void>) {
  const prev = process.env.AI_PHOTO_ESTIMATE_MOVING
  process.env.AI_PHOTO_ESTIMATE_MOVING = '1'
  try { await fn() } finally {
    if (prev === undefined) delete process.env.AI_PHOTO_ESTIMATE_MOVING
    else process.env.AI_PHOTO_ESTIMATE_MOVING = prev
  }
}

beforeEach(() => { kv.clear(); zsets.clear() })

test('junk booking with photos enqueues exactly one queued AI job', async () => {
  const { status, json } = await submit()
  assert.equal(status, 200, JSON.stringify(json))

  const b = await getBookingByToken(String(json.token))
  assert.ok(b, 'booking persisted')
  assert.equal(b!.serviceType, 'junk-removal')
  assert.equal(b!.invoicePhotos?.length, 2)

  assert.ok(b!.aiJob, 'issue #173: the booking must carry a durable aiJob')
  assert.equal(b!.aiJob!.status, 'queued')
  assert.equal(b!.aiJob!.photoVersion, 2)
  assert.equal(b!.aiJob!.initiatedBy, 'system')
  assert.equal(b!.aiJob!.attempts, 0)

  // Exactly one — not one per photo, and not one per save path.
  const queued = (b!.events ?? []).filter(e => e.action === 'ai.queued')
  assert.equal(queued.length, 1, 'exactly one ai.queued event')

  // No pricing and no scheduling side effects were invented by the enqueue.
  assert.equal(b!.invoiceAmountCents, 0)
  assert.equal(b!.aiEstimate, undefined)
})

test('the enqueued job is actually pickable by the cron worker', async () => {
  // The whole defect was a booking the worker could never see: isDue() requires an
  // aiJob, so "no aiJob" meant "invisible forever".
  const { json } = await submit()
  const b = (await getBookingByToken(String(json.token)))!
  assert.equal(isDue(b), true, 'a freshly booked job is due immediately')
  assert.equal(needsAiJob(b), true)
})

test('estate-cleanout (junk family) also enqueues', async () => {
  const { json } = await submit({ service: 'estate-cleanout' })
  const b = (await getBookingByToken(String(json.token)))!
  assert.equal(b.serviceType, 'estate-cleanout')
  assert.equal(b.aiJob?.status, 'queued')
})

test('a booking with no photos gets no AI job', async () => {
  const { status, json } = await submit({ photos: [] })
  assert.equal(status, 200)
  const b = (await getBookingByToken(String(json.token)))!
  assert.equal(b.invoicePhotos?.length ?? 0, 0)
  assert.equal(b.aiJob, undefined, 'nothing to analyze → no job')
  assert.equal((b.events ?? []).some(e => e.action === 'ai.queued'), false)
})

test('a moving booking gets no AI job while AI_PHOTO_ESTIMATE_MOVING is off', async () => {
  // The production default (PR #172). The route must inherit the eligibility gate
  // rather than carry its own opinion about which families are analyzable.
  assert.equal(process.env.AI_PHOTO_ESTIMATE_MOVING, undefined, 'the flag defaults off')
  const { json } = await submit({ service: 'moving' })
  const b = (await getBookingByToken(String(json.token)))!
  assert.equal(b.serviceType, 'moving')
  assert.equal(b.aiJob, undefined)
  assert.equal((b.events ?? []).some(e => e.action === 'ai.queued'), false)
})

test('a moving booking DOES enqueue once AI_PHOTO_ESTIMATE_MOVING is on', async () => {
  await withMovingFlag(async () => {
    const { json } = await submit({ service: 'moving' })
    const b = (await getBookingByToken(String(json.token)))!
    assert.equal(b.serviceType, 'moving')
    assert.equal(b.aiJob?.status, 'queued', 'the flag reaches /api/book, not just /api/quote')
    assert.equal(b.aiJob?.photoVersion, 2)
    assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1)
  })
})

test('appliance-delivery (moving family) follows the same flag', async () => {
  const off = await submit({ service: 'appliance-delivery' })
  assert.equal((await getBookingByToken(String(off.json.token)))!.aiJob, undefined)
  await withMovingFlag(async () => {
    const on = await submit({ service: 'appliance-delivery' })
    assert.equal((await getBookingByToken(String(on.json.token)))!.aiJob?.status, 'queued')
  })
})

test('"other" stays ineligible even with the moving flag on', async () => {
  await withMovingFlag(async () => {
    const { json } = await submit({ service: 'other' })
    const b = (await getBookingByToken(String(json.token)))!
    assert.equal(b.serviceType, 'other')
    assert.equal(b.aiJob, undefined, 'the moving flag must not widen "other"')
  })
})

test('an unknown service falls back to "other" and gets no AI job', async () => {
  const { json } = await submit({ service: 'not-a-real-service' })
  const b = (await getBookingByToken(String(json.token)))!
  assert.equal(b.serviceType, 'other', 'unchanged fallback behavior')
  assert.equal(b.aiJob, undefined)
})

test('a missing service falls back to "other" and gets no AI job', async () => {
  const { json } = await submit({ service: undefined })
  const b = (await getBookingByToken(String(json.token)))!
  assert.equal(b.serviceType, 'other')
  assert.equal(b.aiJob, undefined)
})

test('replaying the same idempotencyKey returns the original booking and one job', async () => {
  const date = await openDate()
  const body: BookBody = {
    name: 'Ada Lovelace', email: 'ada@example.com', service: 'junk-removal',
    loadSize: 'half', date, window: '8am–10am', photos: PHOTOS,
    paymentMethod: 'stripe', idempotencyKey: 'bk-test-replay',
  }
  const first = await book(body)
  const replay = await book(body)

  assert.equal(replay.json.duplicate, true, 'the replay short-circuits')
  assert.equal(replay.json.token, first.json.token, 'same booking, not a new one')

  const all = await listBookings(50)
  assert.equal(all.length, 1, 'no duplicate booking')

  const b = (await getBookingByToken(String(first.json.token)))!
  assert.equal((b.events ?? []).filter(e => e.action === 'ai.queued').length, 1, 'no duplicate job')
})

test('the enqueue is upstream of the Stripe/Zelle branch split', async () => {
  // The Zelle branch's only difference is WHICH saveBooking runs — it seals a proof
  // through Vercel Blob, so its 200 path is not hermetically reachable here. What
  // makes both branches correct is that the enqueue happens BEFORE the split, which
  // the event ordering proves: ai.queued lands immediately after booking.created and
  // before any payment-method event, so whichever branch saves, the job is attached.
  const { json } = await submit()
  const actions = ((await getBookingByToken(String(json.token)))!.events ?? []).map(e => e.action)
  assert.deepEqual(actions.slice(0, 2), ['booking.created', 'ai.queued'])
  assert.equal(actions.filter(a => a === 'ai.queued').length, 1)
})

test('an invalid Zelle proof still creates no booking at all', async () => {
  // Unchanged guard: proof is validated BEFORE anything is persisted, so the added
  // enqueue never leaks a booking (or a job) out of a rejected reservation.
  const { status } = await submit({ paymentMethod: 'zelle', proofImage: 'data:image/png;base64,notreallyanimage' })
  assert.equal(status, 400)
  assert.equal((await listBookings(50)).length, 0, 'no booking, therefore no AI job')
})

test('/api/book and persistQuoteRequest cannot collide on one AI job', async () => {
  // The two intake paths mint SEPARATE bookings with separate tokens, and the
  // idempotency key is namespaced by token — so even a customer who somehow drove
  // both never produces two jobs for one booking.
  const { json } = await submit()
  const booked = (await getBookingByToken(String(json.token)))!
  const quoted = (await persistQuoteRequest({
    name: 'Ada Lovelace', serviceType: 'junk-removal', photos: PHOTOS,
    idempotencyKey: 'bk-test-quote-side',
  }))!

  assert.notEqual(booked.token, quoted.token)
  assert.notEqual(
    aiJobIdempotencyKey(booked, 'jkiss'),
    aiJobIdempotencyKey(quoted, 'jkiss'),
    'identical photos on different bookings are still distinct jobs',
  )
  assert.equal(booked.aiJob?.status, 'queued')
  assert.equal(quoted.aiJob?.status, 'queued')
})

test('an enqueue failure never costs the customer their reservation', async () => {
  // Blow up INSIDE enqueueAiJob for real: its idempotency key runs through
  // photoSetFingerprint, whose FNV hash is the only Math.imul caller on this route.
  // Arming that once puts a genuine throw in the enqueue path — nowhere else — and
  // proves the route still returns a real, persisted, fully-formed booking.
  const realImul = Math.imul
  let armed = true
  Math.imul = ((a: number, b: number) => {
    if (armed) { armed = false; throw new Error('enqueue exploded') }
    return realImul(a, b)
  }) as typeof Math.imul

  let res: Awaited<ReturnType<typeof submit>>
  try { res = await submit() } finally { Math.imul = realImul }

  assert.equal(armed, false, 'the failure was actually injected')
  assert.equal(res.status, 200, 'the reservation still succeeds')
  const b = (await getBookingByToken(String(res.json.token)))!
  assert.equal(b.status, 'booking_created')
  assert.ok(b.bookingNumber.startsWith('JK-B-'))
  assert.equal(b.selectedDate, b.availableDates[0])
  assert.equal(b.invoicePhotos?.length, 2, 'the photos are still there to re-analyze')

  // The failure is visible to the owner, whose "Re-run analysis" control reads the
  // audit trail — it is not swallowed into a log nobody reads.
  const failed = (b.events ?? []).find(e => e.action === 'ai.failed' && e.result === 'enqueue_failed')
  assert.ok(failed, 'the enqueue failure is recorded on the booking')
  assert.equal(failed!.meta?.recoverable, true)
})
