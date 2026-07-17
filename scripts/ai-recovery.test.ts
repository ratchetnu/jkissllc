// AI job RELIABILITY overlay (Session 2): the provider-outage circuit breaker, the
// stuck-`queued` detector, and the fleet recovery summary. All pure + hermetic —
// injected time + config, no I/O, no Redis. (The thin Redis persistence in
// ai-recovery.ts is intentionally NOT exercised here; it is fail-soft glue.)
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking, AiJob } from '../app/lib/bookings'
import {
  closedBreaker, breakerAllows, inProbeWindow, recordOutcome, isOutageClass,
  isStuckQueued, summarizeRecovery, OUTAGE_CODES, type BreakerConfig,
} from '../app/lib/ai-recovery'

const CFG: BreakerConfig = { threshold: 3, cooldownMs: 1000 }
const T0 = 1_000_000

// ── Outage classification ────────────────────────────────────────────────────
test('isOutageClass: only provider_unavailable + rate_limited feed the breaker', () => {
  assert.equal(isOutageClass('provider_unavailable'), true)
  assert.equal(isOutageClass('rate_limited'), true)
  // The provider RESPONDED — these must not trip/hold the breaker:
  assert.equal(isOutageClass('invalid_schema'), false)
  assert.equal(isOutageClass('unsupported_image'), false)
  assert.equal(isOutageClass('image_access_failed'), false)
  assert.equal(isOutageClass('pricing_validation_failed'), false)
  assert.equal(isOutageClass(undefined), false)
  assert.deepEqual([...OUTAGE_CODES].sort(), ['provider_unavailable', 'rate_limited'])
})

// ── Circuit breaker state machine ────────────────────────────────────────────
test('breaker: consecutive outage failures trip it at the threshold', () => {
  let s = closedBreaker(T0)
  s = recordOutcome(s, true, T0 + 1, CFG); assert.equal(s.phase, 'closed'); assert.equal(s.failures, 1)
  s = recordOutcome(s, true, T0 + 2, CFG); assert.equal(s.phase, 'closed'); assert.equal(s.failures, 2)
  s = recordOutcome(s, true, T0 + 3, CFG); assert.equal(s.phase, 'open'); assert.equal(s.openedAt, T0 + 3)
})

test('breaker: any provider response (success or non-outage error) resets it', () => {
  let s = closedBreaker(T0)
  s = recordOutcome(s, true, T0 + 1, CFG); assert.equal(s.failures, 1)
  s = recordOutcome(s, true, T0 + 2, CFG); assert.equal(s.failures, 2)
  // A success (outage=false) folds in → fully reset, well short of the threshold.
  s = recordOutcome(s, false, T0 + 3, CFG)
  assert.equal(s.phase, 'closed'); assert.equal(s.failures, 0)
})

test('breaker: OPEN parks until the cooldown elapses, then allows exactly a probe', () => {
  let s = closedBreaker(T0)
  for (let i = 1; i <= 3; i++) s = recordOutcome(s, true, T0 + i, CFG)
  assert.equal(s.phase, 'open')
  const openedAt = s.openedAt!
  // Within cooldown → parked.
  assert.equal(breakerAllows(s, openedAt + 500, CFG), false)
  assert.equal(inProbeWindow(s, openedAt + 500, CFG), false)
  // Cooldown elapsed → a single probe is allowed (half-open window).
  assert.equal(breakerAllows(s, openedAt + 1000, CFG), true)
  assert.equal(inProbeWindow(s, openedAt + 1000, CFG), true)
})

test('breaker: a probe SUCCESS closes it; a probe FAILURE re-opens and restarts the cooldown', () => {
  let s = closedBreaker(T0)
  for (let i = 1; i <= 3; i++) s = recordOutcome(s, true, T0 + i, CFG)
  const openedAt = s.openedAt!
  // Probe fails → re-open, cooldown restarts from the probe time.
  const reopened = recordOutcome(s, true, openedAt + 1000, CFG)
  assert.equal(reopened.phase, 'open')
  assert.equal(reopened.openedAt, openedAt + 1000)
  assert.equal(breakerAllows(reopened, openedAt + 1500, CFG), false) // fresh cooldown
  // Probe succeeds → closed.
  const recovered = recordOutcome(s, false, openedAt + 1000, CFG)
  assert.equal(recovered.phase, 'closed'); assert.equal(recovered.failures, 0)
})

test('breaker: closed always allows; never parks a healthy fleet', () => {
  assert.equal(breakerAllows(closedBreaker(T0), T0, CFG), true)
  assert.equal(inProbeWindow(closedBreaker(T0), T0, CFG), false)
})

