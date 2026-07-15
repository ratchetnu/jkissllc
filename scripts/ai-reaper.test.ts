// Stale-`processing` recovery (Phase 3): a crash/timeout DURING the model call
// strands a durable AI job in 'processing' forever, because the normal due-check
// only re-picks queued/retrying. These tests cover the pure, hermetic reaper logic:
// the stale predicate, the requeue-vs-terminal decision, idempotency, MAX_ATTEMPTS,
// terminal-state protection, and tenant preservation — no I/O, injected timestamps.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking, AiJob } from '../app/lib/bookings'
import {
  isDue, isStaleProcessing, recoverStaleJob, processingLeaseMs, MAX_ATTEMPTS,
} from '../app/lib/book-now-ai'
import { isFinalDue, MAX_FINAL_ATTEMPTS } from '../app/lib/book-now-confirmation'

const LEASE = processingLeaseMs()          // env default (5 min) unless overridden
const AT = 10_000_000                       // fixed "now" for determinism
const KEY = 'book-now-ai:jkiss:tok:3'       // idempotencyKey embeds the tenantId

function job(p: Partial<AiJob>): AiJob {
  return { status: 'processing', idempotencyKey: KEY, photoVersion: 3, attempts: 1, updatedAt: 1, ...p }
}
function mk(p: Partial<Booking>): Booking {
  return {
    token: 'tok', bookingNumber: 'JK-B-1', customerName: 'C', serviceType: 'junk-removal',
    items: [], invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
    availableDates: [], availableWindows: [], status: 'quote_received', payments: [],
    source: 'online', createdAt: 1, updatedAt: 1,
    invoicePhotos: [{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }, { url: 'https://x/3.jpg' }], ...p,
  } as Booking
}

// A processing job that entered processing `age` ms before AT.
const processingAgo = (age: number, over: Partial<AiJob> = {}) =>
  job({ status: 'processing', lastAttemptAt: AT - age, ...over })

test('lease is safely larger than the 60s function maxDuration (never reaps a healthy in-flight job)', () => {
  assert.ok(LEASE > 60_000, `lease ${LEASE}ms must be >> 60s`)
})

test('isStaleProcessing: fresh processing is NOT stale; a job past the lease IS', () => {
  assert.equal(isStaleProcessing(processingAgo(1_000), AT), false)            // just started
  assert.equal(isStaleProcessing(processingAgo(LEASE - 1), AT), false)        // inside the lease
  assert.equal(isStaleProcessing(processingAgo(LEASE + 1), AT), true)         // past the lease
  assert.equal(isStaleProcessing(job({ status: 'processing', lastAttemptAt: undefined }), AT), false) // no ts → fail-safe
  assert.equal(isStaleProcessing(job({ status: 'queued', lastAttemptAt: 0 }), AT), false)             // not processing
  assert.equal(isStaleProcessing(undefined, AT), false)
})

test('isDue: a fresh processing job is NOT due; a stale processing job IS due', () => {
  assert.equal(isDue(mk({ aiJob: processingAgo(1_000) }), AT), false)
  assert.equal(isDue(mk({ aiJob: processingAgo(LEASE + 1) }), AT), true)
  // archived / test still excluded even when stale.
  assert.equal(isDue(mk({ archived: true, aiJob: processingAgo(LEASE + 1) }), AT), false)
  assert.equal(isDue(mk({ isTest: true, aiJob: processingAgo(LEASE + 1) }), AT), false)
})

test('recovery re-arms a stale job to retrying WITHOUT resetting attempts, due immediately', () => {
  const r = recoverStaleJob(processingAgo(LEASE + 1, { attempts: 2 }), AT)
  assert.ok(r)
  assert.equal(r!.status, 'retrying')
  assert.equal(r!.attempts, 2)                        // stale attempt COUNTS — never reset to 0
  assert.equal(r!.nextRetryAt, AT)                    // due now → normal path runs it once more
  assert.equal(r!.idempotencyKey, KEY)                // tenant/idempotency preserved
})

