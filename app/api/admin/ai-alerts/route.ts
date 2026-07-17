import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listShadowJobs, readShadowSpend, getShadowKillOverride } from '../../../lib/estimation/shadow-store'
import { computeShadowMetrics } from '../../../lib/estimation/shadow-metrics'
import { learningOverview, learningReadiness } from '../../../lib/estimation/shadow-learning'
import { shadowBudgetFromEnv, decideShadowSpend } from '../../../lib/estimation/shadow-budget'
import { deriveAiAlerts, countBySeverity } from '../../../lib/estimation/shadow-ai-alerts'
import { V2_ESTIMATOR_VERSION } from '../../../lib/estimation/shadow-policy'
import { promptVersionNumber } from '../../../lib/ai/analysis-v2'
import { ANALYSIS_V2_PROMPT_VERSION } from '../../../lib/ai/analysis-v2-prompt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/ai-alerts — the live Alerts & Readiness view. Platform-owner only +
// SHADOW_ANALYTICS_ENABLED. DETERMINISTIC and ZERO AI: derives alerts from CURRENT metrics via
// the pure deriveAiAlerts engine and reuses learningReadiness — no persistence, no cron, no
// model call. Distinct from the (dormant) background alerting subsystem: this is a live read.
const JOB_SAMPLE = 1000

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })

  const now = Date.now()
  try {
    const jobs = await listShadowJobs(JOB_SAMPLE)
    const metrics = computeShadowMetrics(jobs)
    const learn = learningOverview(jobs)
    const readiness = learningReadiness(jobs)
    const spend = await readShadowSpend(now)
    const budget = shadowBudgetFromEnv()
    const killed = budget.killed || (await getShadowKillOverride()) === true
    const spendDecision = decideShadowSpend({ ...budget, killed }, { evalsToday: spend.evals, costTodayUsd: spend.costUsd, attemptsForBooking: 0 })

    // Most recent completed evaluation, for the staleness rule.
    const lastEvaluationAt = jobs.reduce<number | null>((acc, j) => {
      if (j.comparison && (j.status === 'completed' || j.status === 'manual_review')) {
        const t = j.completedAt ?? j.updatedAt
        return acc === null || t > acc ? t : acc
      }
      return acc
    }, null)

    // Configuration mismatches — deterministic cross-checks of the current flag/version state.
    const mismatches: string[] = []
    if (isEnabled('VISION_SHADOW_QUEUE_ENABLED') && !isEnabled('VISION_SHADOW_WORKER_ENABLED')) {
      mismatches.push('Shadow jobs can be queued but the worker is off — they will not process.')
    }
    // A recorded prompt version that no longer matches the shipped one is drift worth surfacing.
    const shippedPrompt = promptVersionNumber(ANALYSIS_V2_PROMPT_VERSION)
    const recordedPrompts = new Set(jobs.map((j) => j.promptVersion).filter((v): v is number => typeof v === 'number'))
    const staleVersion = shippedPrompt != null && recordedPrompts.size > 0 && !recordedPrompts.has(shippedPrompt)

    const alerts = deriveAiAlerts({
      failed: metrics.failed,
      retriesToday: spend.retries,
      preventedRetriesToday: spend.preventedRetries,
      budgetBlockedToday: spend.budgetBlocked,
      awaitingGroundTruth: learn.totalEvaluations - learn.groundTruthsRecorded,
      needingReview: metrics.awaitingReview,
      lastEvaluationAt,
      now,
      completedEvaluations: learn.totalEvaluations,
      groundTruthCount: learn.groundTruthsRecorded,
      groundTruthCoveragePct: learn.groundTruthCoverage,
      avgV2ErrorPct: learn.avgV2ErrorPct,
      avgImprovementPct: learn.avgImprovementPct,
      evalsToday: spend.evals,
      maxEvalsPerDay: budget.maxEvalsPerDay,
      costTodayUsd: spend.costUsd,
      maxDailyCostUsd: budget.maxEstDailyCostUsd,
      spendAllowed: spendDecision.allowed,
      spendBlockReason: spendDecision.allowed ? null : spendDecision.detail,
      killed,
      readinessTier: readiness.tier,
      readinessBlockers: readiness.blockers,
      configMismatches: mismatches,
      staleVersion,
    })

    return NextResponse.json({
      enabled: true,
      at: now,
      alerts,
      counts: countBySeverity(alerts),
      readiness: {
        tier: readiness.tier, score: readiness.score, sampleSize: readiness.sampleSize,
        groundTruthCoverage: readiness.groundTruthCoverage, avgImprovementPct: readiness.avgImprovementPct,
        avgConfidence: readiness.avgConfidence, failureRatePct: readiness.failureRatePct,
        retryRatePct: readiness.retryRatePct, evaluationCoverage: readiness.evaluationCoverage,
        reasons: readiness.reasons, blockers: readiness.blockers,
        // evidence detail for the readiness panel
        completedEvaluations: learn.totalEvaluations, groundTruthCount: learn.groundTruthsRecorded,
        reviewedCount: metrics.completed + metrics.manualReview - metrics.awaitingReview,
        v2WinPct: learn.v2WinPct, avgV1ErrorPct: learn.avgV1ErrorPct, avgV2ErrorPct: learn.avgV2ErrorPct,
      },
      // Note whether the persisted background alerting subsystem is active (it is separate + dormant).
      backgroundAlerting: isEnabled('SHADOW_ALERTING_ENABLED'),
      versions: { estimatorVersion: V2_ESTIMATOR_VERSION, promptVersion: ANALYSIS_V2_PROMPT_VERSION },
    })
  } catch {
    return NextResponse.json({ error: 'ai alerts unavailable' }, { status: 500 })
  }
})
