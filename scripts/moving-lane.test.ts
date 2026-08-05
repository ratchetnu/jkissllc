// ── Moving lane ──────────────────────────────────────────────────────────────
// The property under test, stated once: a moving job is never touched by the
// disposal engine. Not by fallback, not by default, not when the flag is off, and
// not when the model returns garbage. Everything below is a way of trying to make
// that happen and failing.
//
// Deterministic only — mocked model output, no provider, no Redis.
// Run: npx tsx --test scripts/moving-lane.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeMovingAnalysis, reviewFallbackMovingAnalysis,
  MOVING_ANALYSIS_SCHEMA_VERSION, type NormalizeMovingCtx,
} from '../app/lib/ai/analysis-schema-moving'
import { priceMove, DEFAULT_MOVING } from '../app/lib/pricing/moving-quote'
import { decideMovingQuote, missingRequiredFacts } from '../app/lib/pricing/moving-decision'
import { customerMovingEstimateView, type StoredMovingEstimate } from '../app/lib/ai/moving-estimate'
import { getPrompt } from '../app/lib/ai/prompts'
import { serviceFamily, MOVING_SERVICE_TYPES, JUNK_SERVICE_TYPES, SERVICE_TYPES } from '../app/lib/bookings'

const ctx = (): NormalizeMovingCtx => ({
  analysisId: 'm1', bookingId: 'b1', photoUrls: ['https://x/1.jpg', 'https://x/2.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-04T00:00:00Z',
})

const movingRaw = (over: Record<string, unknown> = {}) => ({
  normalizedItems: [
    { category: 'furniture', label: 'sectional sofa', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'large', estimatedVolumeCubicFeet: 90, bulky: true, fragile: false, requiresDisassembly: true, isAppliance: false, confidence: 0.9, evidence: 'centre of room' },
    { category: 'box_container', label: 'moving boxes', quantity: { minimum: 10, likely: 14, maximum: 18 }, sizeClass: 'small', estimatedVolumeCubicFeet: 3, bulky: false, fragile: false, requiresDisassembly: false, isAppliance: false, confidence: 0.8, evidence: 'stacked by wall' },
    { category: 'appliance', label: 'washer', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'large', estimatedVolumeCubicFeet: 30, bulky: true, fragile: false, requiresDisassembly: false, isAppliance: true, confidence: 0.85, evidence: 'utility corner' },
  ],
  photoObservations: [{ photoUrl: 'https://x/1.jpg', visibleItems: [], possibleDuplicateViewOfOtherPhoto: false, imageQuality: 'good' }],
  boxCount: { minimum: 10, likely: 14, maximum: 18 },
  totalEstimatedVolumeCubicFeet: { minimum: 150, likely: 200, maximum: 260 },
  estimatedTruckSpaceFraction: { minimum: 0.15, likely: 0.2, maximum: 0.3 },
  recommendedCrewSize: { minimum: 2, likely: 2, maximum: 3 },
  estimatedLoadingHours: { minimum: 1.5, likely: 2, maximum: 3 },
  estimatedUnloadingHours: { minimum: 1, likely: 1.5, maximum: 2 },
  access: { stairsVisible: false, elevatorVisible: false, longCarryLikely: false, narrowAccess: false, disassemblyRequired: true, applianceHandling: true, fragileHandling: false, oversizedItemPresent: false },
  confidence: { overall: 0.85, inventory: 0.8, volume: 0.8, access: 0.7, labor: 0.75 },
  missingInformation: [], additionalQuestions: [], warnings: [], reviewRequired: false, reviewReasons: [],
  ...over,
})

/** Every fact a move needs before it can be quoted as a number. */
const completeFacts = { travelMiles: 12, originStairsFlights: 0, destinationStairsFlights: 0, destinationKnown: true }

// ── routing ──────────────────────────────────────────────────────────────────

test('[routing] the service family, not the caller, picks the lane', () => {
  for (const t of MOVING_SERVICE_TYPES) assert.equal(serviceFamily(t), 'moving', `${t} must route to the moving lane`)
  for (const t of JUNK_SERVICE_TYPES) assert.equal(serviceFamily(t), 'junk', `${t} must route to the junk lane`)
  // Every declared service resolves to exactly one known family — no unrouted type.
  for (const t of SERVICE_TYPES) assert.ok(['junk', 'moving', 'other'].includes(serviceFamily(t)))
})

test('[routing] an unsupported job type fails safely to the guarded lane', () => {
  // 'other' is neither family: it must NOT reach the moving engine. The route's
  // own fallback sends unknown services to junk-removal, which is the lane with
  // the review gates — conservative by construction.
  assert.equal(serviceFamily('other'), 'other')
  assert.notEqual(serviceFamily('other'), 'moving')
})

test('[routing] the moving prompt is registered and free of disposal vocabulary', () => {
  const { system } = getPrompt('ops.movingAnalysis').build({})
  // Disposal words may appear ONLY inside an explicit negation ("NOT going to a
  // landfill", "never estimate disposal"). Those steer the model away from the junk
  // framing and are the point. A bare mention would be the prompt drifting back
  // toward treating a family's furniture as material to be hauled off.
  for (const word of ['landfill', 'dump', 'disposal', 'debris', 'junk', 'discard']) {
    for (const m of system.matchAll(new RegExp(word, 'gi'))) {
      const around = system.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + word.length + 20)
      assert.match(around, /\b(not|never|no)\b/i,
        `"${word}" appears in the moving prompt outside a negation: …${around.trim()}…`)
    }
  }
  assert.ok(/relocat/i.test(system), 'the moving prompt must frame the job as a move')
  assert.ok(!/estimatedTruckLoadFraction/.test(system), 'the moving prompt must not use the junk lane field name')
})

