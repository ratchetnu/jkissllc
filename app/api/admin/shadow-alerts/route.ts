import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listAlerts, getLastAlertRun, getReadinessSnapshot } from '../../../lib/estimation/shadow-alert-store'
import { DEFAULT_ALERT_POLICIES } from '../../../lib/estimation/shadow-alert-policies'
import {
  applyAlertFilter, alertFacets, summarizeAlerts, sortAlerts, parseAlertFilter, alertsToCsv,
} from '../../../lib/estimation/shadow-alert-filters'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/shadow-alerts — the owner's AI notification center. Platform-owner only +
// gated by SHADOW_ALERTING_ENABLED. Read-only: it renders alerts the scheduled evaluator
// already decided on and never evaluates policies itself, so opening the page cannot create
// an alert. Every count derives from the PURE filter/summary module — the client re-derives
// nothing. No shadow processing is triggered and no customer-facing behavior is touched.
//
// `?format=csv` exports the CURRENT filtered view (evidence about the model — it carries no
// raw model output about any customer's property).
const ALERT_SAMPLE = 500

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ALERTING_ENABLED')) {
    return NextResponse.json({ enabled: false, reason: 'SHADOW_ALERTING_ENABLED is off' })
  }

  const sp = req.nextUrl.searchParams
  const filter = parseAlertFilter(sp)
  try {
    const all = await listAlerts(ALERT_SAMPLE)
    // Facets enumerate the FULL set so options never vanish under an active filter;
    // the summary describes the FILTERED view the owner is actually looking at.
    const facets = alertFacets(all)
    const matched = sortAlerts(applyAlertFilter(all, filter))

    if (sp.get('format') === 'csv') {
      return new NextResponse(alertsToCsv(matched), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="shadow-alerts-${new Date().toISOString().slice(0, 10)}.csv"`,
          'cache-control': 'no-store',
        },
      })
    }

    return NextResponse.json({
      enabled: true,
      sampled: all.length,
      matched: matched.length,
      filter,
      facets,
      // The badge/severity numbers come from the whole set, not the filtered slice — an
      // owner filtering to WARNING must still see that a CRITICAL is open.
      summary: summarizeAlerts(all),
      filteredSummary: summarizeAlerts(matched),
      alerts: matched.slice(0, 200),
      readiness: await getReadinessSnapshot(),
      // Owner-safe scheduler health: proves the evaluator is alive. An empty Alerts page
      // means "nothing wrong" only if the last run actually succeeded.
      lastRun: await getLastAlertRun(),
      policies: DEFAULT_ALERT_POLICIES.map((p) => ({
        id: p.id, type: p.type, kind: p.kind, enabled: p.enabled, severity: p.severity,
        threshold: p.threshold, minSampleSize: p.minSampleSize, description: p.description,
      })),
    })
  } catch {
    return NextResponse.json({ error: 'shadow alerts unavailable' }, { status: 500 })
  }
})
