// ── Operion AI — live deterministic alerts (PURE) ────────────────────────────
//
// A "what is wrong with the AI right now" derivation over CURRENT metrics. Distinct from the
// background alerting subsystem (shadow-alert-*, gated by SHADOW_ALERTING_ENABLED and dormant):
// this makes NO persistence, NO cron, NO AI — it reads the numbers the Command Center already
// computes and turns them into a ranked, deduplicated alert list on every page load.
//
// Deterministic: same state in → same alerts out. Every alert names its condition (a stable
// `key` for dedup), a severity, a plain reason, the affected system, a recommended action, and
// a direct link to the section that resolves it.

export type AiAlertSeverity = 'critical' | 'warning' | 'attention' | 'informational'

export const SEVERITY_RANK: Record<AiAlertSeverity, number> = { critical: 0, warning: 1, attention: 2, informational: 3 }

export type AiAlert = {
  key: string                    // stable identity of the CONDITION — one per underlying cause (dedup)
  severity: AiAlertSeverity
  title: string
  reason: string
  system: 'shadow' | 'budget' | 'readiness' | 'config' | 'provider'
  action: string
  href: string
}

/** Everything the alert rules read — all already computed elsewhere, passed in so this stays pure. */
export type AiAlertState = {
  // queue / evaluation health
  failed: number
  retriesToday: number
  preventedRetriesToday: number
  budgetBlockedToday: number
  awaitingGroundTruth: number
  needingReview: number
  lastEvaluationAt: number | null
  now: number
  // accuracy / evidence
  completedEvaluations: number
  groundTruthCount: number
  groundTruthCoveragePct: number
  avgV2ErrorPct: number | null
  avgImprovementPct: number | null
  // budget
  evalsToday: number
  maxEvalsPerDay: number
  costTodayUsd: number
  maxDailyCostUsd: number
  spendAllowed: boolean
  spendBlockReason: string | null
  killed: boolean
  // readiness
  readinessTier: string
  readinessBlockers: string[]
  // config
  configMismatches: string[]      // human-readable, e.g. "worker off while queue enabled"
  staleVersion: boolean           // a prompt/estimator version drift the owner should know about
}

const DAY = 86_400_000
const AI = '/admin/operations/ai'

/**
 * Derive the live alert list. Rules run in a fixed order and each appends at most one alert per
 * condition, so the same underlying problem never produces two rows. Sorted by severity, then a
 * stable key so the order never wobbles between refreshes.
 */
