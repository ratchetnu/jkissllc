// Operion Shadow Alerting — pure evaluator + lifecycle reconciler tests.
//
// Everything here runs against the PURE engine: no Redis, no clock, no network. `now` is a
// fixed constant and ids come from a deterministic factory, so these assertions pin exact
// values rather than ranges.
import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateShadowAlerts, reconcileAlerts, crosses, snapshotReadiness } from '../app/lib/estimation/shadow-alert-engine'
import { DEFAULT_ALERT_POLICIES, policyById, isSafetyCritical, SAFETY_CRITICAL_TYPES } from '../app/lib/estimation/shadow-alert-policies'
import { ALL_POLICY_TYPES, SEVERITY_RANK } from '../app/lib/estimation/shadow-alert-types'
import type { AlertPolicy, AlertSignal, ShadowAlert, ReadinessSnapshot } from '../app/lib/estimation/shadow-alert-types'
import { applyAlertTransition } from '../app/lib/estimation/shadow-alert-store'
import type { V2ShadowJob, V2Comparison } from '../app/lib/estimation/shadow-types'
import type { EstimationResultV2 } from '../app/lib/estimation/v2-bridge'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_700_000_000_000

// ── fixtures ─────────────────────────────────────────────────────────────────

const BASE_COMPARISON: V2Comparison = {
  comparisonVersion: 1, shadowRecommendedUsd: 300, shadowDecision: 'estimate_range',
  authoritativeDecision: 'estimate_range',   // NOT manual_review — otherwise every job is a false negative
  shadowManualReview: false, shadowInventoryCount: 3, outcome: 'equivalent', outcomeReasons: [],
}

let seq = 0
function job(over: Partial<Omit<V2ShadowJob, 'comparison'>> & { comparison?: Partial<V2Comparison> | null; confidence?: number } = {}): V2ShadowJob {
  const at = over.completedAt ?? NOW
  return {
    jobVersion: 1, bookingId: over.bookingId ?? `bk${seq++}`, shadowJobId: 's', status: over.status ?? 'completed',
    idempotencyKey: 'k', estimatorVersion: over.estimatorVersion ?? 2, imageCount: 1, attempts: 1,
    createdBy: 'auto', model: over.model ?? 'anthropic/claude-sonnet-4-6', promptVersion: over.promptVersion ?? 2,
    latencyMs: over.latencyMs ?? 40_000, estimatedCostUsd: over.estimatedCostUsd ?? 0.02,
    traceId: over.traceId ?? `tr${seq}`,
    result: { estimate: { confidenceScore: over.confidence ?? 0.6, manualReviewReasons: [] } as unknown as EstimationResultV2, questions: [], ok: true },
    comparison: over.comparison === null ? undefined : { ...BASE_COMPARISON, ...over.comparison },
    completedAt: at,
    updatedAt: at,
    failureCategory: over.failureCategory,
  }
}

/** n jobs completed at `at`. */
const many = (n: number, at: number, over: Parameters<typeof job>[0] = {}): V2ShadowJob[] =>
  Array.from({ length: n }, () => job({ ...over, completedAt: at }))

const AGREE = { outcome: 'equivalent' as const }
const DISAGREE = { outcome: 'worse' as const }
const FALSE_NEGATIVE = { shadowManualReview: false, authoritativeDecision: 'manual_review' }

const pol = (id: string, over: Partial<AlertPolicy> = {}): AlertPolicy => ({ ...policyById(id)!, ...over })
const only = (p: AlertPolicy) => [p]
const skipReason = (r: ReturnType<typeof evaluateShadowAlerts>, policyId: string) =>
  r.skips.find((s) => s.policyId === policyId)?.reason

// ── policy set integrity ─────────────────────────────────────────────────────

test('policy set: exactly one policy per type, unique ids, conservative defaults', () => {
  const types = DEFAULT_ALERT_POLICIES.map((p) => p.type)
  assert.equal(types.length, ALL_POLICY_TYPES.length, 'one policy per declared type')
  assert.equal(new Set(types).size, types.length, 'no duplicate types')
  assert.equal(new Set(DEFAULT_ALERT_POLICIES.map((p) => p.id)).size, DEFAULT_ALERT_POLICIES.length, 'no duplicate ids')

  for (const p of DEFAULT_ALERT_POLICIES) {
    assert.ok(p.channels.length > 0, `${p.id} must deliver somewhere`)
    assert.ok(p.windowMs > 0, `${p.id} needs a window`)
    // A comparative policy without a real sample floor would fire on noise.
    if (p.baselineWindowMs) assert.ok(p.minSampleSize >= 10, `${p.id} comparative policy needs a sample floor`)
    // per_item alerts describe an immutable event and must never silently self-clear.
    if (p.kind === 'per_item') assert.ok(!p.expireAfterMs || p.expireAfterMs >= 7 * DAY, `${p.id} expiry too aggressive`)
  }
})

test('policy set: safety-critical policies are CRITICAL, require ack, and are enabled', () => {
  for (const p of DEFAULT_ALERT_POLICIES.filter(isSafetyCritical)) {
    assert.equal(p.severity, 'CRITICAL', `${p.id}`)
    assert.equal(p.requiresAck, true, `${p.id} must not self-clear`)
    assert.equal(p.enabled, true, `${p.id} must ship on`)
  }
  assert.deepEqual([...SAFETY_CRITICAL_TYPES], ['critical_false_negative', 'readiness_milestone_lost'])
  assert.ok(SEVERITY_RANK.CRITICAL > SEVERITY_RANK.WARNING)
})

