// Phase 12 — completed-job LEARNING LOOP closure. Verifies the AI-vs-quoted price
// snapshot is captured + folded into accuracy (priceMape / overrideRate), that crew
// actuals are never fabricated, that buildOutcomeFromBooking extracts the snapshot +
// version stamps from a Booking, and the isTest-never-trains invariant still holds.
//
// Hermetic: an in-memory fetch stub emulates the Upstash REST GET/SET so
// recordJobOutcome/listOutcomes/getCalibration run without a live KV.
import assert from 'node:assert/strict'
import test from 'node:test'

// ── In-memory Upstash stub (must be set up before job-learning touches redis) ──
process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'http://stub.local'
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'stub-token'
const store = new Map<string, string>()
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  const args = JSON.parse(init?.body ?? '[]') as string[]
  const [cmd, key, value] = args
  let result: unknown = null
  if (cmd === 'GET') result = store.has(key) ? store.get(key) : null
  else if (cmd === 'SET') { store.set(key, value); result = 'OK' }
  else if (cmd === 'DEL') { store.delete(key); result = 1 }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { accuracyStats, recordJobOutcome, listOutcomes, getCalibration, type JobOutcome } from '../app/lib/job-learning'
import { buildOutcomeFromBooking } from '../app/lib/outcome-capture'
import { PRICING_DECISION_VERSION } from '../app/lib/pricing/quote-decision'
import { ANALYSIS_SCHEMA_VERSION } from '../app/lib/ai/analysis-schema'

const outcome = (over: Partial<JobOutcome> = {}): JobOutcome => ({
  id: Math.random().toString(36).slice(2), date: '2026-07-14', category: 'general',
  estFillPct: 50, actualFillPct: 50, estTrips: 1, actualTrips: 1,
  estDisposalCents: 5000, actualDisposalCents: 5000, estLaborCents: 10000, actualLaborCents: 10000,
  estProfitCents: 20000, actualProfitCents: 20000, finalPriceCents: 40000,
  ...over,
} as unknown as JobOutcome)

test('accuracyStats.priceMape is a number (not null) once an outcome carries aiRecommendedCents', () => {
  const s = accuracyStats([
    outcome({ aiRecommendedCents: 30000, finalPriceCents: 40000 }), // 25% off
  ])!
  assert.equal(typeof s.priceMape, 'number')
  assert.equal(s.priceMape, 25)
})

test('overridden outcome pushes overrideRate above 0', () => {
  const s = accuracyStats([
    outcome({ aiRecommendedCents: 40000, overridden: true }),
    outcome({ aiRecommendedCents: 40000, overridden: false }),
  ])!
  assert.ok(s.overrideRate > 0)
  assert.equal(s.overrideRate, 50)
})

test('crew actuals stay undefined when unknown — never fabricated', () => {
  const snap = buildOutcomeFromBooking({
    token: 'JK-B-1', invoiceAmountCents: 45000,
    aiEstimate: { pricing: { recommendedUsd: 400 } },
  })
  assert.equal(snap.actualVolume, undefined)
  assert.equal(snap.actualWeight, undefined)
  assert.equal(snap.actualLaborHours, undefined)
  assert.equal(snap.actualCrewSize, undefined)
  assert.equal(snap.actualTruckLoads, undefined)
})

test('buildOutcomeFromBooking extracts recommendedUsd→cents, override flag + version stamps', () => {
  const snap = buildOutcomeFromBooking({
    token: 'JK-B-42', bookingNumber: 'JK-B-42', invoiceAmountCents: 52000, completedAt: 1700000000000,
    aiEstimate: { pricing: { recommendedUsd: 480 }, override: { overriddenUsd: 520, reason: 'stairs' } },
  })
  assert.equal(snap.aiRecommendedCents, 48000)      // 480 * 100
  assert.equal(snap.overridden, true)               // override present
  assert.equal(snap.adminQuotedCents, 52000)
  assert.equal(snap.finalInvoiceCents, 52000)
  assert.equal(snap.bookingId, 'JK-B-42')
  assert.equal(snap.completionTimestamp, 1700000000000)
  assert.equal(snap.pricingRuleVersion, PRICING_DECISION_VERSION)
  assert.equal(snap.estimateVersion, ANALYSIS_SCHEMA_VERSION)
})

test('a booking with no aiEstimate yields aiRecommendedCents 0 and overridden false — safe', () => {
  const snap = buildOutcomeFromBooking({ token: 'JK-B-9', invoiceAmountCents: 10000 })
  assert.equal(snap.aiRecommendedCents, 0)
  assert.equal(snap.overridden, false)
  // completely empty booking must not throw either
  const empty = buildOutcomeFromBooking(undefined)
  assert.equal(empty.aiRecommendedCents, 0)
  assert.equal(empty.overridden, false)
  assert.equal(empty.adminQuotedCents, undefined)
})

test('extras override the snapshot but never fabricate actuals', () => {
  const snap = buildOutcomeFromBooking(
    { token: 'JK-B-7', invoiceAmountCents: 30000, aiEstimate: { pricing: { recommendedUsd: 300 } } },
    { jobId: 'JOB-7', promptVersion: 'vision-2', taxonomyVersion: 'tax-3' },
  )
  assert.equal(snap.jobId, 'JOB-7')
  assert.equal(snap.promptVersion, 'vision-2')
  assert.equal(snap.taxonomyVersion, 'tax-3')
  assert.equal(snap.actualLaborHours, undefined)
})

test('isTest outcome never trains: not stored, calibration unchanged (regression)', async () => {
  store.clear()
  // A real training outcome moves the household fill bias.
  await recordJobOutcome(outcome({ category: 'general', estFillPct: 50, actualFillPct: 75 }))
  const afterReal = await getCalibration()
  const realBias = afterReal.fillBias['general']
  const realSamples = afterReal.samples['general']
  assert.ok(realBias != null)
  const histLen = (await listOutcomes(250)).length

  // A sandbox outcome must NOT enter history NOR move calibration.
  await recordJobOutcome(outcome({ isTest: true, category: 'general', estFillPct: 50, actualFillPct: 10 }))
  const afterTest = await getCalibration()
  assert.equal(afterTest.fillBias['general'], realBias)
  assert.equal(afterTest.samples['general'], realSamples)
  assert.equal((await listOutcomes(250)).length, histLen)
})
