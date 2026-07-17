// ── Operion Shadow Alerting — policy + alert type model (PURE types) ─────────
//
// The deterministic vocabulary for "tell the owner when something important happened
// to the V2 shadow model". Types only — no I/O, no clock, no defaults (see
// shadow-alert-policies.ts for the shipped policy set and shadow-alert-engine.ts for
// the evaluator).
//
// Scope: alerting is an OBSERVER of the persisted shadow jobs. It promotes no model,
// enables no shadow traffic, and changes no customer behavior. Gated by
// SHADOW_ALERTING_ENABLED at the route/cron layer.

import type { ReadinessTier } from './shadow-analytics'

// Mirrors the ops severity vocabulary in app/lib/alerts.ts on purpose — one severity
// language across the platform. (Kept as its own type so the shadow alert store never
// depends on the ops alert transport.)
export type AlertSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

export const SEVERITY_RANK: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 }

/** The 15 shipped policy types. A type fixes WHAT is measured; a policy fixes the thresholds. */
export type AlertPolicyType =
  | 'critical_false_negative'      // V2 auto-quoted where V1 required review (the dangerous direction)
  | 'high_severity_disagreement'   // any high-severity disagreement from detectDisagreements
  | 'agreement_rate_drop'          // agreement% fell vs the prior window
  | 'confidence_drop'              // avg confidence score fell vs the prior window
  | 'manual_review_spike'          // V2 manual-review rate rose vs the prior window
  | 'auto_quote_rate_drop'         // V2 auto-quote rate fell vs the prior window
  | 'latency_regression'           // avg latency rose by a ratio vs the prior window
  | 'evaluation_failure_spike'     // shadow job failure rate rose vs the prior window
  | 'queue_backlog'                // queued shadow jobs above an absolute ceiling
  | 'cost_per_evaluation_spike'    // avg $/evaluation rose by a ratio vs the prior window
  | 'model_prompt_regression'      // a deployment underperforms the best peer deployment
  | 'readiness_milestone_reached'  // readiness tier moved UP
  | 'readiness_milestone_lost'     // readiness tier moved DOWN
  | 'insufficient_sample_volume'   // not enough evaluated jobs to judge the model at all
  | 'stale_shadow_telemetry'       // no shadow evaluation has landed in too long

export const ALL_POLICY_TYPES: readonly AlertPolicyType[] = [
  'critical_false_negative', 'high_severity_disagreement', 'agreement_rate_drop', 'confidence_drop',
  'manual_review_spike', 'auto_quote_rate_drop', 'latency_regression', 'evaluation_failure_spike',
  'queue_backlog', 'cost_per_evaluation_spike', 'model_prompt_regression', 'readiness_milestone_reached',
  'readiness_milestone_lost', 'insufficient_sample_volume', 'stale_shadow_telemetry',
] as const

/**
 * How a policy emits signals — intrinsic to the type, NOT owner-editable.
 *  • per_item   → one signal per offending evaluation (each is its own safety event).
 *                 Never auto-resolves: a false negative that scrolls out of the window
 *                 has not been fixed, it has only aged.
 *  • aggregate  → one signal per scope, describing a population-level condition.
 *                 Auto-resolves when the condition clears (recovery detection).
 */
export type PolicyKind = 'per_item' | 'aggregate'

/** How `threshold` is compared against `observed` (and, where relevant, `comparison`). */
export type ThresholdComparison =
  | 'count_at_least'      // observed >= threshold                      (counts)
  | 'above_absolute'      // observed >  threshold                      (absolute ceiling)
  | 'below_absolute'      // observed <  threshold                      (absolute floor)
  | 'drop_at_least'       // comparison - observed >= threshold         (regression, absolute units)
  | 'rise_at_least'       // observed - comparison >= threshold         (spike, absolute units)
  | 'ratio_increase'      // observed >= comparison * threshold         (multiplicative spike)
  | 'tier_upgrade'        // readiness tier rank increased
  | 'tier_downgrade'      // readiness tier rank decreased

/** Which dimension a policy fans out across before evaluating. */
export type PolicyFanOut = 'none' | 'model' | 'deployment'

/** Narrows the jobs a policy sees. Mirrors ShadowFilter's dimensions (shadow-facets.ts). */
export type PolicyScope = {
  model?: string
  deployment?: string
  /** Business scope is carried end-to-end but is INERT today: V2ShadowJob has no
   *  businessId (single-tenant), so jobBusiness() is always null and a business-scoped
   *  policy would match nothing. Set only once jobs are tenant-tagged. */
  business?: string
}

/** Where a fired alert is delivered. In-app is the only channel Increment 1 persists. */
export type AlertChannel = 'in_app' | 'email'