// ── threshold evaluation ─────────────────────────────────────────────────────

test('crosses(): each comparison operator, including the zero-baseline ratio guard', () => {
  const p = (comparison: AlertPolicy['comparison'], threshold: number) => ({ comparison, threshold } as AlertPolicy)
  assert.equal(crosses(p('count_at_least', 1), 1, null), true)
  assert.equal(crosses(p('count_at_least', 2), 1, null), false)
  assert.equal(crosses(p('above_absolute', 25), 26, null), true)
  assert.equal(crosses(p('above_absolute', 25), 25, null), false)   // strictly above
  assert.equal(crosses(p('below_absolute', 30), 29, null), true)
  assert.equal(crosses(p('below_absolute', 30), 30, null), false)
  assert.equal(crosses(p('drop_at_least', 10), 80, 90), true)       // 10pp drop, inclusive
  assert.equal(crosses(p('drop_at_least', 10), 81, 90), false)
  assert.equal(crosses(p('rise_at_least', 15), 30, 15), true)
  assert.equal(crosses(p('rise_at_least', 15), 29, 15), false)
  assert.equal(crosses(p('ratio_increase', 1.5), 60, 40), true)
  assert.equal(crosses(p('ratio_increase', 1.5), 59, 40), false)
  // A zero baseline has no meaningful multiple — never call 0 → anything a "1.5× regression".
  assert.equal(crosses(p('ratio_increase', 1.5), 100, 0), false)
  assert.equal(crosses(p('drop_at_least', 10), 80, null), false)    // no baseline ⇒ no decision
})

test('agreement_rate_drop: fires on a real drop, with the observed/baseline values attached', () => {
  const jobs = [
    ...many(30, NOW - 10 * DAY, { comparison: AGREE }),              // baseline: 100%
    ...many(15, NOW - 3 * DAY, { comparison: AGREE }),               // current: 50%
    ...many(15, NOW - 3 * DAY, { comparison: DISAGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop')), priorReadiness: null })
  assert.equal(r.signals.length, 1)
  const s = r.signals[0]
  assert.equal(s.policyType, 'agreement_rate_drop')
  assert.equal(s.severity, 'WARNING')
  assert.equal(s.observed, 50)
  assert.equal(s.comparison, 100)
  assert.equal(s.sampleSize, 30)
  assert.equal(s.dedupKey, 'agreement-rate-drop:global')
  assert.match(s.reason, /Agreement rate is 50% .* 50% lower/)
})

test('agreement_rate_drop: a drop under the threshold does NOT fire', () => {
  const jobs = [
    ...many(30, NOW - 10 * DAY, { comparison: AGREE }),
    ...many(28, NOW - 3 * DAY, { comparison: AGREE }),               // 93.3% — a 6.7pp drop
    ...many(2, NOW - 3 * DAY, { comparison: DISAGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'agreement-rate-drop'), 'not_applicable')
})

test('confidence_drop / manual_review_spike / auto_quote_rate_drop measure the right metric', () => {
  const jobs = [
    ...many(30, NOW - 10 * DAY, { comparison: AGREE, confidence: 0.8 }),
    ...many(30, NOW - 3 * DAY, { comparison: { ...AGREE, shadowManualReview: true }, confidence: 0.5 }),
  ]
  const conf = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('confidence-drop')), priorReadiness: null })
  assert.equal(conf.signals[0].observed, 0.5)
  assert.equal(conf.signals[0].comparison, 0.8)

  const spike = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('manual-review-spike')), priorReadiness: null })
  assert.equal(spike.signals[0].observed, 100)   // all current jobs went to review
  assert.equal(spike.signals[0].comparison, 0)

  const auto = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('auto-quote-rate-drop')), priorReadiness: null })
  assert.equal(auto.signals[0].observed, 0)
  assert.equal(auto.signals[0].comparison, 100)
})

test('latency_regression + cost_per_evaluation_spike use ratio semantics', () => {
  const jobs = [
    ...many(20, NOW - 10 * DAY, { comparison: AGREE, latencyMs: 40_000, estimatedCostUsd: 0.02 }),
    ...many(20, NOW - 3 * DAY, { comparison: AGREE, latencyMs: 100_000, estimatedCostUsd: 0.05 }),
  ]
  const lat = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('latency-regression')), priorReadiness: null })
  assert.equal(lat.signals[0].observed, 100_000)   // 2.5× the 40s baseline
  assert.equal(lat.signals[0].comparison, 40_000)

  const cost = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('cost-per-evaluation-spike')), priorReadiness: null })
  assert.equal(cost.signals[0].observed, 0.05)
  assert.equal(cost.signals[0].comparison, 0.02)
})

test('evaluation_failure_spike counts failures over TERMINAL jobs, not evaluations', () => {
  // A failed job never produces a comparison, so `evaluated` cannot see it. If the
  // denominator were `evaluated`, a total pipeline outage would read as a 0% failure rate.
  const jobs = [
    ...many(1, NOW - 9 * DAY, { comparison: AGREE }),                                    // history so the baseline window is covered
    ...many(20, NOW - 3 * DAY, { comparison: AGREE }),                                   // baseline: 0% of 20
    ...many(10, NOW - 6 * HOUR, { status: 'failed', comparison: null, failureCategory: 'provider_timeout' }),
    ...many(5, NOW - 6 * HOUR, { comparison: AGREE }),                                   // current: 10 of 15 failed
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('evaluation-failure-spike')), priorReadiness: null })
  assert.equal(r.signals.length, 1)
  assert.equal(r.signals[0].observed, 66.7)
  assert.equal(r.signals[0].comparison, 0)
  assert.equal(r.signals[0].sampleSize, 15)
})

