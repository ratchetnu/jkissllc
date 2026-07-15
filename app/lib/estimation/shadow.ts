// ── Shadow comparison (Phase 9) ──────────────────────────────────────────────
//
// When VISION_ESTIMATION_SHADOW is enabled, the new deterministic estimation engine
// runs ALONGSIDE the live/authoritative estimate WITHOUT ever affecting the customer.
// This module compares the two and records the difference for later analysis. The
// shadow result is NEVER shown to customers and NEVER changes a quote — it exists so
// we can measure the new engine against reality before it is ever promoted.
//
// buildShadowComparison is PURE (same inputs → same ShadowComparison). recordShadow-
// Comparison is FAIL-SOFT — it must never throw into the caller's request path — and
// it emits ONLY safe scalar fields (cents / version / delta / decisions / operational
// aggregates). No inventory, no item names, no addresses, no customer PII ever leaves
// this function.

import type { EstimationResult, ShadowComparison } from './types'
import { ESTIMATION_ENGINE_VERSION } from './types'
import { logger } from '../platform/observability/logger'

/** The live/authoritative estimate we compare the shadow engine against. */
export type CurrentEstimate = {
  recommendedUsd?: number    // dollars, as the live quote presents it today
  decision?: string          // the live decision label (e.g. 'auto' | 'manual_review')
}

/**
 * Compare a NEW (shadow) estimation result against the CURRENT authoritative estimate.
 * Pure — no I/O, no logging. `deltaPct` is null when there is no current estimate to
 * compare against (or the current is zero), because a percentage delta is undefined.
 */
export function buildShadowComparison(
  newResult: EstimationResult,
  current?: CurrentEstimate,
): ShadowComparison {
  const newRecommendedCents = Math.round(newResult.pricing.recommendedCents)

  const hasCurrent = current?.recommendedUsd != null && Number.isFinite(current.recommendedUsd)
  const currentRecommendedCents = hasCurrent
    ? Math.round((current!.recommendedUsd as number) * 100)
    : undefined

  // Delta is only meaningful when we have something to compare against; otherwise 0.
  const deltaCents = currentRecommendedCents == null ? 0 : newRecommendedCents - currentRecommendedCents

  // Percentage delta is undefined without a non-zero baseline → null (never fabricate).
  const deltaPct = currentRecommendedCents == null || currentRecommendedCents === 0
    ? null
    : Math.round((deltaCents / currentRecommendedCents) * 10_000) / 100   // 2-dp percent

  return {
    bookingId: newResult.bookingId,
    currentRecommendedCents,
    newRecommendedCents,
    deltaCents,
    deltaPct,
    newDecision: newResult.manualReviewRequired ? 'manual_review' : 'auto',
    currentDecision: current?.decision,
    volumeCubicYards: newResult.volume.cubicYards.expected,
    truckLoads: newResult.volume.truckLoads.expected,
    manualReviewRequired: newResult.manualReviewRequired,
    engineVersion: newResult.engineVersion ?? ESTIMATION_ENGINE_VERSION,
  }
}

/** Optional context + an injectable sink (for tests). Only opaque ids are accepted. */
export type ShadowRecordCtx = {
  correlationId?: string
  tenantId?: string
  // Injectable emit for tests; defaults to the structured logger. Fields passed here
  // are already the SAFE allow-listed payload built below.
  sink?: (msg: string, fields: Record<string, unknown>) => void
}

// The EXHAUSTIVE set of keys we ever log for a shadow comparison. Everything here is a
// scalar number / short label / boolean — no inventory, item names, notes, addresses,
// or any customer-authored text. Kept as a named constant so the test can prove it.
export const SHADOW_LOG_SAFE_KEYS = [
  'event',
  'engineVersion',
  'newRecommendedCents',
  'currentRecommendedCents',
  'deltaCents',
  'deltaPct',
  'newDecision',
  'currentDecision',
  'volumeCubicYards',
  'truckLoads',
  'manualReviewRequired',
  'bookingId',
  'correlationId',
  'tenantId',
] as const

/**
 * Record a shadow comparison for later analysis. FAIL-SOFT: any error is swallowed so
 * the caller's request path is never affected. Emits ONLY the safe allow-listed fields
 * above — this is the ONLY sink for shadow differences and it is NEVER customer-facing.
 */
export function recordShadowComparison(cmp: ShadowComparison, ctx: ShadowRecordCtx = {}): void {
  try {
    // Build the payload EXPLICITLY (never spread the full comparison / result) so only
    // the allow-listed safe fields can ever be emitted.
    const fields: Record<string, unknown> = {
      event: 'vision:shadow-comparison',
      engineVersion: cmp.engineVersion,
      newRecommendedCents: cmp.newRecommendedCents,
      currentRecommendedCents: cmp.currentRecommendedCents,
      deltaCents: cmp.deltaCents,
      deltaPct: cmp.deltaPct,
      newDecision: cmp.newDecision,
      currentDecision: cmp.currentDecision,
      volumeCubicYards: cmp.volumeCubicYards,
      truckLoads: cmp.truckLoads,
      manualReviewRequired: cmp.manualReviewRequired,
    }
    if (cmp.bookingId) fields.bookingId = cmp.bookingId
    if (ctx.correlationId) fields.correlationId = ctx.correlationId
    if (ctx.tenantId) fields.tenantId = ctx.tenantId

    if (ctx.sink) ctx.sink('vision:shadow-comparison', fields)
    else logger.info('vision:shadow-comparison', fields)
  } catch (e) {
    // Telemetry must never break the request path (fail-soft) — and even the failure
    // log must not throw.
    try { console.error('[estimation/shadow] record failed', e) } catch { /* noop */ }
  }
}
