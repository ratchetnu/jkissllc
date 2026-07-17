import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listBookings } from '../../../lib/bookings'
import { shadowStatusForBooking } from '../../../lib/estimation/shadow-worker'
import { projectShadowRun } from '../../../lib/estimation/shadow-run-status'
import { evalErrorFor } from '../../../lib/estimation/shadow-learning'
import { groundTruthQuote } from '../../../lib/estimation/shadow-comparison'
import { deriveQueue, orderQueue, nextActionable, countByTier, type QueueInput, type QueueDerived } from '../../../lib/estimation/shadow-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/ai-queue — the owner's action-oriented evaluation workspace. Platform-owner
// only + SHADOW_ANALYTICS_ENABLED. PURE READS ONLY: reuses shadowStatusForBooking (the same
// per-booking snapshot the run controls use), evalErrorFor (V1/V2 variance), and the pure
// deriveQueue priority engine. Makes ZERO AI calls — selecting/running still happens on the
// per-booking shadow-run route. `?tier=` filters; the ordering is always deterministic.
const BOOKING_SAMPLE = 150

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })

  const sp = req.nextUrl.searchParams
  const tierFilter = sp.get('tier') ?? ''
  try {
    const bookings = await listBookings(BOOKING_SAMPLE)
    type Row = {
      bookingId: string; bookingNumber?: string; label?: string; status: string
      v1Usd: number | null; v2Usd: number | null; groundTruthUsd: number | null
      variancePctV2: number | null; winner: string | null
      updatedAt: number; ageMs: number; derived: QueueDerived
    }
    const rows: Row[] = []

    for (const b of bookings) {
      const snap = await shadowStatusForBooking(b)
      const job = snap.job
      const view = projectShadowRun({
        selected: snap.selected, eligible: snap.eligible, eligibilityReason: snap.eligibilityReason,
        job, budget: snap.budget, spend: snap.spend,
      })
      const hasComparison = !!job?.comparison
      const gt = groundTruthQuote(job?.groundTruth)
      const err = job ? evalErrorFor(job) : null

      const input: QueueInput = {
        bookingId: b.token,
        status: view.status,
        view: { canRun: view.canRun, canRetry: view.canRetry, canOpen: view.canOpen },
        selected: snap.selected,
        eligible: snap.eligible,
        hasComparison,
        hasGroundTruth: gt !== null,
        hasCategories: (job?.learningCategories?.length ?? 0) > 0,
        reviewedAt: job?.reviewedAt,
        wentToManualReview: job?.status === 'manual_review',
        updatedAt: job?.updatedAt ?? b.createdAt ?? 0,
      }
      const derived = deriveQueue(input)

      // A booking only belongs in the work queue if it is a shadow candidate or already has a job.
      if (!snap.eligible && !snap.selected && !job) continue

      rows.push({
        bookingId: b.token,
        bookingNumber: b.bookingNumber,
        label: b.serviceType,
        status: view.status,
        v1Usd: job?.comparison?.authoritativeRecommendedUsd ?? null,
        v2Usd: job?.comparison?.shadowRecommendedUsd ?? null,
        groundTruthUsd: gt,
        variancePctV2: err?.v2ErrorPct ?? null,
        winner: err?.winner ?? null,
        updatedAt: input.updatedAt,
        ageMs: input.updatedAt ? Date.now() - input.updatedAt : 0,
        derived,
      })
    }

    const ordered = orderQueue(rows)
    const counts = countByTier(rows)
    const next = nextActionable(rows)
    const filtered = tierFilter ? ordered.filter((r) => r.derived.tier === tierFilter) : ordered

    return NextResponse.json({
      enabled: true,
      sampled: bookings.length,
      total: rows.length,
      matched: filtered.length,
      counts,
      actionableCount: rows.filter((r) => r.derived.actionable).length,
      nextActionableId: next?.bookingId ?? null,
      tier: tierFilter || null,
      rows: filtered.slice(0, 200),
    })
  } catch {
    return NextResponse.json({ error: 'ai queue unavailable' }, { status: 500 })
  }
})
