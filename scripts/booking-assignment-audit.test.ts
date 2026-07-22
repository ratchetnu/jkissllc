// Booking assignment audit ledger — behavioral tests against the real
// orchestration and CAS write path. Every operational mutation must say who did
// what, while retries/double taps must not manufacture duplicate history.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-assignment-audit.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'

const UPSTASH = process.env.KV_REST_API_URL
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [command, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (command.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREVRANGE': {
      const values = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member)
      const stop = Number(args[2])
      result = values.slice(Number(args[1]), stop === -1 ? values.length : stop + 1)
      break
    }
    case 'EXPIRE': case 'PEXPIRE': result = 1; break
    case 'EVAL': {
      const [, , casKey, payload, expected] = args
      const raw = kv.get(casKey)
      const version = raw ? Number((JSON.parse(raw) as { version?: number }).version ?? 0) : 0
      if (version === Number(expected)) { kv.set(casKey, payload); result = 1 } else result = 0
      break
    }
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { getBookingByToken, saveBooking, type Booking, type BookingEventAction } from '../app/lib/bookings'
import { saveStaff } from '../app/lib/staff'
import { saveEquipment } from '../app/lib/equipment'
import {
  acceptBookingAssignment, assignCrewToBooking, declineBookingAssignment,
  punchBookingClock, recordBookingCompletion, setBookingCrewPay,
  setBookingEquipment, unassignCrewFromBooking,
} from '../app/lib/booking-assignment'

const TOKEN = 'b'.repeat(64)
const ADMIN = 'account:owner-1'

async function seed(): Promise<void> {
  const now = Date.now()
  await saveStaff({ id: 'crew-1', name: 'Crew One', role: 'Driver', active: true, defaultPayCents: 15000, createdAt: now, updatedAt: now })
  await saveStaff({ id: 'crew-2', name: 'Crew Two', role: 'Helper', active: true, createdAt: now + 1, updatedAt: now + 1 })
  await saveEquipment({ id: 'truck-1', name: 'Truck One', ownership: 'company', active: true, createdAt: now, updatedAt: now })
  await saveBooking({
    token: TOKEN, bookingNumber: 'JK-B-AUDIT', status: 'confirmed', serviceType: 'moving',
    customerName: 'Audit Customer', items: [], payments: [], availableDates: [], availableWindows: [],
    amountPaidCents: 0, depositAmountCents: 0, invoiceAmountCents: 0,
    createdAt: now, updatedAt: now,
  } as unknown as Booking)
}

const events = async (action?: BookingEventAction) => {
  const all = (await getBookingByToken(TOKEN))?.events ?? []
  return action ? all.filter(event => event.action === action) : all
}

test('every assignment verb records an attributed event and idempotent repeats stay single', async () => {
  await seed()

  assert.equal((await assignCrewToBooking(TOKEN, 'crew-1', { actor: ADMIN })).ok, true)
  assert.equal((await assignCrewToBooking(TOKEN, 'crew-2', { actor: ADMIN })).ok, true)
  assert.equal((await setBookingCrewPay(TOKEN, 'crew-1', 17500, { actor: ADMIN })).ok, true)
  assert.equal((await setBookingCrewPay(TOKEN, 'crew-1', 17500, { actor: ADMIN })).ok, true)
  assert.equal((await setBookingEquipment(TOKEN, { equipmentId: 'truck-1' }, { actor: ADMIN })).ok, true)
  assert.equal((await setBookingEquipment(TOKEN, { equipmentId: 'truck-1' }, { actor: ADMIN })).ok, true)

  assert.equal((await acceptBookingAssignment(TOKEN, 'crew-1', { at: 100 })).ok, true)
  assert.equal((await acceptBookingAssignment(TOKEN, 'crew-1', { at: 200 })).ok, true)
  assert.equal((await punchBookingClock(TOKEN, 'crew-1', 'clock_in', {})).ok, true)
  const secondIn = await punchBookingClock(TOKEN, 'crew-1', 'clock_in', {})
  assert.equal(secondIn.ok && secondIn.already, true)
  assert.equal((await punchBookingClock(TOKEN, 'crew-1', 'clock_out', {})).ok, true)

  assert.equal((await declineBookingAssignment(TOKEN, 'crew-2', 'Unavailable')).ok, true)
  assert.equal((await declineBookingAssignment(TOKEN, 'crew-2', 'Duplicate tap')).ok, true)
  assert.equal((await recordBookingCompletion(TOKEN, { by: 'crew', staffId: 'crew-1', note: 'Finished', at: 300 })).ok, true)
  assert.equal((await recordBookingCompletion(TOKEN, { by: 'admin', actor: ADMIN, note: 'Reviewed', at: 400 })).ok, true)
  assert.equal((await unassignCrewFromBooking(TOKEN, 'crew-2', { actor: ADMIN })).ok, true)

  const expected: Array<[BookingEventAction, string, number]> = [
    ['assignment.crew_added', ADMIN, 2],
    ['assignment.pay_changed', ADMIN, 1],
    ['assignment.equipment_changed', ADMIN, 1],
    ['assignment.accepted', 'crew:crew-1', 1],
    ['assignment.clock_in', 'crew:crew-1', 1],
    ['assignment.clock_out', 'crew:crew-1', 1],
    ['assignment.declined', 'crew:crew-2', 1],
    ['assignment.completion_recorded', 'crew:crew-1', 2],
    ['assignment.crew_removed', ADMIN, 1],
  ]
  for (const [action, actor, count] of expected) {
    const matching = await events(action)
    assert.equal(matching.length, count, `${action} count`)
    assert.ok(matching.some(event => event.actor === actor), `${action} records ${actor}`)
  }
  assert.ok((await events('assignment.completion_recorded')).some(event => event.actor === ADMIN), 'admin completion preserves principal identity')
})

test('flag off writes neither assignment data nor audit history', async () => {
  await seed()
  process.env.BOOKING_ASSIGNMENT_ENABLED = 'false'
  try {
    assert.deepEqual(await assignCrewToBooking(TOKEN, 'crew-1', { actor: ADMIN }), { ok: false, error: 'disabled' })
    const booking = await getBookingByToken(TOKEN)
    assert.equal(booking?.assignees, undefined)
    assert.deepEqual(booking?.events ?? [], [])
  } finally {
    process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
  }
})
