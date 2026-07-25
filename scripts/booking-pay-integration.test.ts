// Operion Sprint 1: completed Book Now work must reach the same deterministic
// contractor-pay engine as delivery routes. Uses an in-memory Redis transport;
// no Preview or Production data is touched.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'

const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const [command, ...args] = JSON.parse(init.body) as string[]
  const key = args[0]
  let result: unknown = null
  switch (command.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const values = [...z(key)].sort((a, b) => a[1] - b[1]).map(([member]) => member)
      if (command.toUpperCase() === 'ZREVRANGE') values.reverse()
      const start = Number(args[1]); const stop = Number(args[2])
      result = values.slice(start, stop === -1 ? undefined : stop + 1)
      break
    }
    case 'PEXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${command}`)
  }
  return { json: async () => ({ result }) }
}) as unknown as typeof fetch

import { computePay, payableCents } from '../app/lib/route-pay'
import { effectiveServiceDate, saveBooking, type Booking } from '../app/lib/bookings'
import { saveRoute, generateToken, type RouteRecord } from '../app/lib/routes'
import { saveStaff } from '../app/lib/staff'

const baseBooking = (overrides: Partial<Booking> = {}): Booking => ({
  token: generateToken(), bookingNumber: 'JK-B-2101', customerName: 'Alex Customer',
  serviceType: 'junk-removal', items: [], invoiceAmountCents: 45000,
  depositAmountCents: 0, amountPaidCents: 0, availableDates: [], availableWindows: [],
  selectedDate: '2026-07-08', status: 'completed', payments: [], source: 'online',
  createdAt: 1, updatedAt: 1, ...overrides,
})

test('effectiveServiceDate preserves the return visit after a continued job closes', () => {
  assert.equal(effectiveServiceDate(baseBooking({ selectedDate: '2026-06-30' })), '2026-06-30')
  assert.equal(effectiveServiceDate(baseBooking({ selectedDate: undefined, availableDates: ['2026-07-08'] })), '2026-07-08')
  for (const status of ['continued', 'completed', 'partially_completed'] as const) {
    assert.equal(effectiveServiceDate(baseBooking({
      status, selectedDate: '2026-06-30', continuation: { continuedAt: 1, returnDate: '2026-07-09' },
    })), '2026-07-09')
  }
  assert.equal(effectiveServiceDate(baseBooking({
    status: 'cancelled', selectedDate: '2026-06-30', continuation: { continuedAt: 1, returnDate: '2026-07-09' },
  })), '2026-06-30')
})

async function seed() {
  kv.clear(); zsets.clear()
  await saveStaff({ id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
  await saveRoute({
    token: generateToken(), routeNumber: 'JK-R-2001', status: 'completed',
    businessName: 'Supercharged', reportAddress: '1 Main St', reportTime: '8:00 AM',
    routeDate: '2026-07-07', events: [], audit: [], createdAt: 1, updatedAt: 1,
    assignees: [{ staffId: 'marcus', name: 'Marcus', role: 'Driver', token: generateToken(), payCents: 17500, pay: '$175.00' }],
  } as RouteRecord)
}

test('completed route and completed booking produce one combined pay statement', async () => {
  await seed()
  await saveBooking(baseBooking({
    jobCompletedAt: Date.UTC(2026, 6, 8, 18), jobCompletedBy: 'crew', completionPhotos: ['https://example.test/proof.jpg'],
    assignees: [{ staffId: 'marcus', name: 'Marcus', role: 'Driver', token: generateToken(), payCents: 22500, pay: '$225.00', clockInAt: 1_000_000, clockOutAt: 6_400_000 }],
  }))

  const pay = await computePay('2026-07-06', '2026-07-12')
  const marcus = pay.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(pay.routeCount, 2)
  assert.equal(pay.deliveryRouteCount, 1)
  assert.equal(pay.bookingCount, 1)
  assert.equal(marcus.count, 2)
  assert.equal(marcus.grossCents, 40000)
  assert.deepEqual(marcus.routes.map(line => [line.source, line.routeNumber]), [
    ['route', 'JK-R-2001'], ['booking', 'JK-B-2101'],
  ])
  assert.equal(marcus.routes[1].workedMinutes, 90, 'booking clock punches remain attached to the statement line')
})

test('declined booking crew are excluded and an unpriced active crew member remains visible', async () => {
  await seed()
  await saveBooking(baseBooking({
    jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [
      { staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 30000, declinedAt: 10 },
      { staffId: 'helper', name: 'Helper', token: generateToken(), clockInAt: 100, clockOutAt: 200 },
    ],
  }))

  const pay = await computePay('2026-07-06', '2026-07-12')
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 17500, 'declined booking pay is excluded')
  const helper = pay.contractors.find(c => c.staffId === 'helper')!
  assert.equal(helper.count, 1)
  assert.equal(helper.grossCents, 0)
  assert.equal(helper.unpricedCount, 1)
  assert.equal(helper.routes[0].source, 'booking')
})

test('unfinished and out-of-period bookings never enter pay', async () => {
  await seed()
  await saveBooking(baseBooking({
    bookingNumber: 'JK-B-UNFINISHED', jobCompletedAt: undefined,
    assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 50000 }],
  }))
  await saveBooking(baseBooking({
    bookingNumber: 'JK-B-OLD', selectedDate: '2026-06-01', jobCompletedAt: Date.UTC(2026, 5, 1),
    assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 50000 }],
  }))

  const pay = await computePay('2026-07-06', '2026-07-12')
  assert.equal(pay.routeCount, 1)
  assert.equal(pay.bookingCount, 0)
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 17500)
})

