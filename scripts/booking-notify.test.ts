// Owner-notification reliability: provider failures are no longer silent, test
// records are suppressed, and the ledger records provider id + dedups by kind.
import assert from 'node:assert/strict'
import test from 'node:test'

// Guarantee no real send can occur in this test.
delete process.env.RESEND_API_KEY

import { emailRaw } from '../app/lib/booking-emails'
import { notifyOwnerNewSubmission } from '../app/lib/booking-notify'
import { recordNotificationAttempt, lastNotification, type Booking } from '../app/lib/bookings'

test('emailRaw returns a FAILURE result when the provider is not configured (non-silent)', async () => {
  const r = await emailRaw({ to: ['owner@example.com'], subject: 's', html: 'h' })
  assert.equal(r.ok, false)          // was previously a silent success
  assert.match(r.error ?? '', /RESEND_API_KEY|not configured/i)
})

test('notifyOwnerNewSubmission suppresses sandbox test records (no send, no throw)', async () => {
  const r = await notifyOwnerNewSubmission({ isTest: true } as Booking)
  assert.deepEqual(r, { sent: false, deduped: false })
})

test('notification ledger records provider id + status and dedups by kind', () => {
  const b = { notifications: [] } as unknown as Booking
  recordNotificationAttempt(b, { kind: 'new_submission', channel: 'email', to: 'o@x.com', status: 'sent', providerId: 'msg_1', retryCount: 0 })
  const last = lastNotification(b, 'new_submission')
  assert.equal(last?.status, 'sent')
  assert.equal(last?.providerId, 'msg_1')
  assert.equal(last?.retryCount, 0)
  // an unrelated kind is independent (dedup is per-kind)
  assert.equal(lastNotification(b, 'zelle_review'), undefined)
})

test('a failed attempt is recorded with its error + incremented retry, not dropped', () => {
  const b = { notifications: [] } as unknown as Booking
  recordNotificationAttempt(b, { kind: 'new_submission', channel: 'email', to: 'o@x.com', status: 'failed', error: 'domain not verified', retryCount: 0 })
  recordNotificationAttempt(b, { kind: 'new_submission', channel: 'email', to: 'o@x.com', status: 'failed', error: 'domain not verified', retryCount: 1 })
  const last = lastNotification(b, 'new_submission')
  assert.equal(last?.status, 'failed')
  assert.equal(last?.error, 'domain not verified')
  assert.equal(last?.retryCount, 1)
})