export type AlertPolicy = {
  id: string                       // stable slug, also the dedup-key prefix
  type: AlertPolicyType
  kind: PolicyKind
  enabled: boolean
  severity: AlertSeverity
  comparison: ThresholdComparison
  threshold: number
  /** Trailing measurement window, ms. The current window is [now - windowMs, now). */
  windowMs: number
  /** Prior window for comparison policies, ms. Baseline is
   *  [now - windowMs - baselineWindowMs, now - windowMs). Omit for non-comparative types. */
  baselineWindowMs?: number
  /** Below this many evaluated jobs in a window, the policy SKIPS rather than fires.
   *  This is what stops a 3-job dataset from screaming. */
  minSampleSize: number
  scope: PolicyScope
  fanOut: PolicyFanOut
  /** After an alert for the same dedup key resolves/expires, suppress re-opening for this long. */
  cooldownMs: number
  channels: AlertChannel[]
  /** OPEN alerts of this policy must be acknowledged by the owner (never auto-resolved). */
  requiresAck: boolean
  /** If OPEN + unacknowledged for this long, stamp escalatedAt. No transport in Increment 1. */
  escalateAfterMs?: number
  /** OPEN alerts with no fresh detection for this long are EXPIRED. Aggregate policies only. */
  expireAfterMs?: number
  description: string
}

// ── Alert lifecycle ──────────────────────────────────────────────────────────
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'MUTED' | 'EXPIRED'

/** Terminal for the purpose of dedup: a new signal may re-open (subject to cooldown). */
export const ALERT_TERMINAL: readonly AlertStatus[] = ['RESOLVED', 'EXPIRED'] as const
/** A signal matching one of these updates the existing alert instead of opening a new one. */
export const ALERT_ACTIVE: readonly AlertStatus[] = ['OPEN', 'ACKNOWLEDGED'] as const

/** A point-in-time readiness reading, persisted so TRANSITIONS can be detected.
 *  This is the only state the alert engine needs that the job set cannot re-derive. */
export type ReadinessSnapshot = {
  at: number
  scope: string                    // 'global' or a deployment/model key
  tier: ReadinessTier
  score: number
  evaluated: number
  agreementPct: number
  falseNegatives: number
  blockers: string[]
  reasons: string[]
}

/** What the evaluator emits. Not yet an alert — the reconciler decides open/dedup/suppress. */
export type AlertSignal = {
  policyId: string
  policyType: AlertPolicyType
  severity: AlertSeverity
  /** Stable identity of the CONDITION. Two runs observing the same condition produce the
   *  same key ⇒ dedup. Aggregate: `{policyId}:{scopeKey}`. Per-item: `{policyId}:{bookingId}`. */
  dedupKey: string
  scopeKey: string                 // 'global' | model | deployment key
  reason: string                   // plain-language, owner-facing
  observed: number
  threshold: number
  comparison: number | null        // the baseline/peer value, when the policy is comparative
  sampleSize: number
  model?: string
  deployment?: string
  business?: string
  relatedBookingIds: string[]
  relatedTraceIds: string[]
  readiness: ReadinessSnapshot | null
  at: number
}

/** Why a policy did NOT produce a signal. Surfaced for observability — a silent skip is a lie. */
export type SkipReason =
  | 'disabled'
  | 'insufficient_sample'
  | 'incomplete_window'
  | 'no_baseline'
  | 'no_data'
  | 'not_applicable'

export type PolicySkip = {
  policyId: string
  policyType: AlertPolicyType
  scopeKey: string
  reason: SkipReason
  detail: string
}

export type AlertNote = { note: string; by: string; at: number }

/** The durable alert record. */
export type ShadowAlert = {
  alertVersion: number
  id: string                       // SAL-{n}
  policyId: string
  policyType: AlertPolicyType
  severity: AlertSeverity
  status: AlertStatus
  dedupKey: string
  scopeKey: string
  reason: string
  observed: number
  threshold: number
  comparison: number | null
  sampleSize: number
  model?: string
  deployment?: string
  business?: string
  firstDetectedAt: number
  lastDetectedAt: number
  occurrences: number
  acknowledgedAt?: number
  acknowledgedBy?: string
  resolvedAt?: number
  resolvedBy?: string              // 'system' when recovery-detected
  resolvedReason?: string
  mutedUntil?: number
  mutedBy?: string
  escalatedAt?: number
  relatedBookingIds: string[]
  relatedTraceIds: string[]
  readiness: ReadinessSnapshot | null
  notes: AlertNote[]
  /** Set once the notification abstraction has delivered this alert (Increment 2/3). */
  deliveredChannels?: AlertChannel[]
  unread: boolean
}

export const SHADOW_ALERT_VERSION = 1
