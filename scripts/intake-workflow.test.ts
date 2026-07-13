// Customer identity dedup, Lead projection mapping, and the flag-off no-op safety
// of the intake orchestration. Hermetic — an in-memory fake stands in for Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeCustomers } from '../app/lib/customers'
import { buildLeadProjection } from '../app/lib/leads'
import { onLeadPersisted, onPaymentCaptured } from '../app/lib/intake-workflow'
import type { Booking } from '../app/lib/bookings'

function fakeKV() {
  const m = new Map<string, string>()
  return { m, async get(k: string) { return m.get(k) ?? null }, async set(k: string, v: string) { m.set(k, v) } }
}

const booking = (over: Partial<Booking> = {}): Booking => ({
  token: 'bk_1', bookingNumber: 'JK-B-0001',
  customerName: 'John Smith', customerEmail: 'John@Example.com', customerPhone: '(817) 555-1234',
  serviceType: 'junk', source: 'online', status: 'quote_received', createdAt: 1000,
  ...over,
} as unknown as Booking)

test('upsertCustomer dedupes on email and backfills missing phone', async () => {
  const customers = makeCustomers(fakeKV())
  const a = await customers.upsertCustomer({ name: 'John', email: 'john@example.com', bookingToken: 'bk_1' })
  assert.equal(a.isNew, true)
  // Same email (different case), now with a phone → same id, phone backfilled, count++.
  const b = await customers.upsertCustomer({ name: 'John Smith', email: 'JOHN@example.com', phone: '817-555-1234', bookingToken: 'bk_2' })
  assert.equal(b.isNew, false)
  assert.equal(b.customer.id, a.customer.id)
  assert.equal(b.customer.phone, '817-555-1234')
  assert.equal(b.customer.bookingCount, 2)
})

test('upsertCustomer dedupes on phone when email absent, and separates distinct people', async () => {
  const customers = makeCustomers(fakeKV())
  const a = await customers.upsertCustomer({ name: 'A', phone: '(817) 555-0000' })
  const bySamePhone = await customers.upsertCustomer({ name: 'A2', phone: '8175550000' })
  assert.equal(bySamePhone.customer.id, a.customer.id) // normalized phone match
  const other = await customers.upsertCustomer({ name: 'B', email: 'b@example.com' })
  assert.notEqual(other.customer.id, a.customer.id)
})

test('buildLeadProjection maps AI estimate dollars → cents', () => {
  const est = { pricing: { lowUsd: 100, highUsd: 300, recommendedUsd: 200 }, decision: 'estimate_range' }
  const lead = buildLeadProjection(booking({ aiEstimate: est as unknown as Booking['aiEstimate'] }), { customerId: 'c_1', tenantId: 'jkiss' })
  assert.equal(lead.estimateLowCents, 10000)
  assert.equal(lead.estimateHighCents, 30000)
  assert.equal(lead.recommendedCents, 20000)
  assert.equal(lead.aiDecision, 'estimate_range')
  assert.equal(lead.customerId, 'c_1')
  // No estimate → undefined price fields (not zero).
  const bare = buildLeadProjection(booking())
  assert.equal(bare.estimateLowCents, undefined)
  assert.equal(bare.recommendedCents, undefined)
})

test('intake orchestration is a safe no-op while the flag is OFF (default)', async () => {
  // Flag default off → returns immediately, touches no store, never throws.
  await onLeadPersisted(booking())
  await onPaymentCaptured(booking(), { amountCents: 5000, method: 'stripe', justConfirmed: true })
  assert.ok(true)
})
