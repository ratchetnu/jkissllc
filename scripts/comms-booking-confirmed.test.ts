// Controlled BOOKING_CONFIRMED wiring — proves the event records exactly ONE
// suppressed/test ledger entry per confirmed booking, NEVER calls a provider, is
// idempotent, and is fail-soft. Pure: all seams are injected fakes (no Redis, no
// Twilio/Resend).
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import type { CommDeps } from '../app/lib/comms/service'
import { emitBookingConfirmedComm, bookingConfirmedIdempotencyKey } from '../app/lib/comms/wire-booking-confirmed'

let seq = 1000
const booking = (o: Partial<Booking> = {}): Booking => ({
  token: (o.token ?? `bk${seq++}`).padEnd(16, '0'),
  bookingNumber: o.bookingNumber ?? `JK-B-${seq}`,
  customerName: 'Jane Doe',
  customerPhone: '+18175551234',
  customerEmail: 'jane@example.com',
  serviceType: 'junk-removal',
  items: [],
  invoiceAmountCents: 40000, depositAmountCents: 20000, amountPaidCents: 20000,
  availableDates: [], availableWindows: [],
  selectedDate: '2026-08-01', selectedWindow: '8am–10am',
  status: 'confirmed', payments: [], source: 'online',
  createdAt: 1, updatedAt: 1,
  ...o,
} as Booking)

// A fake deps bag that records ledger writes and FAILS LOUDLY if any provider is called.
type Rec = Parameters<CommDeps['record']>[0]
function fakeDeps(over: Partial<CommDeps> = {}) {
  const records: Rec[] = []
  const providerCalls = { sms: 0, email: 0 }
  const deps: Partial<CommDeps> = {
    now: () => 1_700_000_000_000,
    claim: async () => true,
    record: async (m) => { records.push(m); return { id: `rec_${records.length}` } },
    sendSms: async () => { providerCalls.sms++; throw new Error('PROVIDER CALLED — must not happen in test mode') },
    sendEmail: async () => { providerCalls.email++; throw new Error('PROVIDER CALLED — must not happen in test mode') },
    isSmsOptedOut: async () => false,
    isEmailOptedOut: async () => false,
    audit: async () => ({}),
    ...over,
  }
  return { deps, records, providerCalls }
}

test('confirming a booking records EXACTLY ONE suppressed/test entry and calls NO provider', async () => {
  const { deps, records, providerCalls } = fakeDeps()
  const res = await emitBookingConfirmedComm(booking(), {}, deps)

  assert.ok(res, 'dispatch result returned')
  assert.equal(res!.mode, 'test')                     // forced test mode
  assert.equal(records.length, 1, 'exactly one ledger row')
  assert.equal(providerCalls.sms, 0, 'no SMS provider call')
  assert.equal(providerCalls.email, 0, 'no email provider call')

  const row = records[0]
  assert.ok(row.tags?.includes('simulated'), 'row tagged simulated (suppressed/test)')
  assert.ok(row.tags?.includes('event:BOOKING_CONFIRMED'), 'row tagged with the event')
  assert.equal(row.status, 'queued')                  // never "sent"
  assert.equal(row.channel, 'sms')                    // single preferred channel
  assert.equal(res!.outcomes.length, 1)
  assert.equal(res!.outcomes[0].status, 'simulated')
})

test('idempotent: a duplicate claim writes NO new entry', async () => {
  const { deps, records } = fakeDeps({ claim: async () => false }) // claim already held → duplicate
  const res = await emitBookingConfirmedComm(booking(), {}, deps)
  assert.equal(res!.duplicate, true)
  assert.equal(records.length, 0, 'no ledger row on duplicate')
})

test('idempotency key is stable per booking token', () => {
  const b = booking({ token: 'abc123abc123abc1' })
  assert.equal(bookingConfirmedIdempotencyKey(b.token), 'booking-confirmed:abc123abc123abc1')
})

test('fail-soft: an error in the comms path returns null and never throws', async () => {
  const { deps, records } = fakeDeps({ claim: async () => { throw new Error('redis down') } })
  let threw = false
  let res: unknown
  try { res = await emitBookingConfirmedComm(booking(), {}, deps) } catch { threw = true }
  assert.equal(threw, false, 'emit never throws')
  assert.equal(res, null, 'returns null on failure')
  assert.equal(records.length, 0)
})

test('a booking with no contact info records nothing (no crash)', async () => {
  const { deps, records } = fakeDeps()
  const res = await emitBookingConfirmedComm(booking({ customerPhone: undefined, customerEmail: undefined }), {}, deps)
  assert.equal(res, null)
  assert.equal(records.length, 0)
})

test('falls back to a single EMAIL entry when no phone is on file', async () => {
  const { deps, records, providerCalls } = fakeDeps()
  const res = await emitBookingConfirmedComm(booking({ customerPhone: undefined }), {}, deps)
  assert.equal(records.length, 1)
  assert.equal(records[0].channel, 'email')
  assert.equal(providerCalls.email, 0)
  assert.equal(res!.outcomes[0].status, 'simulated')
})
