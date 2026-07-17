// Crew weekly availability — server-side normalization + week anchoring. Pure.
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDays, normalizeWeekStart, weekDates, emptyDays, DOW_KEYS } from '../app/lib/crew-availability'

test('an empty week is all-unavailable with no times', () => {
  const d = emptyDays()
  for (const k of DOW_KEYS) {
    assert.equal(d[k].available, false)
    assert.equal(d[k].start, undefined)
  }
})

test('normalizeDays keeps times only for available days and defaults a window', () => {
  const out = normalizeDays({
    mon: { available: true, start: '06:00', end: '14:00' },
    tue: { available: true },                       // no times → defaults
    wed: { available: false, start: '06:00' },      // not available → times dropped
  })
  assert.deepEqual(out.mon, { available: true, start: '06:00', end: '14:00' })
  assert.deepEqual(out.tue, { available: true, start: '08:00', end: '17:00' }, 'defaults filled')
  assert.deepEqual(out.wed, { available: false }, 'times dropped when unavailable')
  assert.deepEqual(out.thu, { available: false }, 'omitted day defaults to unavailable')
})

test('normalizeDays rejects an end that is not after start (falls back to defaults)', () => {
  const out = normalizeDays({ fri: { available: true, start: '17:00', end: '09:00' } })
  assert.deepEqual(out.fri, { available: true, start: '08:00', end: '17:00' })
})

test('normalizeDays coerces junk input to a safe empty week', () => {
  const out = normalizeDays('not an object')
  for (const k of DOW_KEYS) assert.deepEqual(out[k], { available: false })
})

test('normalizeWeekStart anchors any day to its Monday', () => {
  // 2026-07-17 is a Friday → Monday is 2026-07-13.
  assert.equal(normalizeWeekStart('2026-07-17'), '2026-07-13')
  assert.equal(normalizeWeekStart('2026-07-13'), '2026-07-13', 'a Monday maps to itself')
  assert.equal(normalizeWeekStart('2026-07-19'), '2026-07-13', 'Sunday still maps back to Monday')
})

test('weekDates lays out Mon..Sun from the week start', () => {
  const dates = weekDates('2026-07-13')
  assert.equal(dates.mon, '2026-07-13')
  assert.equal(dates.sun, '2026-07-19')
})
