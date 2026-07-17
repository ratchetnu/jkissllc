// Regression guard for the Book Now detail-page short-poll trigger. The detail page
// polls ONLY while an AI job is actively moving and must STOP at a terminal state —
// otherwise the page reloads forever. This locks the exact predicate that gates the
// poll so it can't silently regress into an endless refresh.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking, AiJob, AiJobStatus } from '../app/lib/bookings'
import { isActiveAiJob } from '../app/lib/book-now-queue'

const job = (status: AiJobStatus): AiJob => ({ status, idempotencyKey: 'k', photoVersion: 1, attempts: 0, updatedAt: 1 })
const b = (o: Partial<Pick<Booking, 'aiJob' | 'finalAiJob'>>): Pick<Booking, 'aiJob' | 'finalAiJob'> => o

test('polls while the initial AI job is moving (queued/processing/retrying)', () => {
  for (const s of ['queued', 'processing', 'retrying'] as AiJobStatus[]) {
    assert.equal(isActiveAiJob(b({ aiJob: job(s) })), true, s)
  }
})

test('polls while the FINAL AI job is moving', () => {
  for (const s of ['queued', 'processing', 'retrying'] as AiJobStatus[]) {
    assert.equal(isActiveAiJob(b({ finalAiJob: job(s) })), true, s)
  }
})

test('STOPS polling at every terminal state (this is the anti-endless-refresh guard)', () => {
  for (const s of ['not_started', 'completed', 'failed', 'manual_review'] as AiJobStatus[]) {
    assert.equal(isActiveAiJob(b({ aiJob: job(s), finalAiJob: job(s) })), false, s)
  }
})

test('does not poll when there is no AI job at all', () => {
  assert.equal(isActiveAiJob(b({})), false)
})

test('polls if EITHER job is active while the other is terminal', () => {
  assert.equal(isActiveAiJob(b({ aiJob: job('completed'), finalAiJob: job('processing') })), true)
  assert.equal(isActiveAiJob(b({ aiJob: job('queued'), finalAiJob: job('completed') })), true)
})
