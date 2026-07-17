// ── Operion Shadow Alerting — the shipped policy set + safe defaults (PURE) ──
//
// One entry per AlertPolicyType. These defaults are deliberately CONSERVATIVE: at J KISS's
// current shadow throughput (the worker processes at most 1 job per tenant per 10-minute
// tick — a ceiling of ~6 evaluations/hour) a chatty policy would produce noise, not signal.
// Every comparative policy therefore demands a real sample on BOTH sides of the comparison
// and a fully-covered baseline window before it may fire.
//
// Defaults live in code, not in Redis: the shipped policy set must be reviewable in a diff
// and identical across environments. Owner overrides land in Increment 3 (preferences).

import type { AlertPolicy, AlertPolicyType } from './shadow-alert-types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The default policies. Ordered by the severity of what they catch, most serious first.
 *
 * Threshold units, so a reader never has to guess:
 *  • agreement / manual-review / auto-quote / failure rates → PERCENTAGE POINTS (0–100)
 *  • confidence                                             → SCORE POINTS (0–1)
 *  • latency / cost                                         → RATIO multiplier (1.5 = +50%)
 *  • queue backlog / sample volume                          → COUNT
 *  • stale telemetry                                        → MILLISECONDS
 */
export const DEFAULT_ALERT_POLICIES: readonly AlertPolicy[] = [
  {
    id: 'critical-false-negative',
    type: 'critical_false_negative',
    kind: 'per_item',
    enabled: true,
    severity: 'CRITICAL',
    comparison: 'count_at_least',
    threshold: 1,                  // a single one matters — this is the unsafe direction
    windowMs: 7 * DAY,
    minSampleSize: 1,
    scope: {},
    fanOut: 'none',
    cooldownMs: 0,                 // never suppress a distinct safety event
    channels: ['in_app', 'email'],
    requiresAck: true,             // an owner must look at it; it cannot self-clear
    escalateAfterMs: 24 * HOUR,
    description: 'V2 auto-quoted a booking where V1 required manual review — V2 may have missed a real blocker.',
  },
  {
    id: 'readiness-milestone-lost',
    type: 'readiness_milestone_lost',
    kind: 'aggregate',
    enabled: true,
    severity: 'CRITICAL',
    comparison: 'tier_downgrade',
    threshold: 1,                  // any downward tier move
    windowMs: 30 * DAY,
    minSampleSize: 30,             // matches DEFAULT_READINESS_THRESHOLDS.minSample
    scope: {},
    fanOut: 'none',
    cooldownMs: 6 * HOUR,
    channels: ['in_app', 'email'],
    requiresAck: true,
    escalateAfterMs: 24 * HOUR,
    description: 'Model readiness moved DOWN a tier — the model got further from promotion, not closer.',
  },
  {
    id: 'high-severity-disagreement',
    type: 'high_severity_disagreement',
    kind: 'per_item',
    enabled: true,
    severity: 'WARNING',
    comparison: 'count_at_least',
    threshold: 1,
    windowMs: 7 * DAY,
    minSampleSize: 1,
    scope: {},
    fanOut: 'none',
    cooldownMs: 0,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'A high-severity V1/V2 disagreement was detected (large price gap or a missed review).',
  },
  {
    id: 'agreement-rate-drop',
    type: 'agreement_rate_drop',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'drop_at_least',
    threshold: 10,                 // percentage points
    windowMs: 7 * DAY,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 30,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app', 'email'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'V1/V2 agreement fell materially versus the previous window.',
  },
  {
    id: 'manual-review-spike',
    type: 'manual_review_spike',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'rise_at_least',
    threshold: 15,                 // percentage points
    windowMs: 7 * DAY,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 30,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'V2 is sending materially more bookings to manual review than it was.',
  },
  {
    id: 'confidence-drop',
    type: 'confidence_drop',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'drop_at_least',
    threshold: 0.1,                // score points on the 0–1 confidenceScore
    windowMs: 7 * DAY,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 30,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'V2 average confidence fell versus the previous window.',
  },
  {
    id: 'evaluation-failure-spike',
    type: 'evaluation_failure_spike',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'rise_at_least',
    threshold: 20,                 // percentage points of failure rate
    windowMs: 24 * HOUR,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 10,             // terminal jobs, not evaluations — failures never reach comparison
    scope: {},
    fanOut: 'none',
    cooldownMs: 6 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 7 * DAY,
    description: 'Shadow evaluations are failing at a materially higher rate than the baseline.',
  },
  {
    id: 'latency-regression',
    type: 'latency_regression',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'ratio_increase',
    threshold: 1.5,                // +50% average latency
    windowMs: 7 * DAY,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 20,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'Average shadow evaluation latency regressed versus the previous window.',
  },
  {
    id: 'model-prompt-regression',
    type: 'model_prompt_regression',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'drop_at_least',
    threshold: 10,                 // percentage points below the best peer deployment
    windowMs: 30 * DAY,
    minSampleSize: 30,
    scope: {},
    fanOut: 'deployment',          // one signal per model×prompt×estimator combo
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'This model/prompt deployment agrees with V1 materially less than the best peer deployment.',
  },
  {
    id: 'queue-backlog',
    type: 'queue_backlog',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'above_absolute',
    threshold: 25,                 // queued jobs; the worker drains ~6/hour, so 25 is ~4h deep
    windowMs: 30 * DAY,            // backlog is a live count; the window only bounds the read
    minSampleSize: 0,
    scope: {},
    fanOut: 'none',
    cooldownMs: 6 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 7 * DAY,
    description: 'Queued shadow jobs are piling up faster than the worker drains them.',
  },
  {
    id: 'auto-quote-rate-drop',
    type: 'auto_quote_rate_drop',
    kind: 'aggregate',
    enabled: true,
    severity: 'INFO',
    comparison: 'drop_at_least',
    threshold: 15,                 // percentage points
    windowMs: 7 * DAY,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 30,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'V2 is auto-quoting materially less often — the automation upside is shrinking.',
  },
  {
    id: 'cost-per-evaluation-spike',
    type: 'cost_per_evaluation_spike',
    kind: 'aggregate',
    enabled: true,
    severity: 'INFO',
    comparison: 'ratio_increase',
    threshold: 1.5,                // +50% average cost per evaluation
    windowMs: 7 * DAY,
    baselineWindowMs: 7 * DAY,
    minSampleSize: 20,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'Average cost per shadow evaluation rose materially versus the previous window.',
  },
  {
    id: 'readiness-milestone-reached',
    type: 'readiness_milestone_reached',
    kind: 'aggregate',
    enabled: true,
    severity: 'INFO',
    comparison: 'tier_upgrade',
    threshold: 1,
    windowMs: 30 * DAY,
    minSampleSize: 30,
    scope: {},
    fanOut: 'none',
    cooldownMs: 6 * HOUR,
    channels: ['in_app', 'email'],
    requiresAck: false,
    expireAfterMs: 30 * DAY,
    description: 'Model readiness moved UP a tier. Informational only — no model is promoted automatically.',
  },
  {
    id: 'stale-shadow-telemetry',
    type: 'stale_shadow_telemetry',
    kind: 'aggregate',
    enabled: true,
    severity: 'WARNING',
    comparison: 'above_absolute',
    threshold: 3 * DAY,            // ms since the most recent evaluation landed
    windowMs: 30 * DAY,
    minSampleSize: 0,
    scope: {},
    fanOut: 'none',
    cooldownMs: 24 * HOUR,
    channels: ['in_app'],
    requiresAck: false,
    description: 'No shadow evaluation has completed in days — the shadow pipeline may be silently dead.',
  },
  {
    id: 'insufficient-sample-volume',
    type: 'insufficient_sample_volume',
    kind: 'aggregate',
    enabled: false,                // OFF by default: true today and not actionable — it would
                                   // just nag until shadow traffic expands. Owner opt-in.
    severity: 'INFO',
    comparison: 'below_absolute',
    threshold: 30,                 // evaluated jobs in the window (DEFAULT_READINESS_THRESHOLDS.minSample)
    windowMs: 30 * DAY,
    minSampleSize: 0,
    scope: {},
    fanOut: 'none',
    cooldownMs: 7 * DAY,
    channels: ['in_app'],
    requiresAck: false,
    description: 'Too few evaluated shadow jobs to judge the model — readiness cannot progress without more traffic.',
  },
]

/** Safety-critical policies may not be silently disabled — the owner must be warned first
 *  (enforced at the preferences layer in Increment 3). */
export const SAFETY_CRITICAL_TYPES: readonly AlertPolicyType[] = [
  'critical_false_negative',
  'readiness_milestone_lost',
] as const

export const isSafetyCritical = (p: AlertPolicy): boolean => SAFETY_CRITICAL_TYPES.includes(p.type)

export function policyById(id: string, policies: readonly AlertPolicy[] = DEFAULT_ALERT_POLICIES): AlertPolicy | null {
  return policies.find((p) => p.id === id) ?? null
}