// ── schema ───────────────────────────────────────────────────────────────────

test('[schema] a valid moving read normalizes without forcing review', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  assert.equal(a.schemaVersion, MOVING_ANALYSIS_SCHEMA_VERSION)
  assert.equal(a.normalizedItems.length, 3)
  assert.equal(a.normalizedItems[0].catalogId, 'sectional')
  assert.deepEqual(a.normalizedItems[0].catalogVolumeCubicFeet, { minimum: 130, maximum: 210 })
  assert.ok(a.normalizedItems[0].operationalHandlingFlags?.includes('requires_disassembly'))
  assert.equal(a.normalizedItems[2].isAppliance, true)
  assert.equal(a.reviewRequired, false)
  assert.equal(a.boxCount.likely, 14)
  assert.ok(a.estimatedTruckSpaceFraction.likely > 0)
})

test('[schema] catalog disagreement preserves model volume and forces review', () => {
  const a = normalizeMovingAnalysis(movingRaw({ normalizedItems: [{
    category: 'appliance', label: 'refrigerator', quantity: 1, sizeClass: 'large',
    estimatedVolumeCubicFeet: 10, confidence: 0.9,
  }] }), ctx())
  assert.equal(a.normalizedItems[0].estimatedVolumeCubicFeet, 10)
  assert.equal(a.normalizedItems[0].catalogAgreement, 0.55)
  assert.equal(a.reviewRequired, true)
  assert.ok(a.reviewReasons.some(reason => /operational catalog/i.test(reason)))
})

test('[schema] quantity, crew and labor ranges stay ordered and bounded', () => {
  // A model that inverts a range, or returns a bare number, must not corrupt the
  // positional reads downstream pricing does.
  const a = normalizeMovingAnalysis(movingRaw({
    recommendedCrewSize: { minimum: 9, likely: 2, maximum: 1 },
    estimatedLoadingHours: 3,
    boxCount: { minimum: 5, likely: 900, maximum: 7 },
  }), ctx())
  assert.ok(a.recommendedCrewSize.minimum <= a.recommendedCrewSize.likely)
  assert.ok(a.recommendedCrewSize.likely <= a.recommendedCrewSize.maximum)
  assert.ok(a.recommendedCrewSize.maximum <= 8, 'crew size is capped')
  assert.deepEqual(a.estimatedLoadingHours, { minimum: 3, likely: 3, maximum: 3 }, 'a bare number widens to a range')
  assert.ok(a.boxCount.minimum <= a.boxCount.likely && a.boxCount.likely <= a.boxCount.maximum)
})

test('[schema] a self-contradicting read resolves toward MORE care', () => {
  const a = normalizeMovingAnalysis(movingRaw({
    access: { stairsVisible: false, elevatorVisible: false, longCarryLikely: false, narrowAccess: false, disassemblyRequired: false, applianceHandling: false, fragileHandling: false, oversizedItemPresent: false },
  }), ctx())
  // The items say disassembly + appliance; the access block said no. Items win.
  assert.equal(a.access.disassemblyRequired, true)
  assert.equal(a.access.applianceHandling, true)
})

test('[schema] invalid output fails safely, never as a zero-volume success', () => {
  for (const bad of ['not json', '', '{"broken":', null, 42]) {
    const a = normalizeMovingAnalysis(bad, ctx())
    assert.equal(a.reviewRequired, true, `"${String(bad)}" must force review`)
    assert.equal(a.normalizedItems.length, 0)
  }
  const fb = reviewFallbackMovingAnalysis(ctx(), ['provider down'])
  assert.equal(fb.reviewRequired, true)
  assert.equal(fb.estimatedTruckSpaceFraction.likely, 0)
})

