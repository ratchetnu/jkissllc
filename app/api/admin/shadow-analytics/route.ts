import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listShadowJobs } from '../../../lib/estimation/shadow-store'
import { computeShadowMetrics } from '../../../lib/estimation/shadow-metrics'
import {
  computeShadowAnalytics, detectDisagreements, modelScorecards, readinessScore,
} from '../../../lib/estimation/shadow-analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/shadow-analytics — the read-only AI-evaluation control center. Platform-owner
// only + gated by SHADOW_ANALYTICS_ENABLED. Every number derives from the persisted V2ShadowJob[]
// (survives restarts) via the PURE analytics engine — no terminal logs, no customer impact, no
// shadow processing triggered. Returns the aggregate analytics, ranked disagreements (FP/FN/price),
// per-model scorecards, promotion readiness, and the operational metrics for the dashboard.
const SHADOW_JOB_SAMPLE = 1000

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) {
    return NextResponse.json({ enabled: false, reason: 'SHADOW_ANALYTICS_ENABLED is off' })
  }
  try {
    const jobs = await listShadowJobs(SHADOW_JOB_SAMPLE)
    return NextResponse.json({
      enabled: true,
      sampled: jobs.length,
      analytics: computeShadowAnalytics(jobs),
      disagreements: detectDisagreements(jobs).slice(0, 50),
      scorecards: modelScorecards(jobs),
      readiness: readinessScore(jobs),
      metrics: computeShadowMetrics(jobs),
    })
  } catch {
    return NextResponse.json({ error: 'shadow analytics unavailable' }, { status: 500 })
  }
})
