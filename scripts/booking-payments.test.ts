// Booking payment workflow — pure logic (no Redis / no network): Zelle status
// transitions, secure-proof validation, the payment-provider registry, the owner-
// notification ledger, audit events, and customer-view redaction.
import assert from 'node:assert/strict'
import test from 'node:test'

// Make both providers "configured" for the registry tests (read at call time).
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_key'

import {
  recompute, customerView, pushBookingEvent, recordNotificationAttempt, lastNotification,
  paymentSummaryStatus, balanceDueCents,
  type Booking, type Payment,
} from '../app/lib/bookings'
import { validateProofImage, PROOF_PATH_RE } from '../app/lib/payment-proof'
import { getPaymentProvider, listPaymentProviders, publicPaymentMethods, providerRequiresProof } from '../app/lib/payments'

// ── helpers ──────────────────────────────────────────────────────────────────
const mkBooking = (o: Partial<Booking> = {}): Booking => ({
  token: 'a'.repeat(64), bookingNumber: 'JK-B-1001', customerName: 'Jane Doe',
  serviceType: 'moving', items: [], invoiceAmountCents: 0, depositAmountCents: 5000,
  amountPaidCents: 0, availableDates: ['2026-08-01'], availableWindows: ['8am–10am'],
  status: 'booking_created', payments: [], createdAt: 1, updatedAt: 1,
  ...o,
})
const zellePayment = (o: Partial<Payment> = {}): Payment => ({
  id: 'p1', type: 'deposit', method: 'zelle', status: 'sent_by_customer',
  amountCents: 5000, feeCents: 0, totalChargedCents: 5000, netCents: 5000,
  proofPath: `payment-proofs/${'a'.repeat(64)}/uuid.jpg.enc`, proofUploadedAt: 2, createdAt: 2,
  ...o,
})
const dataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300)])
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300)])

// ── Zelle status lifecycle (request Parts 1, 6, 8) ───────────────────────────
test('an uploaded-but-unverified Zelle proof puts the booking in pending_zelle_verification', () => {
  const b = mkBooking({
    customerTimeVerifiedAt: 3, selectedDate: '2026-08-01', selectedWindow: '8am–10am',
    payments: [zellePayment()],
  })
  recompute(b)
  assert.equal(b.status, 'pending_zelle_verification')
  assert.equal(b.amountPaidCents, 0)                      // unverified money never counts toward paid
  assert.equal(balanceDueCents(b), 0)                     // invoice not yet set
})

test('approving the Zelle payment (confirmed) advances the booking to confirmed', () => {
  const b = mkBooking({
    customerTimeVerifiedAt: 3, selectedDate: '2026-08-01', selectedWindow: '8am–10am',
    invoiceAmountCents: 20000,
    payments: [zellePayment({ status: 'confirmed', confirmedAt: 9 })],
  })
  recompute(b)
  assert.equal(b.status, 'confirmed')
  assert.equal(b.amountPaidCents, 5000)
  assert.equal(paymentSummaryStatus(b), 'deposit_paid')
})

test('rejecting a Zelle payment (failed) does not leave it pending', () => {
  const b = mkBooking({
    customerTimeVerifiedAt: 3, selectedDate: '2026-08-01', selectedWindow: '8am–10am',
    payments: [zellePayment({ status: 'failed', rejectionReason: 'blurry' })],
  })
  recompute(b)
  assert.equal(b.status, 'time_verified')                 // reverts out of pending
})

// ── Secure proof validation (request Parts 4-5) ──────────────────────────────
test('valid JPG / PNG screenshots pass validation', () => {
  const j = validateProofImage(dataUrl('image/jpeg', jpg))
  assert.equal(j.ok, true)
  const p = validateProofImage(dataUrl('image/png', png))
  assert.equal(p.ok, true)
})

test('non-image, oversized, empty, and mime/content-mismatched uploads are rejected', () => {
  assert.equal(validateProofImage(dataUrl('application/pdf', jpg)).ok, false)   // PDF/exe/unknown
  assert.equal(validateProofImage(dataUrl('image/jpeg', png)).ok, false)        // declared JPEG, PNG bytes
  assert.equal(validateProofImage(dataUrl('image/jpeg', Buffer.alloc(20))).ok, false) // empty/too small
  assert.equal(validateProofImage('data:image/jpeg;base64,' + 'A'.repeat(10_000_100)).ok, false) // oversized
  assert.equal(validateProofImage('not a data url').ok, false)
  assert.equal(validateProofImage(123 as unknown).ok, false)
})