// ── pricing ──────────────────────────────────────────────────────────────────

test('[pricing] a move is priced on labor, crew, travel and access', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const q = priceMove({ settings: DEFAULT_MOVING, analysis: a, facts: completeFacts })
  assert.ok(q.low > 0 && q.high >= q.low)
  assert.equal(q.crewSize, 2)
  const labels = q.breakdown.map(l => l.label).join(' | ')
  assert.match(labels, /Crew \(2 movers/)
  assert.match(labels, /Travel \(12 mi\)/)
  assert.match(labels, /Disassembly/)
  assert.match(labels, /Appliance handling/)
})

test('[pricing] NO dump, landfill or disposal cost can appear in a move', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const q = priceMove({ settings: DEFAULT_MOVING, analysis: a, facts: completeFacts })
  const text = JSON.stringify(q).toLowerCase()
  for (const banned of ['landfill', 'dump', 'disposal', 'debris', 'tipping']) {
    assert.ok(!text.includes(banned), `a moving quote must never contain "${banned}"`)
  }
})

test('[pricing] stairs and elevator modifiers behave', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const flat = priceMove({ settings: DEFAULT_MOVING, analysis: a, facts: completeFacts })
  const stairs = priceMove({ settings: DEFAULT_MOVING, analysis: a, facts: { ...completeFacts, originStairsFlights: 2 } })
  const elevator = priceMove({ settings: DEFAULT_MOVING, analysis: a, facts: { ...completeFacts, elevatorRequired: true } })
  assert.ok(stairs.costBasisCents > flat.costBasisCents, 'two flights of stairs cost more than none')
  assert.equal(stairs.costBasisCents - flat.costBasisCents, 2 * DEFAULT_MOVING.stairsPerFlightCents)
  assert.equal(elevator.costBasisCents - flat.costBasisCents, DEFAULT_MOVING.elevatorCents)
})

test('[pricing] the minimum charge and minimum hours both apply', () => {
  const tiny = normalizeMovingAnalysis(movingRaw({
    normalizedItems: [{ category: 'furniture', label: 'chair', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'small', estimatedVolumeCubicFeet: 8, bulky: false, fragile: false, requiresDisassembly: false, isAppliance: false, confidence: 0.9, evidence: 'one chair' }],
    estimatedLoadingHours: { minimum: 0.2, likely: 0.25, maximum: 0.3 },
    estimatedUnloadingHours: { minimum: 0.2, likely: 0.25, maximum: 0.3 },
    access: { stairsVisible: false, elevatorVisible: false, longCarryLikely: false, narrowAccess: false, disassemblyRequired: false, applianceHandling: false, fragileHandling: false, oversizedItemPresent: false },
  }), ctx())
  const q = priceMove({ settings: DEFAULT_MOVING, analysis: tiny, facts: completeFacts })
  assert.ok(q.laborHours.likely >= DEFAULT_MOVING.minimumHours, 'billed hours never fall below the minimum')
  assert.ok(q.sellingPriceCents >= DEFAULT_MOVING.minimumChargeCents)
})

test('[pricing] tenant configuration is isolated — rates drive the price', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const cheap = priceMove({ settings: DEFAULT_MOVING, analysis: a, facts: completeFacts })
  const pricey = priceMove({ settings: { ...DEFAULT_MOVING, crewRatePerHourCents: 13000 }, analysis: a, facts: completeFacts })
  assert.ok(pricey.sellingPriceCents > cheap.sellingPriceCents, 'doubling the crew rate must move the price')
})

// ── decision contract ────────────────────────────────────────────────────────

test('[decision] a complete, confident move quotes instantly', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const d = decideMovingQuote({ analysis: a, settings: DEFAULT_MOVING, facts: completeFacts })
  assert.equal(d.decision, 'instant_quote')
  assert.equal(d.priced, true)
  assert.ok(d.recommendedUsd > 0)
})

test('[decision] a missing NON-VISUAL fact asks instead of inventing', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const d = decideMovingQuote({ analysis: a, settings: DEFAULT_MOVING, facts: { destinationKnown: false, travelMiles: undefined } })
  assert.equal(d.decision, 'needs_information')
  assert.ok(d.missingInformation.includes('Destination address'))
  assert.ok(d.missingInformation.includes('Travel distance between addresses'))
  // Still bounded — the customer sees a range, not silence and not a fake number.
  assert.ok(d.rangeUsd.low > 0)
  assert.equal(d.recommendedUsd, 0, 'no single confident number without the facts')
})

