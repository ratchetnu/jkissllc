import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import { listBookings } from '../../../lib/bookings'
import { listAiCalls } from '../../../lib/ai/telemetry'
import { computeEstimatorDiagnostics } from '../../../lib/ai/estimator-diagnostics'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/estimator-diagnostics — owner-safe operational health for the V2
// vision photo-estimation pipeline (Phase 15). Staff-only (admin + manager); crew
// and the public never reach it.
//
// This is an OPERATIONS surface, not an error firehose: it returns aggregated
// counts, rates, latency/cost, and the model/prompt versions in use — NEVER raw
// stack traces, provider error text, secrets, or image URLs. All aggregation lives
// in the pure computeEstimatorDiagnostics(); this route only loads the snapshot,
// gates access, and serializes. On any unexpected failure it returns a generic
// message (no internal detail leaks to the response).
//
// Query: ?windowHours=NN restricts the snapshot to a trailing window (default: all).
// ─────────────────────────────────────────────────────────────────────────────

// How much of the AI audit log to sample for telemetry roll-up.
const AI_CALL_SAMPLE = 2000
const BOOKING_SAMPLE = 500

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who

  const raw = req.nextUrl.searchParams.get('windowHours')
  const parsed = raw != null ? Number(raw) : NaN
  const windowHours = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined

  try {
    const [bookings, aiCalls] = await Promise.all([
      listBookings(BOOKING_SAMPLE),
      // Telemetry is best-effort: if the audit log is unavailable, degrade to
      // job-only diagnostics (telemetry metrics resolve to null) rather than 500.
      listAiCalls(AI_CALL_SAMPLE).catch(() => undefined),
    ])

    const diagnostics = computeEstimatorDiagnostics(bookings, aiCalls, {
      now: Date.now(),
      windowHours,
    })

    return NextResponse.json(diagnostics)
  } catch {
    // Never surface the underlying error to the caller.
    return NextResponse.json({ error: 'estimator diagnostics unavailable' }, { status: 500 })
  }
})
