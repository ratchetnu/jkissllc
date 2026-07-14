// Delivery-status webhook: idempotent status merge, safe error classification, PII
// masking, and the auth boundary (missing/invalid signature, fail-closed). The merge
// is pure; the route is exercised only for auth (returns before Redis).
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import {
  mergeDeliveryStatus, classifyTwilioError, maskPhone, isTerminalFailure,
  type SmsStatusRecord,
} from '../app/lib/sms-status'

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) { prev[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]! }
  try { await fn() } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! }
  }
}

const T = 1_700_000_000_000

// ── status merge ────────────────────────────────────────────────────────────
test('unknown SID → first callback creates a fresh record (delivered)', () => {
  const { record, isNewStatus, shouldAlert } = mergeDeliveryStatus(null, { sid: 'SM1', status: 'delivered', now: T })
  assert.equal(record.sid, 'SM1')
  assert.equal(record.status, 'delivered')
  assert.deepEqual(record.statusesSeen, ['delivered'])
  assert.equal(isNewStatus, true)
  assert.equal(shouldAlert, false)           // delivered is not a failure
})

test('failed → alerts exactly once (first time)', () => {
  const first = mergeDeliveryStatus(null, { sid: 'SM2', status: 'failed', errorCode: 30007, now: T })
  assert.equal(first.shouldAlert, true)
  assert.equal(first.record.errorClass, 'carrier_filtered')
  assert.ok(first.record.terminalAlertedAt)
  // duplicate 'failed' callback → no re-alert, no duplicate history
  const dup = mergeDeliveryStatus(first.record, { sid: 'SM2', status: 'failed', errorCode: 30007, now: T + 1000 })
  assert.equal(dup.shouldAlert, false)
  assert.equal(dup.isNewStatus, false)
  assert.deepEqual(dup.record.statusesSeen, ['failed'])
})

test('undelivered is a terminal failure and alerts once', () => {
  const r = mergeDeliveryStatus(null, { sid: 'SM3', status: 'undelivered', errorCode: 30005, now: T })
  assert.equal(r.shouldAlert, true)
  assert.equal(r.record.errorClass, 'unknown_destination')
})

test('normal lifecycle queued→sent→delivered accumulates history, never alerts', () => {
  let rec: SmsStatusRecord | null = null
  for (const s of ['queued', 'sent', 'delivered']) {
    const m = mergeDeliveryStatus(rec, { sid: 'SM4', status: s, now: T })
    assert.equal(m.shouldAlert, false)
    rec = m.record
  }
  assert.deepEqual(rec!.statusesSeen, ['queued', 'sent', 'delivered'])
  assert.equal(rec!.status, 'delivered')
})

test('out-of-order duplicate of a non-failure status is idempotent', () => {
  const first = mergeDeliveryStatus(null, { sid: 'SM5', status: 'sent', now: T })
  const dup = mergeDeliveryStatus(first.record, { sid: 'SM5', status: 'sent', now: T + 5 })
  assert.equal(dup.isNewStatus, false)
  assert.deepEqual(dup.record.statusesSeen, ['sent'])
})

test('booking correlation fills once and is never cleared by a later callback', () => {
  const first = mergeDeliveryStatus(null, { sid: 'SM6', status: 'sent', bookingNumber: 'JK-B-1', notificationType: 'customer', now: T })
  const later = mergeDeliveryStatus(first.record, { sid: 'SM6', status: 'delivered', now: T + 100 })
  assert.equal(later.record.bookingNumber, 'JK-B-1')
  assert.equal(later.record.notificationType, 'customer')
})

// ── safe error classification ───────────────────────────────────────────────
test('classifyTwilioError maps known codes to safe slugs', () => {
  assert.equal(classifyTwilioError(30034), 'a2p_not_registered')
  assert.equal(classifyTwilioError(21610), 'recipient_opted_out')
  assert.equal(classifyTwilioError(30007), 'carrier_filtered')
  assert.equal(classifyTwilioError(99999), 'other')
  assert.equal(classifyTwilioError(undefined), undefined)
  assert.equal(classifyTwilioError(null), undefined)
})
test('isTerminalFailure only for failed/undelivered', () => {
  assert.equal(isTerminalFailure('failed'), true)
  assert.equal(isTerminalFailure('undelivered'), true)
  assert.equal(isTerminalFailure('delivered'), false)
  assert.equal(isTerminalFailure('sent'), false)
})

// ── PII masking / no leakage ────────────────────────────────────────────────
test('maskPhone keeps only the last 4 digits', () => {
  assert.equal(maskPhone('+18175551234'), '••••1234')
  assert.equal(maskPhone('8175551234'), '••••1234')
  assert.equal(maskPhone(undefined), undefined)
})
test('a stored record never contains a full number or a message body', () => {
  const { record } = mergeDeliveryStatus(null, { sid: 'SM7', status: 'delivered', toMasked: maskPhone('+18175551234'), now: T })
  const json = JSON.stringify(record)
  assert.ok(!json.includes('8175551234'), 'no full phone number in the record')
  assert.ok(!('body' in record), 'no message body field')
  assert.equal(record.toMasked, '••••1234')
})

// ── route auth boundary ─────────────────────────────────────────────────────
test('status webhook FAILS CLOSED with no TWILIO_AUTH_TOKEN', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/status/route')
  await withEnv({ TWILIO_AUTH_TOKEN: undefined }, async () => {
    const req = new NextRequest('https://www.jkissllc.com/api/webhooks/twilio/status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'MessageSid=SM1&MessageStatus=delivered' })
    const res = await POST(req)
    assert.equal(res.status, 503)
  })
})
test('status webhook rejects a missing signature 403', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/status/route')
  await withEnv({ TWILIO_AUTH_TOKEN: 'test_token', PUBLIC_BASE_URL: 'https://www.jkissllc.com' }, async () => {
    const req = new NextRequest('https://www.jkissllc.com/api/webhooks/twilio/status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'MessageSid=SM1&MessageStatus=delivered' })
    const res = await POST(req)
    assert.equal(res.status, 403)
  })
})
test('status webhook rejects an invalid signature 403', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/status/route')
  await withEnv({ TWILIO_AUTH_TOKEN: 'test_token', PUBLIC_BASE_URL: 'https://www.jkissllc.com' }, async () => {
    const req = new NextRequest('https://www.jkissllc.com/api/webhooks/twilio/status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bogus' }, body: 'MessageSid=SM1&MessageStatus=delivered' })
    const res = await POST(req)
    assert.equal(res.status, 403)
  })
})
