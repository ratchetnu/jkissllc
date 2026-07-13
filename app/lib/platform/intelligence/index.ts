// ── Insight runner + prioritization ──────────────────────────────────────────
//
// Runs the read-only generators over a data snapshot, stamps the tenant, and
// prioritizes. Gated by INSIGHTS_UI_ENABLED — off by default, so no live path
// surfaces insights this sprint. The runner takes an already-fetched snapshot
// (dependency-injected), keeping it pure and testable; wiring it to a live route
// is a deferred, flagged step.

import { isEnabled } from '../flags'
import type { Insight } from './types'
import { SEVERITY_RANK } from './types'
import {
  unconfirmedUpcomingAssignments, aiCostBudgetWarning, overdueReminders, pricingCalibrationDrift,
  type UpcomingRoute, type AiBudgetSnapshot, type OverdueReminder, type PricingAccuracySnapshot,
} from './generators'

export * from './types'
export * from './generators'

export type InsightSnapshot = {
  tenantId: string
  now: number
  routes?: UpcomingRoute[]
  aiBudget?: AiBudgetSnapshot
  overdueReminders?: OverdueReminder[]
  pricingAccuracy?: PricingAccuracySnapshot
}

/** Highest severity first, then confidence, then financial impact. */
export function prioritizeInsights(insights: Insight[]): Insight[] {
  return [...insights].sort((a, b) => {
    const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (s !== 0) return s
    const c = b.confidence - a.confidence
    if (c !== 0) return c
    return (b.financialImpactCents ?? 0) - (a.financialImpactCents ?? 0)
  })
}

export function runInsightGenerators(snap: InsightSnapshot): Insight[] {
  // Hard off-switch: when the presentation flag is off, produce nothing so this
  // can never leak into a live surface unexpectedly.
  if (!isEnabled('INSIGHTS_UI_ENABLED')) return []
  const all: Insight[] = [
    ...(snap.routes ? unconfirmedUpcomingAssignments(snap.routes, snap.now) : []),
    ...(snap.aiBudget ? aiCostBudgetWarning(snap.aiBudget, snap.now) : []),
    ...(snap.overdueReminders ? overdueReminders(snap.overdueReminders, snap.now) : []),
    ...(snap.pricingAccuracy ? pricingCalibrationDrift(snap.pricingAccuracy, snap.now) : []),
  ].map((i) => ({ ...i, tenantId: snap.tenantId }))
  return prioritizeInsights(all)
}

/**
 * Pure variant that ALWAYS runs the generators regardless of the flag — for tests
 * and for callers that have already gated on the flag themselves.
 */
export function computeInsights(snap: InsightSnapshot): Insight[] {
  const all: Insight[] = [
    ...(snap.routes ? unconfirmedUpcomingAssignments(snap.routes, snap.now) : []),
    ...(snap.aiBudget ? aiCostBudgetWarning(snap.aiBudget, snap.now) : []),
    ...(snap.overdueReminders ? overdueReminders(snap.overdueReminders, snap.now) : []),
    ...(snap.pricingAccuracy ? pricingCalibrationDrift(snap.pricingAccuracy, snap.now) : []),
  ].map((i) => ({ ...i, tenantId: snap.tenantId }))
  return prioritizeInsights(all)
}
