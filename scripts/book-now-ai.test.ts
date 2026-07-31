// Durable Book Now AI processing engine: eligibility, idempotent enqueue, error
// classification, and the bounded-retry/backoff policy — all pure + hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import {
  needsAiJob, supportsPhotoAi, hasValidEstimate, photoVersion, aiJobIdempotencyKey,
  enqueueAiJob, classifyOutcome, retryDecision, isDue, needsManualReview, invalidatePhotoAnalysis, MAX_ATTEMPTS,
} from '../app/lib/book-now-ai'
import { photoSetFingerprint, samePhotoSet } from '../app/lib/ai/photo-set'

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

test('same-count photo replacement is a new AI job; reordering is not', () => {
  const b = mk({ invoicePhotos: [{ url: 'https://x/a.jpg' }, { url: 'https://x/b.jpg' }] })
  assert.equal(enqueueAiJob(b), true)
  const firstKey = b.aiJob!.idempotencyKey
  const firstFingerprint = b.aiJob!.photoFingerprint

  b.invoicePhotos = [{ url: 'https://x/b.jpg' }, { url: 'https://x/a.jpg' }]
  assert.equal(photoSetFingerprint(b.invoicePhotos), firstFingerprint)
  assert.equal(enqueueAiJob(b), false, 'order alone is the same set')

  b.invoicePhotos = [{ url: 'https://x/a.jpg' }, { url: 'https://x/c.jpg' }]
  assert.equal(photoVersion(b), 2, 'the count did not change')
  assert.equal(enqueueAiJob(b), true, 'but the source evidence did')
  assert.notEqual(b.aiJob!.idempotencyKey, firstKey)
  assert.notEqual(b.aiJob!.photoFingerprint, firstFingerprint)
})

test('an estimate is valid only for the source-photo set it analyzed', () => {
  const b = mk({
    invoicePhotos: [{ url: 'https://x/a.jpg' }],
    aiEstimate: {
      status: 'completed',
      pricing: { lowUsd: 1 },
      inputPhotoUrls: ['https://x/a.jpg'],
    } as Booking['aiEstimate'],
  })
  assert.equal(hasValidEstimate(b), true)
  b.invoicePhotos = [{ url: 'https://x/b.jpg' }]
  assert.equal(hasValidEstimate(b), false)
})

test('photo invalidation preserves history, retires final state, and queues current evidence', () => {
  const b = mk({
    invoicePhotos: [{ url: 'https://x/new.jpg' }],
    aiEstimate: {
      status: 'completed', pricing: { lowUsd: 1 }, inputPhotoUrls: ['https://x/old.jpg'],
    } as Booking['aiEstimate'],
    finalAiEstimate: { confirmationVersion: 1 } as Booking['finalAiEstimate'],
    confirmation: { confirmationVersion: 1 } as Booking['confirmation'],
    finalAiJob: { status: 'completed', idempotencyKey: 'old', photoVersion: 1, attempts: 1, updatedAt: 1 },
  })
  assert.equal(invalidatePhotoAnalysis(b, 'owner', '2026-07-30T00:00:00.000Z'), true)
  assert.equal(b.aiEstimate?.invalidatedAt, '2026-07-30T00:00:00.000Z')
  assert.equal(b.finalAiEstimate?.invalidatedAt, '2026-07-30T00:00:00.000Z')
  assert.equal(b.confirmation?.invalidatedAt, '2026-07-30T00:00:00.000Z')
  assert.equal(b.finalAiJob, undefined)
  assert.equal(b.aiJob?.status, 'queued')
  assert.equal(b.aiJob?.photoFingerprint, photoSetFingerprint(b.invoicePhotos))
  assert.ok(b.events?.some(event => event.action === 'ai.invalidated'))
})

test('photo-set identity is order-insensitive but URL-sensitive', () => {
  assert.equal(samePhotoSet(['https://x/a', 'https://x/b'], ['https://x/b', 'https://x/a']), true)
  assert.equal(samePhotoSet(['https://x/a', 'https://x/b'], ['https://x/a', 'https://x/c']), false)
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

test('a model-ran-but-empty read routes to manual review, not endless retries', () => {
  assert.equal(needsManualReview('no_items'), true)     // AI saw the photos, found nothing to price
  assert.equal(needsManualReview('provider_error'), false)
  assert.equal(needsManualReview('rate_limited'), false)
  assert.equal(needsManualReview(undefined), false)
})

test('isDue: queued/retrying past backoff are due; processing/completed/test are not', () => {
  const at = 1000
  assert.equal(isDue(mk({ aiJob: { status: 'queued', idempotencyKey: 'k', photoVersion: 3, attempts: 0, nextRetryAt: 500, updatedAt: 1 } }), at), true)
  assert.equal(isDue(mk({ aiJob: { status: 'retrying', idempotencyKey: 'k', photoVersion: 3, attempts: 1, nextRetryAt: 2000, updatedAt: 1 } }), at), false) // backoff not elapsed
  assert.equal(isDue(mk({ aiJob: { status: 'processing', idempotencyKey: 'k', photoVersion: 3, attempts: 1, updatedAt: 1 } }), at), false)
  assert.equal(isDue(mk({ isTest: true, aiJob: { status: 'queued', idempotencyKey: 'k', photoVersion: 3, attempts: 0, nextRetryAt: 0, updatedAt: 1 } }), at), false)
})
