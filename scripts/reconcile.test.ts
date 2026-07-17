// Existing-data reconciliation classifier — pure, no Redis. Proves each record is
// bucketed deterministically and that ambiguous/duplicate records are surfaced for
// review, never silently converted.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import { reconcile, classifyBooking, findDuplicateTokens } from '../app/lib/schedule/reconcile'

let n = 1000
const booking = (o: Partial<Booking> = {}): Booking => ({
  token: (o.token ?? `bk${n++}`).padEnd(16, '0'),
  bookingNumber: o.bookingNumber ?? `JK-B-${n}`,
  customerName: 'Jane Doe',
  serviceType: 'junk-removal',
  items: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
  availableDates: [], availableWindows: [],
  status: 'quote_received', payments: [], source: 'online',
  createdAt: 1, updatedAt: 1,
  ...o,
} as Booking)

test('request-only, accepted-unscheduled, scheduled-linked, completed, cancelled classify correctly', () => {
  const none = new Set<string>()
  assert.equal(classifyBooking(booking({ status: 'quote_received' }), none), 'request_only')
  assert.equal(classifyBooking(booking({ status: 'payment_received', amountPaidCents: 20000 }), none), 'accepted_but_unscheduled')
  assert.equal(classifyBooking(booking({ status: 'confirmed', selectedDate: '2026-07-20' }), none), 'scheduled_and_linked')
  assert.equal(classifyBooking(booking({ status: 'completed', selectedDate: '2026-07-20' }), none), 'completed')
  assert.equal(classifyBooking(booking({ status: 'cancelled' }), none), 'cancelled')
})

test('a hard date under a pending status is "scheduled but not confirmed work"', () => {
  assert.equal(classifyBooking(booking({ status: 'quote_received', selectedDate: '2026-07-20' }), new Set()), 'scheduled_but_missing_job')
})

test('duplicates are detected by customer+date+service and by idempotency key', () => {
  const a = booking({ token: 'a1'.padEnd(16, '0'), customerName: 'Sam Twin', serviceType: 'moving', status: 'confirmed', selectedDate: '2026-07-20' })
  const b = booking({ token: 'b2'.padEnd(16, '0'), customerName: 'Sam Twin', serviceType: 'moving', status: 'confirmed', selectedDate: '2026-07-20' })
  const c = booking({ token: 'c3'.padEnd(16, '0'), customerName: 'Different', idempotencyKey: 'idem-x' })
  const d = booking({ token: 'd4'.padEnd(16, '0'), customerName: 'Other', idempotencyKey: 'idem-x' })
  const dups = findDuplicateTokens([a, b, c, d])
  assert.ok(dups.has('a1'.padEnd(16, '0')) && dups.has('b2'.padEnd(16, '0')))
  assert.ok(dups.has('c3'.padEnd(16, '0')) && dups.has('d4'.padEnd(16, '0')))
  assert.equal(classifyBooking(a, dups), 'duplicate')
})

test('reconcile produces counts and a review-required list; nothing is mutated', () => {
  const input = [
    booking({ status: 'quote_received' }),
    booking({ status: 'payment_received', amountPaidCents: 15000 }),
    booking({ status: 'confirmed', selectedDate: '2026-07-20' }),
    booking({ status: 'completed', selectedDate: '2026-07-10' }),
    booking({ status: 'cancelled' }),
    booking({ token: 'z1'.padEnd(16, '0'), customerName: 'Dup Guy', serviceType: 'moving', status: 'confirmed', selectedDate: '2026-08-01' }),
    booking({ token: 'z2'.padEnd(16, '0'), customerName: 'Dup Guy', serviceType: 'moving', status: 'confirmed', selectedDate: '2026-08-01' }),
  ]
  const snapshot = JSON.stringify(input)
  const report = reconcile(input, 1_700_000_000_000)
  assert.equal(report.total, 7)
  assert.equal(report.counts.request_only, 1)
  assert.equal(report.counts.accepted_but_unscheduled, 1)
  assert.equal(report.counts.completed, 1)
  assert.equal(report.counts.cancelled, 1)
  assert.equal(report.counts.duplicate, 2)
  assert.equal(report.reviewRequired.length, 2) // the two duplicates
  // Read-only: input records are untouched.
  assert.equal(JSON.stringify(input), snapshot)
})