test('queue_backlog counts every queued job, not just recent ones', () => {
  const jobs = [...many(30, NOW - 40 * DAY, { status: 'queued', comparison: null })]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('queue-backlog')), priorReadiness: null })
  assert.equal(r.signals.length, 1, 'a 40-day-old queued job is still 40 days of backlog')
  assert.equal(r.signals[0].observed, 30)

  const under = evaluateShadowAlerts({ jobs: many(25, NOW, { status: 'queued', comparison: null }), now: NOW, policies: only(pol('queue-backlog')), priorReadiness: null })
  assert.equal(under.signals.length, 0, '25 is at the ceiling, not above it')
})

// ── minimum sample enforcement ───────────────────────────────────────────────

test('minimum sample: a thin dataset skips rather than screams', () => {
  // A 100% → 0% collapse, but on 3 jobs a side. The drop is real and meaningless.
  const jobs = [
    ...many(3, NOW - 10 * DAY, { comparison: AGREE }),
    ...many(3, NOW - 3 * DAY, { comparison: DISAGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'agreement-rate-drop'), 'insufficient_sample')
  assert.match(r.skips[0].detail, /below the 30 minimum/)
})

test('minimum sample: a healthy current window against a thin baseline still skips', () => {
  const jobs = [
    ...many(5, NOW - 10 * DAY, { comparison: AGREE }),               // baseline too thin
    ...many(40, NOW - 3 * DAY, { comparison: DISAGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'agreement-rate-drop'), 'insufficient_sample')
})

test('incomplete window: day-one data never reads as a regression from nothing', () => {
  // All jobs land inside the CURRENT window; the baseline window has no coverage at all.
  const jobs = many(60, NOW - 1 * DAY, { comparison: DISAGREE })
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'agreement-rate-drop'), 'incomplete_window')
})

// ── empty + degenerate datasets ──────────────────────────────────────────────

test('empty dataset: every policy skips, nothing fires, readiness still reports', () => {
  const r = evaluateShadowAlerts({ jobs: [], now: NOW, policies: DEFAULT_ALERT_POLICIES, priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(r.readiness.tier, 'NEEDS_MORE_DATA')
  assert.equal(r.readiness.evaluated, 0)
  // Every enabled policy must explain itself — a silent skip is indistinguishable from a bug.
  const enabled = DEFAULT_ALERT_POLICIES.filter((p) => p.enabled)
  for (const p of enabled) assert.ok(r.skips.some((s) => s.policyId === p.id), `${p.id} must record a skip`)
})

test('disabled policy never evaluates', () => {
  const jobs = many(5, NOW, { comparison: FALSE_NEGATIVE })
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('critical-false-negative', { enabled: false })), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'critical-false-negative'), 'disabled')
})

test('insufficient_sample_volume ships disabled but works when the owner opts in', () => {
  assert.equal(policyById('insufficient-sample-volume')!.enabled, false, 'must not nag by default')
  const r = evaluateShadowAlerts({
    jobs: many(4, NOW - 1 * DAY, { comparison: AGREE }), now: NOW,
    policies: only(pol('insufficient-sample-volume', { enabled: true })), priorReadiness: null,
  })
  assert.equal(r.signals.length, 1)
  assert.equal(r.signals[0].observed, 4)
  assert.equal(r.signals[0].threshold, 30)
})

// ── stale telemetry ──────────────────────────────────────────────────────────

test('stale_shadow_telemetry fires on an old last-evaluation, and not on a fresh one', () => {
  const stale = evaluateShadowAlerts({ jobs: many(5, NOW - 5 * DAY, { comparison: AGREE }), now: NOW, policies: only(pol('stale-shadow-telemetry')), priorReadiness: null })
  assert.equal(stale.signals.length, 1)
  assert.equal(stale.signals[0].observed, 5 * DAY)
  assert.match(stale.signals[0].reason, /120 hours/)

  const fresh = evaluateShadowAlerts({ jobs: many(5, NOW - 2 * HOUR, { comparison: AGREE }), now: NOW, policies: only(pol('stale-shadow-telemetry')), priorReadiness: null })
  assert.equal(fresh.signals.length, 0)
})

