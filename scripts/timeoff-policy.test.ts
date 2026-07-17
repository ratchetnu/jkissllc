// Time-off — the 24-hour "late request" policy. Pure, timezone-aware.
import assert from 'node:assert/strict'
import test from 'node:test'
import { isLateRequest } from '../app/lib/timeoff'

// Reference "now": 2026-07-17 12:00 UTC (= 07:00 Central CDT).
const NOW = Date.UTC(2026, 6, 17, 12, 0)

test('a full-day request more than 24h out is not late', () => {
  // Start of 2026-07-19 (Central midnight ≈ 05:00 UTC) is > 24h from NOW.
  assert.equal(isLateRequest('2026-07-19', undefined, NOW), false)
})

test('a full-day request for today/tomorrow within 24h is late', () => {
  assert.equal(isLateRequest('2026-07-17', undefined, NOW), true, 'today is within 24h')
  // Tomorrow's Central midnight is 2026-07-18 05:00 UTC → ~17h away → late.
  assert.equal(isLateRequest('2026-07-18', undefined, NOW), true)
})

test('a partial-day request uses its start time for the 24h test', () => {
  // 2026-07-18 18:00 Central = 2026-07-18 23:00 UTC → ~35h from NOW → not late.
  assert.equal(isLateRequest('2026-07-18', '18:00', NOW), false)
  // 2026-07-18 08:00 Central = 13:00 UTC → ~25h → not late (just over the line).
  assert.equal(isLateRequest('2026-07-18', '08:00', NOW), false)
  // 2026-07-18 06:00 Central = 11:00 UTC → ~23h → late.
  assert.equal(isLateRequest('2026-07-18', '06:00', NOW), true)
})

test('a malformed date is never flagged late (server still validates elsewhere)', () => {
  assert.equal(isLateRequest('not-a-date', undefined, NOW), false)
})