export function deriveAiAlerts(s: AiAlertState): AiAlert[] {
  const out: AiAlert[] = []
  const push = (a: AiAlert) => out.push(a)

  // ── Safety / operational (shadow + budget + provider) ──────────────────────
  if (s.killed) {
    push({ key: 'kill_switch_active', severity: 'critical', title: 'V2 inference halted', reason: 'The kill switch is engaged — no new shadow evaluations will run.', system: 'shadow', action: 'Resume V2 in Usage & Controls once it is safe.', href: `${AI}/usage` })
  }
  if (!s.spendAllowed && !s.killed) {
    push({ key: 'budget_exhausted', severity: 'warning', title: 'Daily AI budget reached', reason: s.spendBlockReason ?? 'A budget cap is stopping new evaluations today.', system: 'budget', action: 'Review caps in Usage & Controls; they reset at UTC midnight.', href: `${AI}/usage` })
  } else if (s.spendAllowed && s.maxDailyCostUsd > 0 && s.costTodayUsd >= s.maxDailyCostUsd * 0.8) {
    push({ key: 'budget_warning', severity: 'attention', title: 'Approaching daily AI budget', reason: `Spent $${round(s.costTodayUsd)} of the $${s.maxDailyCostUsd} daily cap.`, system: 'budget', action: 'No action needed yet — evaluations pause automatically at the cap.', href: `${AI}/usage` })
  }
  if (s.failed > 0) {
    push({ key: 'failed_evaluations', severity: 'warning', title: `${s.failed} failed evaluation${s.failed > 1 ? 's' : ''}`, reason: 'One or more shadow evaluations failed and need owner attention.', system: 'shadow', action: 'Resolve or retry them in the Evaluation Queue.', href: `${AI}/queue?tier=needs_intervention` })
  }
  if (s.preventedRetriesToday >= 2) {
    push({ key: 'provider_failures', severity: 'attention', title: 'Repeated provider failures', reason: `${s.preventedRetriesToday} permanent provider failure(s) today (billing/auth/schema) were not retried.`, system: 'provider', action: 'Check AI Gateway credits and configuration.', href: `${AI}/usage` })
  }
  if (s.retriesToday >= 10) {
    push({ key: 'excessive_retries', severity: 'attention', title: 'Excessive retries', reason: `${s.retriesToday} retries today — the provider may be flaky.`, system: 'provider', action: 'Watch the usage trend; no immediate action required.', href: `${AI}/usage` })
  }

  // ── Freshness ──────────────────────────────────────────────────────────────
  if (s.lastEvaluationAt !== null && s.now - s.lastEvaluationAt > 3 * DAY) {
    const days = Math.round((s.now - s.lastEvaluationAt) / DAY)
    push({ key: 'stale_evaluations', severity: 'attention', title: 'Shadow evaluations are stale', reason: `No evaluation has completed in ${days} days — the shadow pipeline may be idle.`, system: 'shadow', action: 'Select and run bookings in the Evaluation Queue.', href: `${AI}/queue` })
  }

  // ── Owner-review backlog ───────────────────────────────────────────────────
  if (s.needingReview > 0) {
    push({ key: 'needs_review', severity: 'attention', title: `${s.needingReview} awaiting review`, reason: 'V2 flagged evaluations for manual review that no one has read.', system: 'shadow', action: 'Work the review tier in the Evaluation Queue.', href: `${AI}/queue?tier=awaiting_review` })
  }
  if (s.awaitingGroundTruth > 0) {
    push({ key: 'missing_ground_truth', severity: 'attention', title: `${s.awaitingGroundTruth} missing ground truth`, reason: 'Completed evaluations have no owner-confirmed quote, so they cannot be scored.', system: 'shadow', action: 'Record ground truth in the Evaluation Queue.', href: `${AI}/queue?tier=missing_ground_truth` })
  }

  // ── Evidence coverage ──────────────────────────────────────────────────────
  if (s.completedEvaluations >= 5 && s.groundTruthCoveragePct < 40) {
    push({ key: 'low_ground_truth_coverage', severity: 'attention', title: 'Low ground-truth coverage', reason: `Only ${round(s.groundTruthCoveragePct)}% of completed evaluations have ground truth — accuracy metrics are thin.`, system: 'readiness', action: 'Record more ground truth to strengthen the evidence.', href: `${AI}/queue?tier=missing_ground_truth` })
  }
  if (s.groundTruthCount > 0 && s.groundTruthCount < 20) {
    push({ key: 'low_evaluation_coverage', severity: 'informational', title: 'Limited evidence volume', reason: `${s.groundTruthCount} verified evaluation(s) — not yet enough to judge the model.`, system: 'readiness', action: 'Keep running and benchmarking evaluations.', href: `${AI}/performance` })
  }

  // ── Accuracy / regression ──────────────────────────────────────────────────
  if (s.groundTruthCount >= 8 && (s.avgV2ErrorPct ?? 0) >= 20) {
    push({ key: 'high_v2_error', severity: 'warning', title: 'High V2 error', reason: `V2 is averaging ${round(s.avgV2ErrorPct ?? 0)}% error against ground truth.`, system: 'readiness', action: 'Inspect error-by-category in Performance.', href: `${AI}/performance` })
  }
  if (s.groundTruthCount >= 8 && (s.avgImprovementPct ?? 0) < 0) {
    push({ key: 'v2_regression', severity: 'warning', title: 'V2 is behind V1', reason: `On average V2 is ${round(Math.abs(s.avgImprovementPct ?? 0))}% worse than V1 against ground truth.`, system: 'readiness', action: 'Review Performance before considering any rollout.', href: `${AI}/performance` })
  }

  // ── Readiness state ────────────────────────────────────────────────────────
  for (const b of s.readinessBlockers) {
    push({ key: `readiness_blocker:${slug(b)}`, severity: 'attention', title: 'Readiness blocked', reason: b, system: 'readiness', action: 'See Alerts & Readiness for the full picture.', href: `${AI}/alerts` })
  }

  // ── Configuration mismatches / drift ───────────────────────────────────────
  for (const m of s.configMismatches) {
    push({ key: `config_mismatch:${slug(m)}`, severity: 'attention', title: 'Configuration mismatch', reason: m, system: 'config', action: 'Review Models & Versions and Usage & Controls.', href: `${AI}/models` })
  }
  if (s.staleVersion) {
    push({ key: 'stale_version', severity: 'informational', title: 'Version drift', reason: 'The shadow prompt/estimator version differs from what recent evaluations recorded.', system: 'config', action: 'Confirm the intended version in Models & Versions.', href: `${AI}/models` })
  }

  // Dedup by key (defensive — rules already emit one per condition) then stable sort.
  const seen = new Set<string>()
  const unique = out.filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)))
  return unique.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.key.localeCompare(b.key))
}

export type AiAlertCounts = Record<AiAlertSeverity, number>
export function countBySeverity(alerts: AiAlert[]): AiAlertCounts {
  const out: AiAlertCounts = { critical: 0, warning: 0, attention: 0, informational: 0 }
  for (const a of alerts) out[a.severity]++
  return out
}

const round = (n: number) => Math.round(n * 10) / 10
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
