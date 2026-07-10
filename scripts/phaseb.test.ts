// Phase B pure-logic tests: time-off 24-hour policy, crew-score factor breakdown,
// and availability day normalization. No Redis — pure functions only.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isLateRequest } from '../app/lib/timeoff'
import { buildCrewScore, scoreBand, type ScoreStats } from '../app/lib/crew-score'

// ── 24-hour time-off policy ──────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000
// Fixed "now": 2026-07-10 12:00 UTC.
const NOW = Date.UTC(2026, 6, 10, 12, 0)

test('a request for tomorrow is NOT late', () => {
  // 2026-07-12 is ~1.5+ days out → not late.
  assert.equal(isLateRequest('2026-07-12', undefined, NOW), false)
})

test('a request for later today IS late', () => {
  // full-day 2026-07-10 midnight Central is already within 24h → late.
  assert.equal(isLateRequest('2026-07-10', undefined, NOW), true)
})

test('a partial request just under 24h away is late; just over is not', () => {
  // start 2026-07-11 at 16:00 Central (= 21:00 UTC) is ~33h away → not late.
  assert.equal(isLateRequest('2026-07-11', '16:00', NOW), false)
  // start 2026-07-11 at 08:00 Central (= 13:00 UTC) is ~25h away → not late (just over).
  assert.equal(isLateRequest('2026-07-11', '08:00', NOW), false)
  // start 2026-07-11 at 06:00 Central (= 11:00 UTC) is ~23h away → late.
  assert.equal(isLateRequest('2026-07-11', '06:00', NOW), true)
})

// ── Crew Score factor breakdown ──────────────────────────────────────────────
const stats = (o: Partial<ScoreStats>): ScoreStats =>
  ({ assignments: 0, confirmed: 0, completed: 0, declined: 0, noResponse: 0, noShow: 0, score: null, ...o })

test('no history → null composite and every factor null', () => {
  const cs = buildCrewScore(undefined)
  assert.equal(cs.score, null)
  assert.equal(cs.band, 'No data')
  assert.ok(cs.factors.every(f => f.score === null))
})

test('acceptance factor reflects confirmed+completed over decisions', () => {
  const cs = buildCrewScore(stats({ assignments: 10, confirmed: 3, completed: 5, declined: 2, score: 80 }))
  const acc = cs.factors.find(f => f.key === 'acceptance')!
  // (3+5)/(3+5+2) = 8/10 = 80
  assert.equal(acc.score, 80)
  assert.equal(cs.score, 80) // composite passes through the route-stats score
})

test('reliability drops with no-shows', () => {
  const cs = buildCrewScore(stats({ assignments: 4, completed: 3, noShow: 1, score: 55 }))
  const rel = cs.factors.find(f => f.key === 'reliability')!
  assert.equal(rel.score, 75) // 100 - 25
})

test('extras feed availability + incident factors; otherwise not measured', () => {
  const base = buildCrewScore(stats({ assignments: 2, completed: 2, score: 90 }))
  assert.equal(base.factors.find(f => f.key === 'availability')!.score, null)
  assert.equal(base.factors.find(f => f.key === 'incidents')!.score, null)

  const enriched = buildCrewScore(stats({ assignments: 2, completed: 2, score: 90 }), { availabilityWeeksSubmitted: 2, availabilityWeeksExpected: 4, incidents: 1 })
  assert.equal(enriched.factors.find(f => f.key === 'availability')!.score, 50) // 2/4
  assert.equal(enriched.factors.find(f => f.key === 'incidents')!.score, 80)     // 100 - 20
})

test('scoreBand thresholds', () => {
  assert.equal(scoreBand(null), 'No data')
  assert.equal(scoreBand(90), 'Strong')
  assert.equal(scoreBand(70), 'Fair')
  assert.equal(scoreBand(40), 'Needs attention')
})
