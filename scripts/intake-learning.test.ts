// Learning-loop closure: AI-estimate-vs-final + override rate in accuracyStats,
// acceptance rate, and the pricing-calibration-drift insight. Hermetic/pure.
import assert from 'node:assert/strict'
import test from 'node:test'

import { accuracyStats, type JobOutcome } from '../app/lib/job-learning'
import { acceptanceRate } from '../app/lib/intake-metrics'
import { pricingCalibrationDrift } from '../app/lib/platform/intelligence/generators'

const outcome = (over: Partial<JobOutcome> = {}): JobOutcome => ({
  id: '1', date: '2026-07-13', category: 'household',
  estFillPct: 50, actualFillPct: 50, estTrips: 1, actualTrips: 1,
  estDisposalCents: 5000, actualDisposalCents: 5000, estLaborCents: 10000, actualLaborCents: 10000,
  estProfitCents: 20000, actualProfitCents: 20000, finalPriceCents: 40000,
  ...over,
} as unknown as JobOutcome)

test('accuracyStats captures AI-estimate-vs-final price error and override rate', () => {
  const s = accuracyStats([
    outcome({ aiRecommendedCents: 30000, finalPriceCents: 40000, overridden: true }),  // 25% off
    outcome({ aiRecommendedCents: 50000, finalPriceCents: 40000, overridden: false }), // 25% off
  ])!
  assert.equal(s.priceMape, 25)
  assert.equal(s.overrideRate, 50)
})

test('accuracyStats priceMape is null when no job carried an AI recommendation', () => {
  const s = accuracyStats([outcome({}), outcome({})])!
  assert.equal(s.priceMape, null)
})

test('acceptanceRate is a safe ratio', () => {
  assert.equal(acceptanceRate(10, 2), 0.2)
  assert.equal(acceptanceRate(0, 0), 0)
  assert.equal(acceptanceRate(5, 9), 1) // clamped
})

test('pricingCalibrationDrift flags drift and low acceptance', () => {
  const drift = pricingCalibrationDrift({ jobs: 6, priceMapePct: 45, quotesGenerated: 5, quotesAccepted: 3 }, 1000)
  assert.equal(drift.length, 1)
  assert.equal(drift[0].id, 'insight:pricing-drift')
  assert.equal(drift[0].severity, 'high')

  const low = pricingCalibrationDrift({ jobs: 2, priceMapePct: 50, quotesGenerated: 20, quotesAccepted: 1 }, 1000)
  assert.equal(low.length, 1) // jobs<5 → no drift; rate 5% → low-acceptance
  assert.equal(low[0].id, 'insight:low-acceptance')

  const clean = pricingCalibrationDrift({ jobs: 10, priceMapePct: 10, quotesGenerated: 20, quotesAccepted: 15 }, 1000)
  assert.equal(clean.length, 0)
})
