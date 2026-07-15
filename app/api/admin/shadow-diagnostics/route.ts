import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import { listShadowJobs } from '../../../lib/estimation/shadow-store'
import { computeShadowMetrics } from '../../../lib/estimation/shadow-metrics'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/shadow-diagnostics — SEPARATE observability for the independent V2
// shadow subsystem (Phase 12). Staff-only. Deliberately DISTINCT from the authoritative
// /api/admin/estimator-diagnostics so a shadow failure never makes the real Book Now
// worker look unhealthy. Returns aggregated counts/rates/runtime/cost only — no PII,
// no image URLs, no provider error text.
// ─────────────────────────────────────────────────────────────────────────────

const SHADOW_JOB_SAMPLE = 500

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  try {
    const jobs = await listShadowJobs(SHADOW_JOB_SAMPLE)
    return NextResponse.json({ metrics: computeShadowMetrics(jobs), sampled: jobs.length })
  } catch {
    return NextResponse.json({ error: 'shadow diagnostics unavailable' }, { status: 500 })
  }
})