test('stale_shadow_telemetry stays quiet when nothing has EVER been evaluated', () => {
  // Nothing has run, so nothing is stale. insufficient_sample_volume is the honest signal here.
  const r = evaluateShadowAlerts({ jobs: many(5, NOW, { status: 'queued', comparison: null }), now: NOW, policies: only(pol('stale-shadow-telemetry')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'stale-shadow-telemetry'), 'no_data')
})

// ── per-item safety policies ─────────────────────────────────────────────────

test('critical_false_negative: one CRITICAL signal per booking, keyed by booking', () => {
  const jobs = [
    job({ bookingId: 'fn1', comparison: FALSE_NEGATIVE, completedAt: NOW - HOUR }),
    job({ bookingId: 'fn2', comparison: FALSE_NEGATIVE, completedAt: NOW - 2 * HOUR }),
    ...many(10, NOW - HOUR, { comparison: AGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('critical-false-negative')), priorReadiness: null })
  assert.equal(r.signals.length, 2)
  assert.deepEqual(r.signals.map((s) => s.dedupKey).sort(), ['critical-false-negative:fn1', 'critical-false-negative:fn2'])
  assert.equal(r.signals[0].severity, 'CRITICAL')
  assert.deepEqual(r.signals[0].relatedBookingIds, ['fn1'])
  assert.equal(r.signals[0].relatedTraceIds.length, 1, 'trace id carried through for debugging')
})

test('high_severity_disagreement does not double-alert a false negative', () => {
  // detectDisagreements ranks a false negative as high severity. Both policies seeing it
  // would mean two alerts for one booking — emphasis by duplication is just noise.
  const jobs = [
    job({ bookingId: 'fn1', comparison: FALSE_NEGATIVE, completedAt: NOW - HOUR }),
    job({ bookingId: 'price1', completedAt: NOW - HOUR, comparison: { authoritativeRecommendedUsd: 300, quoteDeltaUsd: 400, quoteDeltaPct: 130 } }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('high-severity-disagreement')), priorReadiness: null })
  assert.equal(r.signals.length, 1)
  assert.equal(r.signals[0].relatedBookingIds[0], 'price1')
  assert.ok(!r.signals.some((s) => s.dedupKey.includes('fn1')))
})

// ── readiness transitions ────────────────────────────────────────────────────

const snap = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  at: NOW - DAY, scope: 'global', tier: 'READY_FOR_EXPANDED_SHADOW', score: 0.3, evaluated: 50,
  agreementPct: 90, falseNegatives: 0, blockers: [], reasons: [], ...over,
})

test('readiness: the first run establishes a baseline and cannot fire a transition', () => {
  const jobs = many(120, NOW - DAY, { comparison: AGREE })
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('readiness-milestone-reached')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'readiness-milestone-reached'), 'no_baseline')
  assert.equal(r.readiness.tier, 'READY_FOR_LIMITED_ROLLOUT', 'but the baseline is captured for next time')
})

test('readiness_milestone_reached fires on a tier upgrade and explains what changed', () => {
  const jobs = many(120, NOW - DAY, { comparison: AGREE })   // 100% agreement over 120 ⇒ LIMITED_ROLLOUT
  const r = evaluateShadowAlerts({
    jobs, now: NOW, policies: only(pol('readiness-milestone-reached')),
    priorReadiness: snap({ tier: 'READY_FOR_EXPANDED_SHADOW', agreementPct: 90, evaluated: 50 }),
  })
  assert.equal(r.signals.length, 1)
  const s = r.signals[0]
  assert.equal(s.severity, 'INFO')
  assert.equal(s.dedupKey, 'readiness-milestone-reached:global:READY_FOR_EXPANDED_SHADOW->READY_FOR_LIMITED_ROLLOUT')
  assert.match(s.reason, /Ready for expanded shadow → Ready for limited rollout/)
  assert.match(s.reason, /Agreement 100% over 120 evaluated \(was 90% over 50\)/)
  assert.match(s.reason, /No remaining blockers/)
  assert.match(s.reason, /No model is promoted automatically/)
})

test('readiness_milestone_lost fires CRITICAL on a downgrade and names the new blocker', () => {
  const jobs = [...many(120, NOW - DAY, { comparison: AGREE }), job({ bookingId: 'fn1', comparison: FALSE_NEGATIVE, completedAt: NOW - HOUR })]
  const r = evaluateShadowAlerts({
    jobs, now: NOW, policies: only(pol('readiness-milestone-lost')),
    priorReadiness: snap({ tier: 'READY_FOR_LIMITED_ROLLOUT', blockers: [] }),
  })
  assert.equal(r.signals.length, 1)
  assert.equal(r.signals[0].severity, 'CRITICAL')
  assert.match(r.signals[0].reason, /Ready for limited rollout → Blocked/)
  assert.match(r.signals[0].reason, /New blocker\(s\): 1 possible false-negative/)
  assert.match(r.signals[0].reason, /investigate the regression before any further rollout/)
})

test('readiness: an unchanged tier fires nothing; the wrong-direction policy stays quiet', () => {
  const jobs = many(120, NOW - DAY, { comparison: AGREE })
  const same = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('readiness-milestone-reached')), priorReadiness: snap({ tier: 'READY_FOR_LIMITED_ROLLOUT' }) })
  assert.equal(same.signals.length, 0)
  assert.equal(skipReason(same, 'readiness-milestone-reached'), 'not_applicable')

  // An UPGRADE must not trip the "lost" policy.
  const lost = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('readiness-milestone-lost')), priorReadiness: snap({ tier: 'READY_FOR_EXPANDED_SHADOW' }) })
  assert.equal(lost.signals.length, 0)
})

test('readiness: a transition below the sample floor is not reported', () => {
  const jobs = many(5, NOW - DAY, { comparison: AGREE })
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('readiness-milestone-lost')), priorReadiness: snap({ tier: 'READY_FOR_CUSTOMER_ROLLOUT' }) })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'readiness-milestone-lost'), 'insufficient_sample')
})

