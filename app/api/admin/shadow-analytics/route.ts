import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listShadowJobs } from '../../../lib/estimation/shadow-store'
import { computeShadowMetrics } from '../../../lib/estimation/shadow-metrics'
import {
  computeShadowAnalytics, detectDisagreements, modelScorecards, readinessScore,
  timeSeriesRollup, type RollupWindow,
} from '../../../lib/estimation/shadow-analytics'
import { extractFacets, applyShadowFilter, parseShadowFilter } from '../../../lib/estimation/shadow-facets'

const WINDOWS: RollupWindow[] = ['24h', '7d', '30d', '90d']

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
  const sp = req.nextUrl.searchParams
  const w = sp.get('window')
  const window: RollupWindow = WINDOWS.includes(w as RollupWindow) ? (w as RollupWindow) : '7d'
  const filter = parseShadowFilter(sp)
  // A custom [from,to] overrides the window's trailing span (bucket size still comes from window).
  const range = typeof filter.from === 'number' || typeof filter.to === 'number'
    ? { from: filter.from, to: filter.to } : undefined
  try {
    const all = await listShadowJobs(SHADOW_JOB_SAMPLE)
    // Facets enumerate the FULL set so options never vanish when a filter is active;
    // every metric below derives from the filtered subset via the pure engine.
    const facets = extractFacets(all)
    const jobs = applyShadowFilter(all, filter)
    return NextResponse.json({
      enabled: true,
      sampled: all.length,
      matched: jobs.length,
      facets,
      filter,
      analytics: computeShadowAnalytics(jobs),
      disagreements: detectDisagreements(jobs).slice(0, 50),
      scorecards: modelScorecards(jobs),
      readiness: readinessScore(jobs),
      metrics: computeShadowMetrics(jobs),
      window,
      rollup: timeSeriesRollup(jobs, window, Date.now(), range),
    })
  } catch {
    return NextResponse.json({ error: 'shadow analytics unavailable' }, { status: 500 })
  }
})
