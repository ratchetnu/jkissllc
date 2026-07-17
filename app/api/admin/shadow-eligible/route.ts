import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listBookings } from '../../../lib/bookings'
import { shadowStatusForBooking } from '../../../lib/estimation/shadow-worker'
import { projectShadowRun, type ShadowRunStatus } from '../../../lib/estimation/shadow-run-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The Shadow Analytics "eligible jobs" view — the owner's picking list. Platform-owner only +
// SHADOW_ANALYTICS_ENABLED. PURE READS ONLY: it lists recent bookings with their shadow status,
// eligibility, and current job, and makes ZERO AI calls. Selecting/running happens on the
// per-booking /api/admin/shadow-run route.
const BOOKING_SAMPLE = 120

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })

  const sp = req.nextUrl.searchParams
  // 'eligible' (can be selected/run now), 'selected', 'all'. Default hides the noise of
  // bookings that aren't candidates.
  const scope = sp.get('scope') ?? 'eligible'

  try {
    const bookings = await listBookings(BOOKING_SAMPLE)
    const rows: Array<{
      bookingId: string; bookingNumber?: string; createdAt?: number; status: ShadowRunStatus
      label: string; selected: boolean; eligible: boolean; imageCount: number
      jobStatus?: string; hasComparison: boolean; awaitingGroundTruth: boolean
      canRun: boolean; canRetry: boolean; canRerun: boolean
    }> = []

    for (const b of bookings) {
      const snap = await shadowStatusForBooking(b)
      const view = projectShadowRun({
        selected: snap.selected, eligible: snap.eligible, eligibilityReason: snap.eligibilityReason,
        job: snap.job, budget: snap.budget, spend: snap.spend,
      })
      // A booking is a candidate for the picking list if it is eligible, already selected, or
      // already has a job — everything else is noise the owner never acts on here.
      const isCandidate = snap.eligible || snap.selected || !!snap.job
      if (scope === 'eligible' && !isCandidate) continue
      if (scope === 'selected' && !snap.selected) continue

      rows.push({
        bookingId: b.token,
        bookingNumber: b.bookingNumber,
        createdAt: b.createdAt,
        status: view.status,
        label: view.label,
        selected: snap.selected,
        eligible: snap.eligible,
        imageCount: snap.imageCount,
        jobStatus: snap.job?.status,
        hasComparison: !!snap.job?.comparison,
        awaitingGroundTruth: view.status === 'awaiting_ground_truth',
        canRun: view.canRun,
        canRetry: view.canRetry,
        canRerun: view.canRerun,
      })
    }

    return NextResponse.json({ enabled: true, scope, sampled: bookings.length, matched: rows.length, rows })
  } catch {
    return NextResponse.json({ error: 'eligible jobs unavailable' }, { status: 500 })
  }
})