test('cancelled, refunded, and could-not-complete bookings never enter pay', async () => {
  await seed()
  for (const [i, status] of (['cancelled', 'refunded', 'could_not_complete'] as const).entries()) {
    await saveBooking(baseBooking({
      token: generateToken(), bookingNumber: `JK-B-CLOSED-${i}`, status,
      jobCompletedAt: Date.UTC(2026, 6, 8, 18),
      assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 22500 }],
    }))
  }
  const pay = await computePay('2026-07-06', '2026-07-12')
  assert.equal(pay.bookingCount, 0)
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 17500)
})

test('effective service date pays a single-date booking and continued return work in the correct week', async () => {
  await seed()
  await saveBooking(baseBooking({
    bookingNumber: 'JK-B-AVAILABLE', selectedDate: undefined, availableDates: ['2026-07-08'],
    jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 22500 }],
  }))
  await saveBooking(baseBooking({
    token: generateToken(), bookingNumber: 'JK-B-CONTINUED', status: 'completed', selectedDate: '2026-06-30',
    continuation: { continuedAt: 1, returnDate: '2026-07-09' },
    jobCompletedAt: Date.UTC(2026, 6, 9, 18),
    assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 25000 }],
  }))
  const pay = await computePay('2026-07-06', '2026-07-12')
  assert.equal(pay.bookingCount, 2)
  const lines = pay.contractors.find(c => c.staffId === 'marcus')!.routes
  assert.deepEqual(lines.map(r => r.routeDate), ['2026-07-07', '2026-07-08', '2026-07-09'])
  assert.equal(lines[1].hasProof, false, 'a completion timestamp alone is not attachment proof')
})

test('completed crewed booking without any service date is a visible blocking gap', async () => {
  await seed()
  await saveBooking(baseBooking({
    bookingNumber: 'JK-B-UNDATED', selectedDate: undefined, availableDates: [],
    jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 22500 }],
  }))
  const pay = await computePay('2026-07-06', '2026-07-12')
  assert.deepEqual(pay.payrollGaps, [{ bookingNumber: 'JK-B-UNDATED', staffIds: ['marcus'], reason: 'missing_service_date' }])
})

test('flag false and absent both keep booking work out of pay', async () => {
  await seed()
  await saveBooking(baseBooking({
    jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 22500 }],
  }))
  const prior = process.env.BOOKING_ASSIGNMENT_ENABLED
  try {
    process.env.BOOKING_ASSIGNMENT_ENABLED = 'false'
    const off = await computePay('2026-07-06', '2026-07-12')
    assert.equal(off.routeCount, 1)
    assert.equal(off.bookingCount, undefined)
    assert.equal(off.contractors[0].routes[0].source, undefined)
    assert.equal(off.contractors[0].routes[0].workedMinutes, undefined)
    delete process.env.BOOKING_ASSIGNMENT_ENABLED
    const absent = await computePay('2026-07-06', '2026-07-12')
    assert.equal(absent.routeCount, 1)
    assert.equal(absent.bookingCount, undefined)
  } finally {
    if (prior === undefined) delete process.env.BOOKING_ASSIGNMENT_ENABLED
    else process.env.BOOKING_ASSIGNMENT_ENABLED = prior
  }
})