test('snapshotReadiness mirrors the readiness engine rather than re-deriving it', () => {
  const jobs = [...many(40, NOW - DAY, { comparison: AGREE }), job({ bookingId: 'fn', comparison: FALSE_NEGATIVE })]
  const s = snapshotReadiness(jobs, NOW, 'global')
  assert.equal(s.tier, 'BLOCKED')          // any false negative blocks, per DEFAULT_READINESS_THRESHOLDS
  assert.equal(s.score, 0)
  assert.equal(s.falseNegatives, 1)
  assert.equal(s.evaluated, 41)
  assert.equal(s.blockers.length, 1)
})

// ── scope + isolation ────────────────────────────────────────────────────────

test('multi-model isolation: fanOut model scores each model separately', () => {
  const jobs = [
    // model A regresses...
    ...many(30, NOW - 10 * DAY, { model: 'a/one', comparison: AGREE }),
    ...many(30, NOW - 3 * DAY, { model: 'a/one', comparison: DISAGREE }),
    // ...while model B is steady.
    ...many(30, NOW - 10 * DAY, { model: 'b/two', comparison: AGREE }),
    ...many(30, NOW - 3 * DAY, { model: 'b/two', comparison: AGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop', { fanOut: 'model' })), priorReadiness: null })
  assert.equal(r.signals.length, 1, 'B must not be tarred with A regression')
  assert.equal(r.signals[0].scopeKey, 'a/one')
  assert.equal(r.signals[0].model, 'a/one')
  assert.equal(r.signals[0].dedupKey, 'agreement-rate-drop:a/one')
})

test('explicit model scope narrows the population before anything is measured', () => {
  const jobs = [
    ...many(30, NOW - 10 * DAY, { model: 'a/one', comparison: AGREE }),
    ...many(30, NOW - 3 * DAY, { model: 'a/one', comparison: DISAGREE }),
    ...many(30, NOW - 10 * DAY, { model: 'b/two', comparison: AGREE }),
    ...many(30, NOW - 3 * DAY, { model: 'b/two', comparison: AGREE }),
  ]
  const scoped = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop', { scope: { model: 'b/two' } })), priorReadiness: null })
  assert.equal(scoped.signals.length, 0, 'scoped to the healthy model ⇒ nothing to say')
})

test('multi-deployment isolation: model_prompt_regression flags only the laggard', () => {
  const jobs = [
    ...many(30, NOW - 5 * DAY, { promptVersion: 1, comparison: AGREE }),      // best peer: 100%
    ...many(15, NOW - 5 * DAY, { promptVersion: 2, comparison: AGREE }),      // laggard: 50%
    ...many(15, NOW - 5 * DAY, { promptVersion: 2, comparison: DISAGREE }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('model-prompt-regression')), priorReadiness: null })
  assert.equal(r.signals.length, 1)
  assert.equal(r.signals[0].deployment, 'anthropic/claude-sonnet-4-6|2|2')
  assert.equal(r.signals[0].observed, 50)
  assert.equal(r.signals[0].comparison, 100)
  assert.match(r.signals[0].reason, /Hypothesis: a model or prompt regression — the data shows the gap, not its cause/)
})

test('model_prompt_regression needs two comparable deployments', () => {
  const jobs = many(30, NOW - 5 * DAY, { promptVersion: 1, comparison: DISAGREE })
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('model-prompt-regression')), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'model-prompt-regression'), 'insufficient_sample')
  assert.match(r.skips[0].detail, /found 1/)
})

test('business scope is carried but inert — a business-scoped policy matches nothing today', () => {
  // V2ShadowJob has no businessId (single-tenant), so jobBusiness() is always null. This
  // test pins that reality: business scope is plumbing for later, not a working filter.
  const jobs = many(60, NOW - 10 * DAY, { comparison: DISAGREE })
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: only(pol('agreement-rate-drop', { scope: { business: 'jkiss' } })), priorReadiness: null })
  assert.equal(r.signals.length, 0)
  assert.equal(skipReason(r, 'agreement-rate-drop'), 'no_data')
})

// ── determinism ──────────────────────────────────────────────────────────────

test('evaluation is deterministic: same inputs ⇒ byte-identical signals', () => {
  const jobs = [
    ...many(30, NOW - 10 * DAY, { comparison: AGREE }),
    ...many(30, NOW - 3 * DAY, { comparison: DISAGREE }),
    job({ bookingId: 'fn1', comparison: FALSE_NEGATIVE, completedAt: NOW - HOUR }),
  ]
  const a = evaluateShadowAlerts({ jobs, now: NOW, policies: DEFAULT_ALERT_POLICIES, priorReadiness: snap() })
  const b = evaluateShadowAlerts({ jobs, now: NOW, policies: DEFAULT_ALERT_POLICIES, priorReadiness: snap() })
  assert.deepEqual(a.signals, b.signals)
  assert.deepEqual(a.skips, b.skips)
  assert.deepEqual(a.readiness, b.readiness)
})

// ── lifecycle reconciliation ─────────────────────────────────────────────────

const sig = (over: Partial<AlertSignal> = {}): AlertSignal => ({
  policyId: 'agreement-rate-drop', policyType: 'agreement_rate_drop', severity: 'WARNING',
  dedupKey: 'agreement-rate-drop:global', scopeKey: 'global', reason: 'Agreement fell.',
  observed: 50, threshold: 10, comparison: 100, sampleSize: 30,
  relatedBookingIds: [], relatedTraceIds: [], readiness: null, at: NOW, ...over,
})
const ids = (i: number) => `SAL-${1000 + i}`
const reconcile = (existing: ShadowAlert[], signals: AlertSignal[], now = NOW) =>
  reconcileAlerts({ existing, signals, now, policies: DEFAULT_ALERT_POLICIES, nextId: ids })