test('[decision] low confidence ranges; oversized and multi-truck go to a human', () => {
  const low = normalizeMovingAnalysis(movingRaw({ confidence: { overall: 0.5, inventory: 0.5, volume: 0.5, access: 0.5, labor: 0.5 } }), ctx())
  assert.equal(decideMovingQuote({ analysis: low, settings: DEFAULT_MOVING, facts: completeFacts }).decision, 'estimate_range')

  const piano = normalizeMovingAnalysis(movingRaw({
    normalizedItems: [{ category: 'oversized_specialty', label: 'upright piano', quantity: { minimum: 1, likely: 1, maximum: 1 }, sizeClass: 'oversized', estimatedVolumeCubicFeet: 70, bulky: true, fragile: true, requiresDisassembly: false, isAppliance: false, confidence: 0.9, evidence: 'against wall' }],
  }), ctx())
  assert.equal(decideMovingQuote({ analysis: piano, settings: DEFAULT_MOVING, facts: completeFacts }).decision, 'manual_review')

  const huge = normalizeMovingAnalysis(movingRaw({ estimatedTruckSpaceFraction: { minimum: 2.2, likely: 2.6, maximum: 3 } }), ctx())
  assert.equal(decideMovingQuote({ analysis: huge, settings: DEFAULT_MOVING, facts: completeFacts }).decision, 'manual_review')
})

test('[decision] a failed analysis never produces a price', () => {
  const dead = reviewFallbackMovingAnalysis(ctx(), ['provider down'])
  const d = decideMovingQuote({ analysis: dead, settings: DEFAULT_MOVING, facts: completeFacts })
  assert.equal(d.decision, 'manual_review')
  assert.equal(d.priced, false)
  assert.equal(d.recommendedUsd, 0)
  assert.deepEqual(d.rangeUsd, { low: 0, high: 0 })
})

test('[decision] missingRequiredFacts only asks for what a photo cannot show', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  assert.deepEqual(missingRequiredFacts(completeFacts, a), [])
  // Visible stairs answer the stairs question without asking the customer.
  const withStairs = normalizeMovingAnalysis(movingRaw({
    access: { ...movingRaw().access, stairsVisible: true },
  }), ctx())
  const missing = missingRequiredFacts({ destinationKnown: true, travelMiles: 5 }, withStairs)
  assert.equal(missing.length, 0, 'a visible staircase is an answer, not a question')
})

// ── customer projection ──────────────────────────────────────────────────────

test('[response] the customer view exposes the estimate and nothing internal', () => {
  const a = normalizeMovingAnalysis(movingRaw(), ctx())
  const d = decideMovingQuote({ analysis: a, settings: DEFAULT_MOVING, facts: completeFacts })
  const stored: StoredMovingEstimate = {
    id: 'm1', createdAt: '2026-08-04T00:00:00Z', lane: 'moving', status: 'completed', decision: d.decision,
    provider: 'vercel-ai-gateway', model: 'test-model', schemaVersion: a.schemaVersion,
    callId: 'call-123', latencyMs: 900, inputPhotoUrls: ['https://x/1.jpg'], analysis: a,
    pricing: {
      recommendedUsd: d.recommendedUsd, lowUsd: d.rangeUsd.low, highUsd: d.rangeUsd.high, priced: d.priced,
      decisionVersion: d.decisionVersion, crewSize: d.quote.crewSize, laborHours: d.quote.laborHours,
      costLines: d.quote.breakdown, sellingPriceCents: d.quote.sellingPriceCents, minimumApplied: d.quote.minimumApplied,
    },
    reviewReasons: d.reviewReasons, missingInformation: d.missingInformation,
  }

  const view = customerMovingEstimateView(stored)
  assert.equal(view.lane, 'moving')
  assert.ok(view.crewSize > 0 && view.items.length > 0)
  assert.equal(typeof view.estimatedTruckSpacePct, 'number')

  const keys = Object.keys(view)
  for (const leak of ['costLines', 'sellingPriceCents', 'callId', 'model', 'provider', 'schemaVersion', 'decisionVersion', 'minimumApplied']) {
    assert.ok(!keys.includes(leak), `customer view must not expose ${leak}`)
  }
  // The five confidence sub-scores are internal; one rolled-up number is public.
  assert.equal(typeof view.confidence, 'number')
  assert.ok(!JSON.stringify(view).includes('"inventory"'), 'confidence sub-scores must stay internal')
})
