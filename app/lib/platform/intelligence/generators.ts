// ── Read-only insight generators ─────────────────────────────────────────────
//
// Exactly three generators, each PURE over an injected snapshot of real data (the
// live fetch + presentation is deferred and flag-gated by INSIGHTS_UI_ENABLED, so
// nothing runs in production yet). Every Insight cites its evidence; none are
// fabricated. The input shapes are minimal projections of existing entities:
//   - routes/assignees (app/lib/routes.ts)          → unconfirmed assignments
//   - AI daily cost vs cap (app/lib/ai/budget.ts)   → cost-budget warning
//   - reminder sends awaiting ack (app/lib/reminders.ts) → overdue reminders

import type { Insight, InsightSeverity } from './types'

// ── 1. Unconfirmed upcoming assignments ──────────────────────────────────────
export type UpcomingRoute = {
  id: string
  routeNumber: string
  startsInHours: number // hours until the route starts (>= 0)
  assignees: { name: string; confirmed: boolean }[]
}

export function unconfirmedUpcomingAssignments(routes: UpcomingRoute[], now: number): Insight[] {
  const out: Insight[] = []
  for (const r of routes) {
    if (r.startsInHours < 0 || r.startsInHours > 48) continue
    const unconfirmed = r.assignees.filter((a) => !a.confirmed)
    if (unconfirmed.length === 0) continue
    const severity: InsightSeverity = r.startsInHours <= 12 ? 'high' : r.startsInHours <= 24 ? 'medium' : 'low'
    out.push({
      id: `insight:unconfirmed:${r.id}`,
      category: 'scheduling',
      severity,
      tenantId: '', // stamped by the runner
      affectedEntity: { type: 'route', id: r.id, label: r.routeNumber },
      title: `${unconfirmed.length} unconfirmed on ${r.routeNumber}`,
      explanation: `${r.routeNumber} starts in ${Math.round(r.startsInHours)}h and ${unconfirmed.map((a) => a.name).join(', ')} ${unconfirmed.length === 1 ? 'has' : 'have'} not confirmed.`,
      evidence: [`${unconfirmed.length}/${r.assignees.length} assignees unconfirmed`, `starts in ${Math.round(r.startsInHours)}h`],
      confidence: 0.95,
      operationalImpact: 'Risk of an uncovered route if crew do not confirm.',
      recommendedAction: 'Send a confirmation nudge or reassign.',
      eligibleWorkerId: 'ai-dispatcher',
      approvalRequired: true, // a nudge/reassign is a Level-3 action
      dismissed: false,
      resolved: false,
      generatedAt: now,
    })
  }
  return out
}

// ── 2. AI cost-budget warning ────────────────────────────────────────────────
export type AiBudgetSnapshot = { spentUsd: number; capUsd: number }

export function aiCostBudgetWarning(snap: AiBudgetSnapshot, now: number): Insight[] {
  if (!snap.capUsd || snap.capUsd <= 0) return [] // no cap configured → nothing to warn
  const ratio = snap.spentUsd / snap.capUsd
  if (ratio < 0.8) return []
  const severity: InsightSeverity = ratio >= 1 ? 'critical' : ratio >= 0.9 ? 'high' : 'medium'
  return [{
    id: 'insight:ai-budget',
    category: 'cost-anomaly',
    severity,
    tenantId: '',
    title: `AI spend at ${Math.round(ratio * 100)}% of the daily cap`,
    explanation: `Today's AI cost is $${snap.spentUsd.toFixed(2)} against a $${snap.capUsd.toFixed(2)} cap.`,
    evidence: [`spent $${snap.spentUsd.toFixed(2)}`, `cap $${snap.capUsd.toFixed(2)}`, `${Math.round(ratio * 100)}%`],
    confidence: 1,
    financialImpactCents: Math.round(snap.spentUsd * 100),
    operationalImpact: ratio >= 1 ? 'AI features are failing soft (over budget).' : 'AI features may soon fail soft.',
    recommendedAction: 'Review AI usage or raise the daily cap.',
    eligibleWorkerId: 'ai-finance',
    approvalRequired: false, // informational
    dismissed: false,
    resolved: false,
    generatedAt: now,
  }]
}

// ── 3. Overdue reminders ─────────────────────────────────────────────────────
export type OverdueReminder = {
  id: string
  title: string
  staffName: string
  overdueHours: number // hours past due without acknowledgement
}

export function overdueReminders(reminders: OverdueReminder[], now: number): Insight[] {
  return reminders
    .filter((r) => r.overdueHours > 0)
    .map((r) => {
      const severity: InsightSeverity = r.overdueHours >= 24 ? 'high' : r.overdueHours >= 6 ? 'medium' : 'low'
      return {
        id: `insight:overdue-reminder:${r.id}`,
        category: 'automation-failure',
        severity,
        tenantId: '',
        affectedEntity: { type: 'reminder', id: r.id, label: r.title },
        title: `Overdue: "${r.title}" (${r.staffName})`,
        explanation: `${r.staffName}'s reminder "${r.title}" is ${Math.round(r.overdueHours)}h past due with no acknowledgement.`,
        evidence: [`${Math.round(r.overdueHours)}h overdue`, 'no acknowledgement'],
        confidence: 0.9,
        operationalImpact: 'A required task may be missed.',
        recommendedAction: 'Escalate or follow up with the crew member.',
        eligibleWorkerId: 'ai-workforce',
        approvalRequired: true,
        dismissed: false,
        resolved: false,
        generatedAt: now,
      }
    })
}