test('lifecycle: a new signal opens an OPEN, unread alert with full context', () => {
  const r = reconcile([], [sig({ relatedBookingIds: ['b1'], relatedTraceIds: ['t1'] })])
  assert.equal(r.opened.length, 1)
  const a = r.opened[0]
  assert.equal(a.id, 'SAL-1000')
  assert.equal(a.status, 'OPEN')
  assert.equal(a.unread, true)
  assert.equal(a.occurrences, 1)
  assert.equal(a.firstDetectedAt, NOW)
  assert.equal(a.lastDetectedAt, NOW)
  assert.equal(a.observed, 50)
  assert.equal(a.threshold, 10)
  assert.equal(a.comparison, 100)
  assert.deepEqual(a.relatedBookingIds, ['b1'])
  assert.deepEqual(a.notes, [])
})

test('deduplication: a re-detected condition refreshes the alert instead of opening a second', () => {
  const first = reconcile([], [sig()]).opened
  const again = reconcile(first, [sig({ observed: 40, relatedBookingIds: ['b2'] })], NOW + HOUR)
  assert.equal(again.opened.length, 0, 'no duplicate alert')
  assert.equal(again.updated.length, 1)
  const a = again.updated[0]
  assert.equal(a.id, 'SAL-1000')
  assert.equal(a.occurrences, 2)
  assert.equal(a.firstDetectedAt, NOW, 'first detection is preserved')
  assert.equal(a.lastDetectedAt, NOW + HOUR)
  assert.equal(a.observed, 40, 'refreshed to the latest reading')
  assert.deepEqual(a.relatedBookingIds, ['b2'])
})

test('deduplication is idempotent: reconciling the same run twice changes nothing', () => {
  const first = reconcile([], [sig()]).opened
  const a = reconcile(JSON.parse(JSON.stringify(first)), [sig()], NOW)
  const b = reconcile(JSON.parse(JSON.stringify(first)), [sig()], NOW)
  assert.equal(a.opened.length, 0)
  assert.equal(b.opened.length, 0)
  assert.deepEqual(a.updated, b.updated)
})

test('deduplication: an ACKNOWLEDGED alert still absorbs the signal (no re-open)', () => {
  const open = reconcile([], [sig()]).opened[0]
  const acked = applyAlertTransition(open, { type: 'acknowledge' }, 'owner', NOW)
  assert.ok(acked.ok)
  const r = reconcile([acked.alert], [sig()], NOW + HOUR)
  assert.equal(r.opened.length, 0)
  assert.equal(r.updated[0].status, 'ACKNOWLEDGED', 'refreshing must not silently reopen it')
})

test('recovery: an aggregate condition that stops being true auto-resolves', () => {
  const open = reconcile([], [sig()]).opened
  const r = reconcile(open, [], NOW + HOUR)     // condition gone
  assert.equal(r.resolved.length, 1)
  assert.equal(r.resolved[0].status, 'RESOLVED')
  assert.equal(r.resolved[0].resolvedBy, 'system')
  assert.match(r.resolved[0].resolvedReason!, /recovered/)
})

test('recovery: a per-item safety alert NEVER auto-resolves just because it aged out', () => {
  // A false negative that scrolled out of the window has not been fixed — nobody looked at it.
  const fn = sig({ policyId: 'critical-false-negative', policyType: 'critical_false_negative', severity: 'CRITICAL', dedupKey: 'critical-false-negative:fn1' })
  const open = reconcile([], [fn]).opened
  const r = reconcile(open, [], NOW + 10 * DAY)
  assert.equal(r.resolved.length, 0)
  assert.equal(r.expired.length, 0, 'no expiry configured ⇒ it waits for a human')
  assert.equal(open[0].status, 'OPEN')
})

test('recovery: readiness_milestone_lost requires acknowledgement and never self-clears', () => {
  const lost = sig({ policyId: 'readiness-milestone-lost', policyType: 'readiness_milestone_lost', severity: 'CRITICAL', dedupKey: 'readiness-milestone-lost:global:A->B' })
  const open = reconcile([], [lost]).opened
  const r = reconcile(open, [], NOW + 10 * DAY)
  assert.equal(r.resolved.length, 0)
  assert.equal(open[0].status, 'OPEN')
})

test('expiry: a stale per-item alert with an expiry configured EXPIRES', () => {
  const d = sig({ policyId: 'high-severity-disagreement', policyType: 'high_severity_disagreement', dedupKey: 'high-severity-disagreement:b1:large_price_difference' })
  const open = reconcile([], [d]).opened
  assert.equal(reconcile(open, [], NOW + 29 * DAY).expired.length, 0, 'not yet')
  const r = reconcile(open, [], NOW + 31 * DAY)
  assert.equal(r.expired.length, 1)
  assert.equal(r.expired[0].status, 'EXPIRED')
})

test('cooldown: a resolved aggregate condition cannot re-open until the cooldown elapses', () => {
  const open = reconcile([], [sig()]).opened
  const resolved = reconcile(open, [], NOW + HOUR).resolved   // auto-resolved at NOW+1h
  // agreement-rate-drop cooldown is 24h.
  const early = reconcile(resolved, [sig()], NOW + 2 * HOUR)
  assert.equal(early.opened.length, 0)
  assert.equal(early.suppressed.length, 1)
  assert.equal(early.suppressed[0].reason, 'cooldown')
  assert.match(early.suppressed[0].detail, /cooldown is 1440m/)

  const late = reconcile(resolved, [sig()], NOW + 26 * HOUR)
  assert.equal(late.opened.length, 1, 'a genuinely recurring condition does re-open')
  assert.equal(late.suppressed.length, 0)
})

