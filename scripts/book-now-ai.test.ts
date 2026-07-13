// Durable Book Now AI processing engine: eligibility, idempotent enqueue, error
// classification, and the bounded-retry/backoff policy — all pure + hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import {
  needsAiJob, supportsPhotoAi, hasValidEstimate, photoVersion, aiJobIdempotencyKey,
  enqueueAiJob, classifyOutcome, retryDecision, isDue, MAX_ATTEMPTS,
} from '../app/lib/book-now-ai'

function mk(p: Partial<Booking>): Booking {
  return {
    token: p.token ?? 'tok', bookingNumber: 'JK-B-1', customerName: 'C',
    serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
    amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
    payments: [], source: 'online', createdAt: 1, updatedAt: 1,
    invoicePhotos: [{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }, { url: 'https://x/3.jpg' }], ...p,
  } as Booking
}

test('needsAiJob: junk + photos + no estimate = yes; moving / no-photos / test / archived = no', () => {
  assert.equal(needsAiJob(mk({})), true)
  assert.equal(needsAiJob(mk({ serviceType: 'moving' })), false)          // not photo-estimated
  assert.equal(needsAiJob(mk({ invoicePhotos: [] })), false)              // no photos
  assert.equal(needsAiJob(mk({ isTest: true })), false)
  assert.equal(needsAiJob(mk({ archived: true })), false)
  assert.equal(needsAiJob(mk({ source: 'admin' })), false)               // not a Book Now
})

test('a valid estimate makes it ineligible; a FAILED estimate shell still needs a job', () => {
  assert.equal(hasValidEstimate(mk({ aiEstimate: { status: 'completed', pricing: { lowUsd: 1 } } as Booking['aiEstimate'] })), true)
  assert.equal(needsAiJob(mk({ aiEstimate: { status: 'completed', pricing: { lowUsd: 1 } } as Booking['aiEstimate'] })), false)
  assert.equal(needsAiJob(mk({ aiEstimate: { status: 'failed', pricing: { lowUsd: 1 } } as Booking['aiEstimate'] })), true)
  assert.equal(supportsPhotoAi(mk({ serviceType: 'estate-cleanout' })), true)
  assert.equal(supportsPhotoAi(mk({ serviceType: 'freight' })), false)
})

test('enqueue is idempotent per booking + photo set, and re-triggers when photos change', () => {
  const b = mk({})
  assert.equal(enqueueAiJob(b, { initiatedBy: 'system' }), true)
  assert.equal(b.aiJob?.status, 'queued')
  const key = aiJobIdempotencyKey(b, 'default')
  assert.equal(b.aiJob?.idempotencyKey, key)
  // Second identical trigger = no-op (no duplicate job).
  assert.equal(enqueueAiJob(b, { initiatedBy: 'system' }), false)
  // A changed photo set = new version = new key = re-enqueue.
  b.invoicePhotos = [{ url: 'https://x/1.jpg' }]
  assert.equal(photoVersion(b), 1)
  assert.equal(enqueueAiJob(b, { initiatedBy: 'system' }), true)
  assert.notEqual(b.aiJob?.idempotencyKey, key)
})

test('force enqueue overrides an existing completed/failed job (owner retry)', () => {
  const b = mk({ aiJob: { status: 'failed', idempotencyKey: 'book-now-ai:default:tok:3', photoVersion: 3, attempts: 5, errorCode: 'retry_exhausted', updatedAt: 1 } })
  assert.equal(enqueueAiJob(b, { force: true, initiatedBy: 'owner' }), true)
  assert.equal(b.aiJob?.status, 'queued')
})

test('outcome → safe error category', () => {
  assert.equal(classifyOutcome('rate_limited', false), 'rate_limited')
  assert.equal(classifyOutcome('provider_error', false), 'provider_unavailable')
  assert.equal(classifyOutcome('budget_exceeded', false), 'provider_unavailable')
  assert.equal(classifyOutcome('image_fetch_failed', false), 'image_access_failed')
  assert.equal(classifyOutcome('schema_invalid', false), 'invalid_schema')
  assert.equal(classifyOutcome('no_photos', false), 'unsupported_image')
  assert.equal(classifyOutcome('anything', true), 'unknown')          // analyzedOk → not an error
})

test('retry policy: transient backs off then exhausts; permanent fails immediately', () => {
  const t1 = retryDecision(1, 'provider_unavailable')
  assert.equal(t1.terminal, false)
  assert.ok((t1.delayMs ?? 0) > 0)
  const t2 = retryDecision(2, 'provider_unavailable')
  assert.ok((t2.delayMs ?? 0) > (t1.delayMs ?? 0))                    // exponential-ish growth
  const exhausted = retryDecision(MAX_ATTEMPTS, 'rate_limited')
  assert.equal(exhausted.terminal, true)
  assert.equal(exhausted.finalCode, 'retry_exhausted')
  const permanent = retryDecision(1, 'unsupported_image')
  assert.equal(permanent.terminal, true)
  assert.equal(permanent.finalCode, 'unsupported_image')             // not retried
})

test('isDue: queued/retrying past backoff are due; processing/completed/test are not', () => {
  const at = 1000
  assert.equal(isDue(mk({ aiJob: { status: 'queued', idempotencyKey: 'k', photoVersion: 3, attempts: 0, nextRetryAt: 500, updatedAt: 1 } }), at), true)
  assert.equal(isDue(mk({ aiJob: { status: 'retrying', idempotencyKey: 'k', photoVersion: 3, attempts: 1, nextRetryAt: 2000, updatedAt: 1 } }), at), false) // backoff not elapsed
  assert.equal(isDue(mk({ aiJob: { status: 'processing', idempotencyKey: 'k', photoVersion: 3, attempts: 1, updatedAt: 1 } }), at), false)
  assert.equal(isDue(mk({ isTest: true, aiJob: { status: 'queued', idempotencyKey: 'k', photoVersion: 3, attempts: 0, nextRetryAt: 0, updatedAt: 1 } }), at), false)
})