test('recovery is IDEMPOTENT: a second reaper pass within the lease does not re-pick the requeued job', () => {
  const stale = processingAgo(LEASE + 1, { attempts: 2 })
  const first = recoverStaleJob(stale, AT)
  assert.equal(first!.status, 'retrying')
  // The requeued job is no longer 'processing', so the stale path can never touch it again.
  assert.equal(isStaleProcessing(first!, AT), false)
  assert.equal(recoverStaleJob(first ?? undefined, AT), null)  // exactly-once: second pass is a no-op
})

test('MAX_ATTEMPTS respected: a stale job that already burned all attempts goes TERMINAL, not requeued', () => {
  const exhausted = recoverStaleJob(processingAgo(LEASE + 1, { attempts: MAX_ATTEMPTS }), AT)
  assert.ok(exhausted)
  assert.equal(exhausted!.status, 'manual_review')    // terminal owner state — no more model calls
  assert.equal(exhausted!.attempts, MAX_ATTEMPTS)     // not reset
  assert.ok(exhausted!.completedAt)
  // One attempt below the cap still re-arms for a final try.
  const belowCap = recoverStaleJob(processingAgo(LEASE + 1, { attempts: MAX_ATTEMPTS - 1 }), AT)
  assert.equal(belowCap!.status, 'retrying')
})

test('a terminal failed / manual_review / completed job is NEVER resurrected', () => {
  for (const status of ['failed', 'manual_review', 'completed'] as const) {
    // Even with an ancient lastAttemptAt, a non-processing status is not a stale candidate.
    assert.equal(isStaleProcessing(job({ status, lastAttemptAt: 0 }), AT), false)
    assert.equal(recoverStaleJob(job({ status, lastAttemptAt: 0 }), AT), null)
    assert.equal(isDue(mk({ aiJob: job({ status, lastAttemptAt: 0 }) }), AT), false)
  }
})

test('concurrent double-run does not double-process: the recovered job is no longer a stale candidate', () => {
  // The runtime write-lease (withBookingWriteLock in processAiJob) serializes two crons;
  // the pure guarantee is that once recovered, the stale path yields nothing, so the
  // cron that loses the lease finds no stale job to re-recover.
  const stale = processingAgo(LEASE + 1, { attempts: 1 })
  const recovered = recoverStaleJob(stale, AT)!
  assert.equal(isStaleProcessing(recovered, AT), false)
  assert.equal(recoverStaleJob(recovered, AT), null)
})

test('recovery preserves tenant context (idempotencyKey carries the tenantId unchanged)', () => {
  const r = recoverStaleJob(processingAgo(LEASE + 1, { idempotencyKey: 'book-now-ai:supercharged:t:2', attempts: 1 }), AT)
  assert.equal(r!.idempotencyKey, 'book-now-ai:supercharged:t:2')
})

// ── Final-analysis job (book-now-confirmation.ts) mirrors the same recovery ──
function finalMk(fj: Partial<AiJob>): Booking {
  return mk({
    finalAiJob: job({ status: 'processing', ...fj }),
    confirmation: { confirmationVersion: 1, items: [], conflicts: [] } as unknown as Booking['confirmation'],
  })
}

test('isFinalDue: fresh final-processing NOT due; stale final-processing IS due', () => {
  assert.equal(isFinalDue(finalMk({ lastAttemptAt: AT - 1_000 }), AT), false)
  assert.equal(isFinalDue(finalMk({ lastAttemptAt: AT - (LEASE + 1) }), AT), true)
  // Without a confirmation the final job is never due, stale or not.
  assert.equal(isFinalDue(mk({ finalAiJob: processingAgo(LEASE + 1) }), AT), false)
})

test('final recovery honors MAX_FINAL_ATTEMPTS (terminal at the cap, retry below it)', () => {
  const atCap = recoverStaleJob(processingAgo(LEASE + 1, { attempts: MAX_FINAL_ATTEMPTS }), AT, LEASE, MAX_FINAL_ATTEMPTS)
  assert.equal(atCap!.status, 'manual_review')
  const belowCap = recoverStaleJob(processingAgo(LEASE + 1, { attempts: MAX_FINAL_ATTEMPTS - 1 }), AT, LEASE, MAX_FINAL_ATTEMPTS)
  assert.equal(belowCap!.status, 'retrying')
})
