// Production Test Data Management: sandbox records are excluded from analytics and
// classified correctly. The analytics exclusion is the critical revenue-safety test.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isTestBooking, type Booking } from '../app/lib/bookings'
import { computeBookingAnalytics } from '../app/lib/analytics'

test('isTestBooking classifies the flag', () => {
  assert.equal(isTestBooking({ isTest: true }), true)
  assert.equal(isTestBooking({ isTest: false }), false)
  assert.equal(isTestBooking({}), false)
})

const NOW = Date.UTC(2026, 6, 13, 18, 0, 0) // fixed clock

const booking = (over: Partial<Booking> = {}): Booking => ({
  token: 't', bookingNumber: 'JK-B-0001', invoiceNumber: 'JK-INV-0001',
  customerName: 'Real Customer', serviceType: 'junk-removal',
  status: 'completed', invoiceAmountCents: 50000, depositAmountCents: 0, amountPaidCents: 50000,
  availableDates: [], availableWindows: [], selectedDate: '2026-07-13',
  items: [], payments: [{ id: 'p1', type: 'full', method: 'stripe', status: 'confirmed', amountCents: 50000, feeCents: 0, totalChargedCents: 50000, netCents: 50000, createdAt: NOW, confirmedAt: NOW }],
  events: [], createdAt: NOW, updatedAt: NOW,
  ...over,
} as unknown as Booking)

test('a test booking is invisible to booking analytics (revenue, counts)', () => {
  const real = booking({ token: 'real' })
  const testRec = booking({ token: 'test', isTest: true, customerName: 'TEST — do not service' })

  const withoutTest = computeBookingAnalytics([real], NOW)
  const withTest = computeBookingAnalytics([real, testRec], NOW)

  // Adding a paid test booking must not change revenue, ticket, or booking totals.
  assert.deepEqual(withTest.revenue, withoutTest.revenue)
  assert.equal(withTest.jobs.total, withoutTest.jobs.total)
  assert.equal(withTest.jobs.completed, withoutTest.jobs.completed)
})

test('analytics over ONLY test records reports zero revenue', () => {
  const testRec = booking({ token: 'test', isTest: true })
  const a = computeBookingAnalytics([testRec], NOW)
  assert.equal(a.revenue.allTime, 0)
  assert.equal(a.jobs.total, 0)
})
