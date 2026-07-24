// CSV export for the reporting surface. Same guard (reports:view) + tenant wrapper as
// the report readers, so an export can never bypass authorization or tenant scope. Builds
// the SAME filtered dataset the UI shows (from the same engines), refuses an unknown
// report, refuses any non-CSV format explicitly (no inactive controls), caps the row
// count, and neutralizes spreadsheet-formula injection via toCsv/csvCell.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { listBookings } from '../../../../lib/bookings'
import { computeBookingAnalytics } from '../../../../lib/analytics'
import { listReviews, aggregate } from '../../../../lib/site-reviews'
import { listClaims } from '../../../../lib/claims'
import { computeClaimsReport } from '../../../../lib/claims-report'
import { getReportDef, toCsv, type ReportRow } from '../../../../lib/reports/catalog'
import { revenueDailyRows, claimsGroupRows, filterRowsByDate, parseReportDate } from '../../../../lib/reports/build'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'reports:view')
  if (who instanceof NextResponse) return who

  const { searchParams } = new URL(req.url)
  const def = getReportDef(searchParams.get('report') ?? '')
  if (!def) return NextResponse.json({ error: 'unknown_report' }, { status: 404 })
  const format = searchParams.get('format') ?? 'csv'
  if (format !== 'csv') return NextResponse.json({ error: 'unsupported_format', supported: ['csv'] }, { status: 400 })

  let rows: ReportRow[]
  try {
    if (def.source === 'revenue') {
      const [bookings, reviews] = await Promise.all([listBookings(1000), listReviews(500)])
      const agg = aggregate(reviews.filter((r) => !r.hidden))
      const data = computeBookingAnalytics(bookings, Date.now(), { count: agg.count, rating: agg.rating })
      rows = revenueDailyRows(data)
    } else {
      const claims = await listClaims(1000)
      const report = computeClaimsReport(claims)
      rows = def.id === 'claims-by-crew' ? claimsGroupRows(report.byCrew) : claimsGroupRows(report.byBusiness)
    }
  } catch (err) {
    console.error('[admin/reports/export]', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }

  if (def.dateFilterable && def.dateKey) {
    rows = filterRowsByDate(rows, def.dateKey, parseReportDate(searchParams.get('from')), parseReportDate(searchParams.get('to')))
  }

  const out = toCsv(def.columns, rows)
  if ('error' in out) return NextResponse.json({ error: 'export_too_large' }, { status: 413 })

  const fname = `jkiss-${def.id}-${new Date().toISOString().slice(0, 10)}.csv` // id is a fixed catalog value → safe filename
  return new NextResponse(out.csv, {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` },
  })
})
