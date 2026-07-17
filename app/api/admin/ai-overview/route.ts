import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listShadowJobs, readShadowSpend, getShadowKillOverride } from '../../../lib/estimation/shadow-store'
import { computeShadowAnalytics } from '../../../lib/estimation/shadow-analytics'
import { computeShadowMetrics } from '../../../lib/estimation/shadow-metrics'
import { learningReadiness, learningRecommendations, learningOverview } from '../../../lib/estimation/shadow-learning'
import { shadowBudgetFromEnv, decideShadowSpend } from '../../../lib/estimation/shadow-budget'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/ai-overview — the AI Command Center's calm landing, in ONE request. Owner-only
// + SHADOW_ANALYTICS_ENABLED. Aggregates through the EXISTING pure engines (no new metric math)
// and makes ZERO AI calls. Deliberately narrow: only what the owner needs to decide what to do
// next — the deep dashboards live in their own sections and load their own data on demand.
const JOB_SAMPLE = 1000

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) {
    return NextResponse.json({ enabled: false, reason: 'SHADOW_ANALYTICS_ENABLED is off' })
  }

  const now = Date.now()
  try {
    const jobs = await listShadowJobs(JOB_SAMPLE)
    const analytics = computeShadowAnalytics(jobs)
    const metrics = computeShadowMetrics(jobs)
    const learn = learningOverview(jobs)
    const readiness = learningReadiness(jobs)
    const recs = learningRecommendations(jobs)
    const spend = await readShadowSpend(now)
    const budget = shadowBudgetFromEnv()
    const killOverride = await getShadowKillOverride()
    const killed = budget.killed || killOverride === true
    const spendDecision = decideShadowSpend({ ...budget, killed }, { evalsToday: spend.evals, costTodayUsd: spend.costUsd, attemptsForBooking: 0 })

    // Owner-safe system health: derived from configuration presence, not secret values.
    const health = {
      shadowAnalytics: true,
      shadowWorker: isEnabled('VISION_SHADOW_WORKER_ENABLED'),
      selectedOnly: isEnabled('VISION_SHADOW_SELECTED_ONLY'),
      shadowAlerting: isEnabled('SHADOW_ALERTING_ENABLED'),
      inferenceHalted: killed,
      spendAllowed: spendDecision.allowed,
    }

    return NextResponse.json({
      enabled: true,
      at: now,
      // Customer-facing truth, stated plainly at the top of the page.
      customerFacing: 'V1',
      shadowMode: 'V2',
      readiness: { tier: readiness.tier, score: readiness.score, sampleSize: readiness.sampleSize, reasons: readiness.reasons.slice(0, 2), blockers: readiness.blockers },
      groundTruth: {
        recorded: learn.groundTruthsRecorded,
        completed: learn.totalEvaluations,
        coveragePct: learn.groundTruthCoverage,
        avgImprovementPct: learn.avgImprovementPct,
        v2WinPct: learn.v2WinPct,
      },
      usage: { evalsToday: spend.evals, costTodayUsd: spend.costUsd, budget, killed, spendAllowed: spendDecision.allowed, spendBlockReason: spendDecision.allowed ? null : spendDecision.detail },
      attention: {
        jobsWaiting: metrics.queued + metrics.byStatus.retrying,
        jobsProcessing: metrics.processing,
        needingReview: metrics.awaitingReview,
        awaitingGroundTruth: analytics.awaitingGroundTruth,
        failed: metrics.failed,
      },
      recommendation: recs[0] ?? null,
      health,
    })
  } catch {
    return NextResponse.json({ error: 'ai overview unavailable' }, { status: 500 })
  }
})