test('cooldown does not apply to a per-item alert — it is suppressed permanently instead', () => {
  // The dedup key names an immutable event. Once the owner closes "false negative on
  // booking fn1", re-detecting the same evidence forever is not news.
  const fn = sig({ policyId: 'critical-false-negative', policyType: 'critical_false_negative', dedupKey: 'critical-false-negative:fn1' })
  const open = reconcile([], [fn]).opened
  const closed = applyAlertTransition(open[0], { type: 'resolve', reason: 'Reviewed — V1 was over-cautious.' }, 'owner', NOW + HOUR)
  assert.ok(closed.ok)

  for (const t of [NOW + 2 * HOUR, NOW + 90 * DAY]) {
    const r = reconcile([closed.alert], [fn], t)
    assert.equal(r.opened.length, 0, `must stay closed at ${t}`)
    assert.equal(r.suppressed[0].reason, 'already_handled')
  }
})

test('mute: an active mute suppresses the signal; an expired mute lets it through', () => {
  const open = reconcile([], [sig()]).opened
  const muted = applyAlertTransition(open[0], { type: 'mute', durationMs: 12 * HOUR }, 'owner', NOW)
  assert.ok(muted.ok)

  const during = reconcile([muted.alert], [sig()], NOW + 6 * HOUR)
  assert.equal(during.opened.length, 0)
  assert.equal(during.suppressed[0].reason, 'muted')

  // Once the mute lapses the alert is no longer active, so a fresh detection opens a new one.
  const after = reconcile([muted.alert], [sig()], NOW + 13 * HOUR)
  assert.equal(after.opened.length, 1)
})

test('escalation: an unacknowledged CRITICAL is stamped once, and acknowledging stops it', () => {
  const fn = sig({ policyId: 'critical-false-negative', policyType: 'critical_false_negative', severity: 'CRITICAL', dedupKey: 'critical-false-negative:fn1' })
  const open = reconcile([], [fn]).opened
  assert.equal(reconcile(open, [], NOW + 12 * HOUR).escalated.length, 0, 'inside the 24h delay')

  const r = reconcile(open, [], NOW + 25 * HOUR)
  assert.equal(r.escalated.length, 1)
  assert.equal(r.escalated[0].escalatedAt, NOW + 25 * HOUR)
  assert.ok(r.updated.some((a) => a.id === r.escalated[0].id), 'escalated alerts must be in `updated` so they persist')

  // Stamped once, not every run.
  assert.equal(reconcile(open, [], NOW + 26 * HOUR).escalated.length, 0)

  // An acknowledged alert stops escalating.
  const fresh = reconcile([], [fn]).opened
  const acked = applyAlertTransition(fresh[0], { type: 'acknowledge' }, 'owner', NOW)
  assert.ok(acked.ok)
  assert.equal(reconcile([acked.alert], [], NOW + 25 * HOUR).escalated.length, 0)
})

test('reconcile result buckets are disjoint — persisting all four is safe', () => {
  const open = reconcile([], [sig(), sig({ dedupKey: 'other:global', policyId: 'manual-review-spike', policyType: 'manual_review_spike' })]).opened
  const r = reconcile(open, [sig()], NOW + HOUR)   // one refreshed, one recovered
  const seen = [...r.opened, ...r.updated, ...r.resolved, ...r.expired].map((a) => a.id)
  assert.equal(new Set(seen).size, seen.length, 'no alert may appear in two buckets')
  assert.equal(r.updated.length, 1)
  assert.equal(r.resolved.length, 1)
})

test('reconcile: distinct policies with distinct keys open independent alerts', () => {
  const r = reconcile([], [
    sig({ dedupKey: 'critical-false-negative:fn1', policyId: 'critical-false-negative', policyType: 'critical_false_negative' }),
    sig({ dedupKey: 'critical-false-negative:fn2', policyId: 'critical-false-negative', policyType: 'critical_false_negative' }),
    sig(),
  ])
  assert.equal(r.opened.length, 3)
  assert.deepEqual(r.opened.map((a) => a.id), ['SAL-1000', 'SAL-1001', 'SAL-1002'])
})

// ── owner transitions ────────────────────────────────────────────────────────

const anAlert = (): ShadowAlert => reconcile([], [sig()]).opened[0]

test('transition: acknowledge marks read and records who + when', () => {
  const r = applyAlertTransition(anAlert(), { type: 'acknowledge' }, 'owner', NOW + HOUR)
  assert.ok(r.ok)
  assert.equal(r.alert.status, 'ACKNOWLEDGED')
  assert.equal(r.alert.acknowledgedBy, 'owner')
  assert.equal(r.alert.acknowledgedAt, NOW + HOUR)
  assert.equal(r.alert.unread, false)
  assert.equal(r.priorStatus, 'OPEN')
  assert.equal(r.auditAction, 'shadow_alert.acknowledged')
})

test('transition: acknowledging twice is rejected', () => {
  const first = applyAlertTransition(anAlert(), { type: 'acknowledge' }, 'owner', NOW)
  assert.ok(first.ok)
  const second = applyAlertTransition(first.alert, { type: 'acknowledge' }, 'owner', NOW)
  assert.equal(second.ok, false)
})

