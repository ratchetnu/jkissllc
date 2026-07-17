import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listShadowJobs } from '../../../lib/estimation/shadow-store'
import { extractFacets } from '../../../lib/estimation/shadow-facets'
import {
  learningOverview, leaderboards, categoryHeatmap, learningReadiness, learningRecommendations,
  learningTrends, evalErrors, applyLearningFilter, evalErrorsToCsv, LEARNING_CATEGORIES,
  filterLearningJobs, type LearningFilter, type LearningJobFilter,
} from '../../../lib/estimation/shadow-learning'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/shadow-learning — the AI Learning platform payload. Platform-owner only +
// SHADOW_ANALYTICS_ENABLED. EVERYTHING is derived from persisted evaluations via the PURE
// learning engine — it makes ZERO AI calls, triggers no inference, and changes no customer
// behavior. `?format=csv` exports the filtered evaluation-error rows.
const JOB_SAMPLE = 1000

function parseFilter(sp: URLSearchParams): LearningFilter {
  const num = (k: string) => { const v = sp.get(k); if (!v) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined }
  const str = (k: string) => { const v = sp.get(k)?.trim(); return v ? v : undefined }
  const outcome = sp.get('outcome')
  return {
    from: num('from'), to: num('to'),
    model: str('model'), deployment: str('deployment'),
    promptVersion: num('promptVersion'), estimatorVersion: num('estimatorVersion'),
    groundTruthSource: str('groundTruthSource'), category: str('category'),
    outcome: outcome === 'v1' || outcome === 'v2' || outcome === 'tie' ? outcome : undefined,
    minConfidence: num('minConfidence'), maxConfidence: num('maxConfidence'),
    q: str('q'),
  }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) {
    return NextResponse.json({ enabled: false, reason: 'SHADOW_ANALYTICS_ENABLED is off' })
  }

  const sp = req.nextUrl.searchParams
  const filter = parseFilter(sp)
  const now = Date.now()
  try {
      const sampled = await listShadowJobs(JOB_SAMPLE)

    // Performance passes job-level filters (date/model/prompt/category/reviewed/ground-truth) so
    // its aggregates genuinely reshape. Learning passes none, so it keeps the full picture. An
    // unset dimension is a no-op either way.
    const jf: LearningJobFilter = {
      from: filter.from, to: filter.to, model: filter.model, promptVersion: filter.promptVersion,
      category: filter.category,
      reviewed: sp.get('reviewed') === '1' ? true : sp.get('reviewed') === '0' ? false : undefined,
      hasGroundTruth: sp.get('gt') === '1' ? true : sp.get('gt') === '0' ? false : undefined,
    }
    const all = filterLearningJobs(sampled, jf)
    const rows = applyLearningFilter(evalErrors(all), filter)

    if (sp.get('format') === 'csv') {
      return new NextResponse(evalErrorsToCsv(rows), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="ai-learning-${new Date().toISOString().slice(0, 10)}.csv"`,
          'cache-control': 'no-store',
        },
      })
    }

    return NextResponse.json({
      enabled: true,
      sampled: sampled.length,
      matched: all.length,
      filter,
      categories: LEARNING_CATEGORIES,
      facets: extractFacets(sampled),
      overview: learningOverview(all),
      leaderboards: leaderboards(all),
      heatmap: categoryHeatmap(all),
      readiness: learningReadiness(all),
      recommendations: learningRecommendations(all),
      trends: learningTrends(all, now),
      // The filtered explorer rows (capped for payload size; CSV export has them all).
      explorer: { matched: rows.length, rows: rows.slice(0, 300) },
    })
  } catch {
    return NextResponse.json({ error: 'ai learning unavailable' }, { status: 500 })
  }
})
