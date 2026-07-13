// Book Now intake → admin: structured field mapping + service-family filters.
// These cover the data the owner must see in OpsPilot for junk-removal and moving
// submissions, and the tabs that surface them — all as pure, hermetic checks.
import assert from 'node:assert/strict'
import test from 'node:test'

import { serviceFamily, JUNK_SERVICE_TYPES, MOVING_SERVICE_TYPES, type ServiceType } from '../app/lib/bookings'
import { buildBookNowDetail, type QuoteRequestInput } from '../app/lib/booking-requests'

const base: QuoteRequestInput = { name: 'x', serviceType: 'junk-removal', photos: [] }

test('serviceFamily classifies every junk/cleanout type as "junk"', () => {
  for (const t of JUNK_SERVICE_TYPES) assert.equal(serviceFamily(t), 'junk')
})

test('serviceFamily classifies every moving/delivery type as "moving"', () => {
  for (const t of MOVING_SERVICE_TYPES) assert.equal(serviceFamily(t), 'moving')
})

test('serviceFamily families are disjoint and cover the real lines of business', () => {
  const overlap = JUNK_SERVICE_TYPES.filter(t => MOVING_SERVICE_TYPES.includes(t))
  assert.deepEqual(overlap, [])
  assert.equal(serviceFamily('other' as ServiceType), 'other')
})

test('junk-removal Book Now maps load size, timing, add-ons + shown estimate to structured fields', () => {
  const d = buildBookNowDetail({
    ...base, serviceType: 'junk-removal',
    loadSize: 'half_truck', loadSizeLabel: 'Half Truck',
    timing: 'asap', addOnLabels: ['Heavy items (+$40)', 'Stairs (+$25)'],
    contactMethod: 'text', preferredDate: '2026-07-20',
    estimateLow: 240, estimateHigh: 380,
  })
  assert.ok(d)
  assert.equal(d!.loadSize, 'half_truck')
  assert.equal(d!.loadSizeLabel, 'Half Truck')
  assert.equal(d!.timing, 'asap')
  assert.deepEqual(d!.addOns, ['Heavy items (+$40)', 'Stairs (+$25)'])
  assert.equal(d!.contactMethod, 'text')
  assert.equal(d!.requestedDate, '2026-07-20')
  assert.equal(d!.shownEstimateLowCents, 24000)   // dollars → cents
  assert.equal(d!.shownEstimateHighCents, 38000)
})

test('moving Book Now maps timing + estimate without a load size (delivery has none)', () => {
  const d = buildBookNowDetail({
    ...base, serviceType: 'moving',
    timing: 'flexible', contactMethod: 'phone',
    estimateLow: 500, estimateHigh: 900,
  })
  assert.ok(d)
  assert.equal(d!.loadSize, undefined)
  assert.equal(d!.timing, 'flexible')
  assert.equal(d!.shownEstimateHighCents, 90000)
})

test('buildBookNowDetail returns undefined for an empty/legacy submission (no phantom block)', () => {
  assert.equal(buildBookNowDetail({ ...base }), undefined)
})

test('a bad preferredDate is dropped, not stored as a malformed field', () => {
  const d = buildBookNowDetail({ ...base, timing: 'asap', preferredDate: 'not-a-date' })
  assert.ok(d)
  assert.equal(d!.requestedDate, undefined)
})

test('a zero/absent estimate is not recorded as $0.00', () => {
  const d = buildBookNowDetail({ ...base, timing: 'asap', estimateLow: 0, estimateHigh: 0 })
  assert.ok(d)
  assert.equal(d!.shownEstimateLowCents, undefined)
  assert.equal(d!.shownEstimateHighCents, undefined)
})