test('transition: resolve captures the owner reason; resolving twice is rejected', () => {
  const r = applyAlertTransition(anAlert(), { type: 'resolve', reason: 'Known prompt change.' }, 'owner', NOW)
  assert.ok(r.ok)
  assert.equal(r.alert.status, 'RESOLVED')
  assert.equal(r.alert.resolvedBy, 'owner')
  assert.equal(r.alert.resolvedReason, 'Known prompt change.')
  assert.equal(applyAlertTransition(r.alert, { type: 'resolve' }, 'owner', NOW).ok, false)
})

test('transition: mute is bounded — no permanent silence by accident', () => {
  assert.equal(applyAlertTransition(anAlert(), { type: 'mute', durationMs: 31 * DAY }, 'owner', NOW).ok, false)
  assert.equal(applyAlertTransition(anAlert(), { type: 'mute', durationMs: 0 }, 'owner', NOW).ok, false)
  assert.equal(applyAlertTransition(anAlert(), { type: 'mute', durationMs: -1 }, 'owner', NOW).ok, false)
  const ok = applyAlertTransition(anAlert(), { type: 'mute', durationMs: DAY }, 'owner', NOW)
  assert.ok(ok.ok)
  assert.equal(ok.alert.mutedUntil, NOW + DAY)
  assert.equal(ok.alert.mutedBy, 'owner')
})

test('transition: unmute returns the alert to OPEN, and only applies to a muted alert', () => {
  const muted = applyAlertTransition(anAlert(), { type: 'mute', durationMs: DAY }, 'owner', NOW)
  assert.ok(muted.ok)
  const un = applyAlertTransition(muted.alert, { type: 'unmute' }, 'owner', NOW)
  assert.ok(un.ok)
  assert.equal(un.alert.status, 'OPEN')
  assert.equal(un.alert.mutedUntil, undefined)
  assert.equal(applyAlertTransition(anAlert(), { type: 'unmute' }, 'owner', NOW).ok, false)
})

test('transition: notes append, reject empty, and stay bounded', () => {
  assert.equal(applyAlertTransition(anAlert(), { type: 'note', note: '   ' }, 'owner', NOW).ok, false)
  let a = anAlert()
  for (let i = 0; i < 60; i++) {
    const r = applyAlertTransition(a, { type: 'note', note: `note ${i}` }, 'owner', NOW + i)
    assert.ok(r.ok)
    a = r.alert
  }
  assert.equal(a.notes.length, 50, 'oldest notes are dropped, not the newest')
  assert.equal(a.notes[49].note, 'note 59')
  assert.equal(a.notes[49].by, 'owner')
})

test('transition: a note over the cap is truncated, not rejected', () => {
  const r = applyAlertTransition(anAlert(), { type: 'note', note: 'x'.repeat(5000) }, 'owner', NOW)
  assert.ok(r.ok)
  assert.equal(r.alert.notes[0].note.length, 2000)
})

test('transition: the input alert is never mutated in place', () => {
  const original = anAlert()
  const snapshot = JSON.stringify(original)
  applyAlertTransition(original, { type: 'acknowledge' }, 'owner', NOW)
  applyAlertTransition(original, { type: 'note', note: 'hi' }, 'owner', NOW)
  applyAlertTransition(original, { type: 'mute', durationMs: DAY }, 'owner', NOW)
  assert.equal(JSON.stringify(original), snapshot)
})

test('transition: mark_read clears unread without changing status', () => {
  const r = applyAlertTransition(anAlert(), { type: 'mark_read' }, 'owner', NOW)
  assert.ok(r.ok)
  assert.equal(r.alert.unread, false)
  assert.equal(r.alert.status, 'OPEN')
})

// ── end-to-end over the shipped policy set ───────────────────────────────────

test('full policy set over a realistic mixed dataset: only the true conditions fire', () => {
  const jobs = [
    ...many(40, NOW - 10 * DAY, { comparison: AGREE, confidence: 0.8 }),   // healthy baseline
    ...many(40, NOW - 3 * DAY, { comparison: AGREE, confidence: 0.8 }),    // healthy current
    job({ bookingId: 'fn1', comparison: FALSE_NEGATIVE, completedAt: NOW - HOUR }),
  ]
  const r = evaluateShadowAlerts({ jobs, now: NOW, policies: DEFAULT_ALERT_POLICIES, priorReadiness: snap({ tier: 'READY_FOR_EXPANDED_SHADOW' }) })
  const fired = new Set(r.signals.map((s) => s.policyType))

  assert.ok(fired.has('critical_false_negative'), 'the one real problem is caught')
  assert.ok(fired.has('readiness_milestone_lost'), 'and its readiness consequence is reported')
  // Nothing else should be firing on healthy, steady data.
  for (const t of ['agreement_rate_drop', 'confidence_drop', 'manual_review_spike', 'auto_quote_rate_drop', 'latency_regression', 'cost_per_evaluation_spike', 'queue_backlog', 'stale_shadow_telemetry', 'evaluation_failure_spike'] as const) {
    assert.ok(!fired.has(t), `${t} must not fire on healthy data`)
  }

  const rec = reconcile([], r.signals)
  assert.equal(rec.opened.length, r.signals.length)
  assert.equal(rec.opened.filter((a) => a.severity === 'CRITICAL').length, 2)
})
