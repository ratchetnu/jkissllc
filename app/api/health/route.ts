import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../admin/_lib/session'
import { runHealthChecks, projectHealth, httpStatusFor, pingKv } from '../../lib/health'
import { listAiCalls } from '../../lib/ai/telemetry'
import { alert } from '../../lib/alerts'
import { resolveTenantCapabilities } from '../../lib/platform/capabilities/tenant-profile-store'
import { DEFAULT_TENANT_ID } from '../../lib/platform/tenancy/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/health — production health.
//   • PUBLIC (no auth): minimal, safe status + build id. 503 when a critical
//     dependency (KV) is down, 200 otherwise. Suitable for an uptime monitor.
//   • DETAILED (admin session OR ?secret=/x-health-secret === HEALTH_CHECK_SECRET):
//     per-component breakdown. Still never exposes a secret VALUE — only presence
//     booleans + status. No customer data, no connection strings, no stack traces.
export async function GET(req: NextRequest) {
  // `lastAiCall` is what lets ai_provider report reality instead of env presence. One
  // ZSET page + one GET, fail-soft: a telemetry problem must never make health unhealthy.
  const report = await runHealthChecks({
    pingKv,
    env: process.env,
    lastAiCall: async () => {
      const [last] = await listAiCalls(1)
      return last ? { ok: last.ok, outcome: last.outcome, errorClass: last.errorClass, at: last.at } : null
    },
    // Which optional channels this DEPLOYMENT uses. /api/health is pre-auth and has
    // no session, so there is no request tenant to resolve — and there does not need
    // to be: this endpoint describes the deployment, whose own business is the
    // reference tenant. Fail-soft, so a store blip degrades to the historical
    // "assume everything is in use" rather than making the probe itself unwell.
    providers: async () => (await resolveTenantCapabilities(DEFAULT_TENANT_ID)).providers,
  })

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
