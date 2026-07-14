import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../admin/_lib/session'
import { runHealthChecks, projectHealth, httpStatusFor, pingKv } from '../../lib/health'
import { alert } from '../../lib/alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/health — production health.
//   • PUBLIC (no auth): minimal, safe status + build id. 503 when a critical
//     dependency (KV) is down, 200 otherwise. Suitable for an uptime monitor.
//   • DETAILED (admin session OR ?secret=/x-health-secret === HEALTH_CHECK_SECRET):
//     per-component breakdown. Still never exposes a secret VALUE — only presence
//     booleans + status. No customer data, no connection strings, no stack traces.
export async function GET(req: NextRequest) {
  const report = await runHealthChecks({ pingKv, env: process.env })

  // Detailed access: an authenticated admin, or a matching health-check secret.
  const secret = process.env.HEALTH_CHECK_SECRET
  const supplied = req.headers.get('x-health-secret') || new URL(req.url).searchParams.get('secret') || ''
  const bySecret = !!secret && supplied === secret
  const byAdmin = !bySecret && (await requireSession(req).catch(() => false))
  const detailed = bySecret || !!byAdmin

  // A critical failure is itself an operational alert (deduped).
  if (report.status === 'unhealthy') {
    await alert({ type: 'health_critical', severity: 'CRITICAL', route: '/api/health', errorClass: 'kv_unreachable' })
  }

  return NextResponse.json(projectHealth(report, { detailed }), { status: httpStatusFor(report.status) })
}