// ── Stuck-`queued` detector ──────────────────────────────────────────────────
const STUCK = 1000
function j(p: Partial<AiJob>): AiJob {
  return { status: 'queued', idempotencyKey: 'k', photoVersion: 1, attempts: 0, updatedAt: T0, ...p }
}

test('isStuckQueued: queued/retrying past the threshold is stuck; fresh or wrong-status is not', () => {
  assert.equal(isStuckQueued(j({ status: 'queued', nextRetryAt: T0 - 2000 }), T0, STUCK), true)
  assert.equal(isStuckQueued(j({ status: 'retrying', nextRetryAt: T0 - 2000 }), T0, STUCK), true)
  assert.equal(isStuckQueued(j({ status: 'queued', nextRetryAt: T0 - 500 }), T0, STUCK), false)
  // Wrong status — the base reaper owns processing; completed/failed are terminal.
  assert.equal(isStuckQueued(j({ status: 'processing', lastAttemptAt: T0 - 9999 }), T0, STUCK), false)
  assert.equal(isStuckQueued(j({ status: 'completed' }), T0, STUCK), false)
  assert.equal(isStuckQueued(j({ status: 'failed' }), T0, STUCK), false)
})

test('isStuckQueued: falls back to updatedAt when nextRetryAt is absent; never flags without a timestamp', () => {
  assert.equal(isStuckQueued(j({ status: 'queued', nextRetryAt: undefined, updatedAt: T0 - 2000 }), T0, STUCK), true)
  assert.equal(isStuckQueued(j({ status: 'queued', nextRetryAt: undefined, updatedAt: 0 }), T0, STUCK), false)
  assert.equal(isStuckQueued(undefined, T0, STUCK), false)
})

// ── Fleet recovery summary ───────────────────────────────────────────────────
function bk(token: string, p: Partial<Booking>): Booking {
  return {
    token, bookingNumber: `JK-${token}`, customerName: 'C', serviceType: 'junk-removal',
    items: [], invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
    availableDates: [], availableWindows: [], status: 'quote_received', payments: [],
    source: 'online', createdAt: T0, updatedAt: T0,
    invoicePhotos: [{ url: 'https://x/1.jpg' }], ...p,
  } as Booking
}

test('summarizeRecovery: counts stale-processing, stuck-queued, dead-letter, and manual_review across both jobs', () => {
  const LEASE = 5000
  const bookings: Booking[] = [
    bk('a', { aiJob: j({ status: 'processing', lastAttemptAt: T0 - 9999 }) }),          // stale processing
    bk('b', { aiJob: j({ status: 'queued', nextRetryAt: T0 - 9999 }) }),                // stuck queued
    bk('c', { aiJob: j({ status: 'failed' }) }),                                        // dead-letter
    bk('d', { aiJob: j({ status: 'manual_review' }) }),                                 // manual review
    bk('e', { aiJob: j({ status: 'processing', lastAttemptAt: T0 - 100 }) }),           // healthy in-flight
    bk('f', { aiJob: j({ status: 'completed' }) }),                                     // healthy done
    bk('g', { archived: true, aiJob: j({ status: 'failed' }) }),                        // excluded (archived)
    bk('h', { isTest: true, aiJob: j({ status: 'queued', nextRetryAt: T0 - 9999 }) }),  // excluded (test)
  ]
  const s = summarizeRecovery(bookings, { at: T0, leaseMs: LEASE, stuckMs: STUCK })
  assert.equal(s.staleProcessing, 1)
  assert.equal(s.stuckQueued, 1)
  assert.equal(s.deadLetter, 1)
  assert.equal(s.manualReview, 1)
  assert.equal(s.stranded, 2)                          // a + b
  assert.deepEqual(s.strandedTokens.sort(), ['a', 'b'])
  assert.equal(s.byStatus.processing, 2)               // a + e (archived/test excluded)
  assert.equal(s.byStatus.completed, 1)
})

test('summarizeRecovery: a booking stranded on BOTH its initial and final job is counted once', () => {
  const bookings: Booking[] = [
    bk('x', {
      aiJob: j({ status: 'processing', lastAttemptAt: T0 - 9999 }),
      finalAiJob: j({ status: 'queued', nextRetryAt: T0 - 9999 }),
    }),
  ]
  const s = summarizeRecovery(bookings, { at: T0, leaseMs: 5000, stuckMs: STUCK })
  assert.equal(s.staleProcessing, 1)
  assert.equal(s.stuckQueued, 1)
  assert.equal(s.stranded, 1)                          // deduped by token
  assert.deepEqual(s.strandedTokens, ['x'])
})