test('archived/test bookings are excluded and legacy display pay remains a safe fallback', async () => {
  await seed()
  for (const [i, marker] of ([{ archived: true }, { isTest: true }] as const).entries()) {
    await saveBooking(baseBooking({
      token: generateToken(), bookingNumber: `JK-B-HIDDEN-${i}`, ...marker,
      jobCompletedAt: Date.UTC(2026, 6, 8, 18),
      assignees: [{ staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: 50000 }],
    }))
  }
  await saveBooking(baseBooking({
    token: generateToken(), bookingNumber: 'JK-B-FALLBACK', jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [{ staffId: 'helper', name: 'Helper', token: generateToken(), pay: '$180.00' }],
  }))
  const pay = await computePay('2026-07-06', '2026-07-12')
  assert.equal(pay.bookingCount, 1)
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 17500)
  assert.equal(pay.contractors.find(c => c.staffId === 'helper')!.grossCents, 18000)
})

// ── Malformed / negative snapshot amounts never enter payable totals ──────────
// The bookings lane reads the frozen snapshot payCents directly. A negative value
// round-trips JSON storage (NaN/Infinity would collapse to null on serialize), so a
// negative payCents is the reachable defect: without the guard it silently shrinks
// gross. It must instead fall to UNPRICED — visible, but out of payable pay.
test('payableCents rejects negative and non-finite snapshot amounts, keeps valid ones', () => {
  assert.equal(payableCents(22500), 22500, 'a valid amount passes through unchanged')
  assert.equal(payableCents(0), 0, 'a genuine $0 line is priced, not unpriced')
  assert.equal(payableCents(-5000), null, 'a negative amount is rejected')
  assert.equal(payableCents(Number.NaN), null, 'NaN is rejected (never poisons gross)')
  assert.equal(payableCents(Number.POSITIVE_INFINITY), null, 'Infinity is rejected')
  assert.equal(payableCents(null), null)
  assert.equal(payableCents(undefined), null)
})

test('a negative booking snapshot amount is excluded from gross and surfaced as unpriced', async () => {
  await seed()
  await saveBooking(baseBooking({
    jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [
      { staffId: 'marcus', name: 'Marcus', token: generateToken(), payCents: -5000, pay: '-$50.00' },
      { staffId: 'helper', name: 'Helper', token: generateToken(), payCents: 22500, pay: '$225.00' },
    ],
  }))

  const pay = await computePay('2026-07-06', '2026-07-12')
  const marcus = pay.contractors.find(c => c.staffId === 'marcus')!
  // Route pay stands; the malformed booking line neither reduces nor inflates gross.
  assert.equal(marcus.grossCents, 17500, 'a negative snapshot never subtracts from gross')
  assert.equal(marcus.unpricedCount, 1, 'the malformed booking line is surfaced as unpriced')
  const badLine = marcus.routes.find(r => r.source === 'booking')!
  assert.equal(badLine.amountCents, null, 'the malformed amount is nulled, not carried into a payable line')
  // A valid crew member on the same booking is unaffected.
  assert.equal(pay.contractors.find(c => c.staffId === 'helper')!.grossCents, 22500)
  // Grand totals stay finite and correct — no NaN/negative poisoning across the summary.
  assert.equal(pay.grandGrossCents, 40000)
  assert.equal(Number.isFinite(pay.grandGrossCents), true)
  assert.equal(Number.isFinite(pay.grandNetCents), true)
})

// ── Historical snapshot is immutable: pay is the frozen assignee amount, never a
// live re-resolution from current staff/business settings. ────────────────────
test('booking pay uses the frozen snapshot amount even after current staff settings change', async () => {
  await seed()
  await saveBooking(baseBooking({
    jobCompletedAt: Date.UTC(2026, 6, 8, 18),
    assignees: [{ staffId: 'marcus', name: 'Marcus', role: 'Driver', token: generateToken(), payCents: 22500, pay: '$225.00' }],
  }))
  const before = (await computePay('2026-07-06', '2026-07-12')).contractors.find(c => c.staffId === 'marcus')!
  assert.equal(before.grossCents, 40000, 'route 17500 + snapshot booking 22500')

  // Change the CURRENT staff record after the fact (rename + a would-be new rate).
  await saveStaff({ id: 'marcus', name: 'Marcus Renamed', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 2 })

  const after = (await computePay('2026-07-06', '2026-07-12')).contractors.find(c => c.staffId === 'marcus')!
  assert.equal(after.grossCents, 40000, 'the historical booking amount is unchanged by a later settings change')
  assert.equal(after.name, 'Marcus Renamed', 'display name reflects the current roster; the AMOUNT does not')
})