test('the sealed proof-path regex accepts only booking-scoped .enc paths (IDOR defense)', () => {
  const good = `payment-proofs/${'a'.repeat(64)}/3f2a-uuid.jpg.enc`
  assert.equal(PROOF_PATH_RE.test(good), true)
  assert.equal(PROOF_PATH_RE.test('payment-proofs/../secrets.jpg.enc'), false)
  assert.equal(PROOF_PATH_RE.test('driver-docs/ss_card/x.jpg.enc'), false)          // different prefix
  assert.equal(PROOF_PATH_RE.test(`payment-proofs/${'a'.repeat(64)}/x.pdf.enc`), false) // non-image ext
})

// ── Modular payment providers (request Part 17) ──────────────────────────────
test('the provider registry exposes stripe (redirect) and zelle (proof_upload)', () => {
  const ids = listPaymentProviders().map(p => p.id)
  assert.ok(ids.includes('stripe'))
  assert.ok(ids.includes('zelle'))
  assert.equal(getPaymentProvider('stripe')!.kind, 'redirect')
  assert.equal(getPaymentProvider('zelle')!.kind, 'proof_upload')
  assert.equal(providerRequiresProof('zelle'), true)
  assert.equal(providerRequiresProof('stripe'), false)
})

test('public payment methods carry no functions (UI-safe projection)', () => {
  for (const m of publicPaymentMethods()) {
    assert.equal(typeof (m as Record<string, unknown>).configured, 'undefined')
    assert.ok(m.label && m.tagline && Array.isArray(m.bullets))
  }
})

// ── Owner-notification ledger (request Part 7) ───────────────────────────────
test('the notification ledger records attempts and returns the latest of a kind (dedupe)', () => {
  const b = mkBooking()
  recordNotificationAttempt(b, { kind: 'zelle_review', channel: 'sms', status: 'failed', error: 'no phone', retryCount: 0 })
  recordNotificationAttempt(b, { kind: 'zelle_review', channel: 'sms', status: 'sent', providerId: 'SM123', retryCount: 1 })
  recordNotificationAttempt(b, { kind: 'new_confirmed_booking', channel: 'email', status: 'sent', retryCount: 0 })
  assert.equal(b.notifications!.length, 3)
  const last = lastNotification(b, 'zelle_review')
  assert.equal(last!.status, 'sent')
  assert.equal(last!.retryCount, 1)
  assert.equal(last!.providerId, 'SM123')
  assert.equal(lastNotification(b, 'confirmation_customer'), undefined)
})

test('audit events are appended with a timestamp', () => {
  const b = mkBooking()
  pushBookingEvent(b, { actor: 'customer', action: 'booking.created', result: 'zelle' })
  pushBookingEvent(b, { actor: 'system', action: 'zelle.uploaded' })
  assert.equal(b.events!.length, 2)
  assert.equal(b.events![0].action, 'booking.created')
  assert.ok(b.events![1].at > 0)
})

// ── Customer-view redaction (request Part 10 — never expose sensitive data) ──
test('customerView never leaks the sealed proof path, audit trail, or notification ledger', () => {
  const b = mkBooking({
    payments: [zellePayment()],
    events: [{ at: 1, actor: 'system', action: 'zelle.uploaded' }],
    notifications: [{ id: 'n1', kind: 'zelle_review', channel: 'sms', status: 'sent', at: 1, retryCount: 0 }],
    replacementUpload: { token: 'secret', paymentId: 'p1', at: 1 },
    idempotencyKey: 'idem-123',
    internalNotes: 'owner only',
    assignees: [{
      staffId: 'crew-secret', name: 'Crew Secret', phone: '555-555-1212', token: 'crew-job-token',
      payCents: 17500, confirmIp: '203.0.113.10', clockInLat: 32.7, clockInLng: -97.3,
    }],
  })
  const cv = customerView(b) as Record<string, unknown>
  assert.equal('events' in cv, false)
  assert.equal('notifications' in cv, false)
  assert.equal('replacementUpload' in cv, false)
  assert.equal('idempotencyKey' in cv, false)
  assert.equal('internalNotes' in cv, false)
  assert.equal('assignees' in cv, false, 'crew pay, contact, credentials, IP, and GPS stay private')
  // The customer can see THAT a proof exists, never the sealed path.
  const p = (cv.payments as Array<Record<string, unknown>>)[0]
  assert.equal(p.hasProof, true)
  assert.equal('proofPath' in p, false)
})
