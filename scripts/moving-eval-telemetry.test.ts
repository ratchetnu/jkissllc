// ── Moving evaluation telemetry ──────────────────────────────────────────────
// The moving lane returns early from /api/quote/analyze, so it used to skip the
// telemetry block entirely: a moving benchmark run would have produced latency
// and decisions but no truck-space fraction, no confidence sub-scores and no
// join key — spending real credits to learn less than the junk lane already does.
//
// These tests pin the record's CONTENT and its boundaries. No Redis, no clock.
// Run: npx tsx --test scripts/moving-eval-telemetry.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  buildMovingEvaluationRecord, evalJobType, evalTelemetryEnabled,
} from '../app/lib/ai/eval-telemetry'
import { normalizeMovingAnalysis, type NormalizeMovingCtx } from '../app/lib/ai/analysis-schema-moving'
import { decideMovingQuote } from '../app/lib/pricing/moving-decision'
import { DEFAULT_MOVING, type MovingJobFacts } from '../app/lib/pricing/moving-quote'
import { customerMovingEstimateView, type StoredMovingEstimate } from '../app/lib/ai/moving-estimate'

const ctx = (): NormalizeMovingCtx => ({
  analysisId: 'mv-analysis-0001', bookingId: 'draft', photoUrls: ['https://x/1.jpg', 'https://x/2.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-05T00:00:00Z',
})

const raw = (over: Record<string, unknown> = {}) => ({
  normalizedItems: [
    { category: 'furniture', label: 'sectional sofa', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'large', estimatedVolumeCubicFeet: 90, bulky: true, fragile: false, requiresDisassembly: true, isAppliance: false, confidence: 0.9, evidence: 'centre of room' },
    { category: 'appliance', label: 'washer', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'large', estimatedVolumeCubicFeet: 30, bulky: true, fragile: false, requiresDisassembly: false, isAppliance: true, confidence: 0.85, evidence: 'utility corner' },
  ],
  photoObservations: [{ photoUrl: 'https://x/1.jpg', visibleItems: [], possibleDuplicateViewOfOtherPhoto: false, imageQuality: 'good' }],
  boxCount: { minimum: 10, likely: 14, maximum: 18 },
  totalEstimatedVolumeCubicFeet: { minimum: 150, likely: 200, maximum: 260 },
  estimatedTruckSpaceFraction: { minimum: 0.15, likely: 0.2, maximum: 0.3 },
  recommendedCrewSize: { minimum: 2, likely: 2, maximum: 3 },
  estimatedLoadingHours: { minimum: 1.5, likely: 2, maximum: 3 },
  estimatedUnloadingHours: { minimum: 1, likely: 1.5, maximum: 2 },
  access: { stairsVisible: true, elevatorVisible: false, longCarryLikely: false, narrowAccess: false, disassemblyRequired: true, applianceHandling: true, fragileHandling: false, oversizedItemPresent: false },
  confidence: { overall: 0.85, inventory: 0.8, volume: 0.8, access: 0.7, labor: 0.75 },
  missingInformation: [], additionalQuestions: [], warnings: [], reviewRequired: false, reviewReasons: [],
  ...over,
})

const COMPLETE = { travelMiles: 12, originStairsFlights: 0, destinationStairsFlights: 0, destinationKnown: true }

/** Build a stored moving estimate the way buildMovingEstimate does. */
function stored(over: Record<string, unknown> = {}, facts: MovingJobFacts = COMPLETE): StoredMovingEstimate {
  const a = normalizeMovingAnalysis(raw(over), ctx())
  const d = decideMovingQuote({ analysis: a, settings: DEFAULT_MOVING, facts })
  return {
    id: 'mv-analysis-0001', createdAt: '2026-08-05T00:00:00Z', lane: 'moving',
    status: d.decision === 'manual_review' ? 'review' : 'completed', decision: d.decision,
    provider: 'vercel-ai-gateway', model: 'test-model', schemaVersion: a.schemaVersion,
    callId: 'call-abc-123', latencyMs: 4200,
    inputPhotoUrls: ['https://x/1.jpg', 'https://x/2.jpg'], analysis: a,
    pricing: {
      recommendedUsd: d.recommendedUsd, lowUsd: d.rangeUsd.low, highUsd: d.rangeUsd.high,
      priced: d.priced, decisionVersion: d.decisionVersion, crewSize: d.quote.crewSize,
      laborHours: d.quote.laborHours, costLines: d.quote.breakdown,
      sellingPriceCents: d.quote.sellingPriceCents, minimumApplied: d.quote.minimumApplied,
    },
    reviewReasons: d.reviewReasons, missingInformation: d.missingInformation,
  }
}

const build = (s: StoredMovingEstimate, over: Partial<Parameters<typeof buildMovingEvaluationRecord>[0]> = {}) =>
  buildMovingEvaluationRecord({
    stored: s, serviceType: 'moving', imageCount: 2, analyzedOk: true, outcome: 'ok',
    totalLatencyMs: 5100, at: '2026-08-05T00:00:00Z', ...over,
  })

// ── coverage across every decision ───────────────────────────────────────────

test('a successful moving analysis records the full benchmark record', () => {
  const s = stored()
  assert.equal(s.decision, 'instant_quote')
  const r = build(s)

  assert.equal(r.jobType, 'moving')
  assert.equal(r.analysisId, 'mv-analysis-0001')
  assert.equal(r.imageCount, 2)
  assert.equal(r.provider, 'vercel-ai-gateway')
  assert.equal(r.model, 'test-model')
  assert.equal(r.aiCallId, 'call-abc-123', 'the join key must be present or the record is unusable')
  assert.equal(r.modelLatencyMs, 4200)
  assert.equal(r.totalLatencyMs, 5100, 'total latency is distinct from the provider round-trip')

  // The internals the customer response does not carry.
  assert.deepEqual(r.truckSpaceFraction, { minimum: 0.15, likely: 0.2, maximum: 0.3 })
  assert.deepEqual(r.crewSize, { minimum: 2, likely: 2, maximum: 3 })
  assert.deepEqual(r.loadingHours, { minimum: 1.5, likely: 2, maximum: 3 })
  assert.deepEqual(r.unloadingHours, { minimum: 1, likely: 1.5, maximum: 2 })
  assert.deepEqual(r.boxCount, { minimum: 10, likely: 14, maximum: 18 })
  assert.equal(r.estimatedVolumeCubicFeet.likely, 200)
  assert.equal(r.itemCount, 2)
  assert.equal(r.detectedItems[0].sizeClass, 'large')
  assert.equal(r.detectedItems[1].isAppliance, true)
  assert.equal(r.access.stairsVisible, true)
  assert.deepEqual(r.confidence, { overall: 0.85, inventory: 0.8, volume: 0.8, access: 0.7, labor: 0.75 })
  assert.equal(r.decision, 'instant_quote')
  assert.equal(r.priced, true)
  assert.ok(r.recommendedUsd > 0)
})

test('needs_information records evaluation, with the missing fields named', () => {
  const s = stored({}, { destinationKnown: false })
  assert.equal(s.decision, 'needs_information')
  const r = build(s)
  assert.equal(r.decision, 'needs_information')
  assert.ok(r.missingInformation.includes('Destination address'))
  assert.ok(r.lowUsd > 0, 'a bounded range is still recorded while we wait for the facts')
  assert.equal(r.recommendedUsd, 0)
})

test('manual_review records evaluation — the failure cases are the ones worth measuring', () => {
  const s = stored({
    normalizedItems: [{ category: 'oversized_specialty', label: 'upright piano', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'oversized', estimatedVolumeCubicFeet: 70, bulky: true, fragile: true, requiresDisassembly: false, isAppliance: false, confidence: 0.9, evidence: 'against wall' }],
  })
  assert.equal(s.decision, 'manual_review')
  const r = build(s, { analyzedOk: false, outcome: 'empty_read' })
  assert.equal(r.decision, 'manual_review')
  assert.equal(r.analyzedOk, false)
  assert.equal(r.outcome, 'empty_read')
  assert.equal(r.priced, false)
  assert.ok(r.reviewReasons.length > 0, 'why it went to a human is part of the record')
})

// ── boundaries ───────────────────────────────────────────────────────────────

test('token, cost, attempts and retries are NOT copied — they join by callId', () => {
  const r = build(stored()) as unknown as Record<string, unknown>
  for (const dup of ['inputTokens', 'outputTokens', 'totalTokens', 'estCostUsd', 'actualCostUsd', 'attempts', 'retries', 'responseValid']) {
    assert.ok(!(dup in r), `${dup} must live only on the AI call record — a second copy can drift`)
  }
  assert.equal((r as { aiCallId?: string }).aiCallId, 'call-abc-123')
})

test('the moving record carries no junk-lane fields, and vice versa', () => {
  const r = build(stored()) as unknown as Record<string, unknown>
  // A move has no landfill trip, no debris weight, no truck-load COUNT.
  for (const junkOnly of ['truckUtilizationPct', 'estimatedTruckLoads', 'estimatedVolumeCubicYards', 'monitorForceReview', 'monitorConcerns', 'debris']) {
    assert.ok(!(junkOnly in r), `${junkOnly} is a junk-lane field and must not appear on a moving record`)
  }
  assert.equal(r.jobType, 'moving', 'jobType discriminates the two records')
})

test('the moving lane records that NO critic ran, rather than omitting it', () => {
  const r = build(stored())
  assert.equal(r.criticInvoked, false)
  assert.match(r.criticTrigger, /no second vision pass/i)
  assert.equal(r.criticLatencyMs, 0)
})

test('gating is unchanged: OFF by default, impossible in Production', () => {
  assert.equal(evalTelemetryEnabled({} as NodeJS.ProcessEnv), false)
  assert.equal(evalTelemetryEnabled({ AI_EVAL_TELEMETRY_ENABLED: '1', VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv), false,
    'the Production guard outranks the flag for moving exactly as it does for junk')
  assert.equal(evalTelemetryEnabled({ AI_EVAL_TELEMETRY_ENABLED: '1', VERCEL_ENV: 'preview' } as unknown as NodeJS.ProcessEnv), true)
  assert.equal(evalJobType('moving'), 'moving')
})

// ── the customer response must not move ──────────────────────────────────────

test('the customer response shape is unchanged by telemetry', () => {
  const s = stored()
  const before = JSON.stringify(customerMovingEstimateView(s))
  build(s)   // building the record must not mutate the estimate
  const after = JSON.stringify(customerMovingEstimateView(s))
  assert.equal(before, after, 'telemetry is a read of the estimate, never a write to it')

  const view = customerMovingEstimateView(s) as unknown as Record<string, unknown>
  for (const internal of ['aiCallId', 'callId', 'modelLatencyMs', 'totalLatencyMs', 'model', 'provider', 'costLines', 'sellingPriceCents']) {
    assert.ok(!(internal in view), `${internal} must never reach the customer`)
  }
})

test('the route schedules moving telemetry after the response, and fail-soft', () => {
  const src = readFileSync(new URL('../app/api/quote/analyze/route.ts', import.meta.url), 'utf8')
  const movingBranch = src.slice(src.indexOf("serviceFamily(serviceType) === 'moving'"), src.indexOf('// The full AI → monitor'))

  assert.ok(movingBranch.includes('buildMovingEvaluationRecord'), 'the moving branch must record evaluation')
  assert.ok(movingBranch.includes('afterResponse('), 'writes run after the response so they cannot inflate measured latency')
  // A telemetry failure must never reach the quote — the same contract as junk.
  assert.ok(/catch \(e\) \{ console\.error\('\[quote\/analyze\] moving eval telemetry'/.test(movingBranch),
    'the moving telemetry write must be wrapped in a catch')
  // Built from `stored`, not from the flag-withheld projection: measure what the
  // lane produced, not what the customer was shown.
  assert.ok(/buildMovingEvaluationRecord\(\{\s*\n?\s*stored,/.test(movingBranch))
})

test('junk telemetry is untouched', () => {
  const src = readFileSync(new URL('../app/api/quote/analyze/route.ts', import.meta.url), 'utf8')
  const junkBranch = src.slice(src.indexOf('// The full AI → monitor'))
  assert.ok(junkBranch.includes('buildEvaluationRecord('), 'the junk record builder is still called')
  assert.ok(!junkBranch.includes('buildMovingEvaluationRecord'), 'the junk branch must not build a moving record')
})
