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

import { computePay } from '../app/lib/route-pay'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { saveRoute, generateToken, type RouteRecord } from '../app/lib/routes'
import { saveStaff } from '../app/lib/staff'

const baseBooking = (overrides: Partial<Booking> = {}): Booking => ({
  token: generateToken(), bookingNumber: 'JK-B-2101', customerName: 'Alex Customer',
  serviceType: 'junk-removal', items: [], invoiceAmountCents: 45000,
  depositAmountCents: 0, amountPaidCents: 0, availableDates: [], availableWindows: [],
  selectedDate: '2026-07-08', status: 'in_progress', payments: [], source: 'online',
  createdAt: 1, updatedAt: 1, ...overrides,
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
