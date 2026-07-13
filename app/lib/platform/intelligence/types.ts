// ── Operational intelligence types ───────────────────────────────────────────
//
// An Insight is a governed, explainable observation about the business: what is
// happening, why it matters, what to do, and who may act. Generators are
// READ-ONLY and produce Insights from verified data. Nothing here fabricates —
// every Insight carries its evidence. See 07-ai-operating-layer.md.

import type { WorkerId } from '../ai-workers/types'

export type InsightCategory =
  | 'revenue' | 'profitability' | 'scheduling' | 'staffing' | 'customer-risk'
  | 'job-risk' | 'payment-risk' | 'equipment' | 'fleet' | 'compliance'
  | 'service-quality' | 'growth-opportunity' | 'cost-anomaly' | 'data-quality'
  | 'security' | 'automation-failure'

export type InsightSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export type AffectedEntity = { type: string; id: string; label?: string }

export type Insight = {
  id: string
  category: InsightCategory
  severity: InsightSeverity
  tenantId: string
  affectedEntity?: AffectedEntity
  title: string
  explanation: string // plain-language, owner-facing
  evidence: string[] // the facts that produced this insight (never empty)
  confidence: number // 0..1
  financialImpactCents?: number
  operationalImpact: string
  recommendedAction: string
  eligibleWorkerId?: WorkerId
  approvalRequired: boolean
  expiresAt?: number
  dismissed: boolean
  resolved: boolean
  generatedAt: number
}

export const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
}
