import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { getBookingByToken } from '../../../../lib/bookings'
import {
  enqueueShadowJobForBooking, processShadowJob, shadowStatusForBooking,
} from '../../../../lib/estimation/shadow-worker'
import {
  addSelected, removeSelected, getShadowJob, saveShadowJob,
} from '../../../../lib/estimation/shadow-store'
import { projectShadowRun } from '../../../../lib/estimation/shadow-run-status'
import { recordPlatformAudit } from '../../../../lib/platform/updates/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A synchronous owner-triggered run performs the heavy V2 vision call (~40–70s). It shares the
// vision worker's 300s budget so it can never hard-kill mid-run; the worker also enforces its
// own graceful deadline well below this.
export const maxDuration = 300

// The owner Select / Run / Retry / Rerun surface. Platform-owner ONLY (stricter than the
// admin-gated /api/admin/bookings/[id] path) + SHADOW_ANALYTICS_ENABLED. Everything here goes
// through the EXISTING shadow pipeline — no second implementation. It never touches the booking
// blob, authoritative estimate, pricing, or customer comms.
//
// GET  → status snapshot for the UI (eligibility + job + budget). ZERO AI.
// POST → { action: select | unselect | run | retry | rerun }. Only `run` may spend inference,
//        and only through the budget + kill-switch gate inside processShadowJob.

async function statusPayload(bookingId: string) {
  const b = await getBookingByToken(bookingId)
  if (!b) return null
  const snap = await shadowStatusForBooking(b)
  const view = projectShadowRun({
    selected: snap.selected, eligible: snap.eligible, eligibilityReason: snap.eligibilityReason,
    job: snap.job, budget: snap.budget, spend: snap.spend,
  })
  return {
    bookingId,
    bookingNumber: b.bookingNumber,
    view,
    selected: snap.selected,
    eligible: snap.eligible,
    eligibilityReason: snap.eligibilityReason,
    imageCount: snap.imageCount,
    job: snap.job,
    // Cost preview: what a run would cost against today's remaining allowance. Read-only.
    budget: snap.budget,
    spend: { evalsToday: snap.spend.evalsToday, costTodayUsd: snap.spend.costTodayUsd, attemptsForBooking: snap.spend.attemptsForBooking },
    // A rerun can reuse the stored result's ground truth; a fresh run cannot reuse inference.
    reusableResult: !!snap.job?.result?.ok,
  }
}

export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })
  const { bookingId } = await params
  const payload = await statusPayload(bookingId)
  if (!payload) return NextResponse.json({ error: 'booking_not_found' }, { status: 404 })
  return NextResponse.json({ enabled: true, ...payload })
})

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ error: 'analytics disabled' }, { status: 403 })

  const { bookingId } = await params
  const b = await getBookingByToken(bookingId)
  if (!b) return NextResponse.json({ error: 'booking_not_found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')
  const actor = (await getPrincipal(req))?.sub || 'owner'
  const now = Date.now()

  const audit = (summary: string, meta?: Record<string, unknown>) => recordPlatformAudit({
    actor, actorType: 'owner', source: 'shadow-run', action: 'status.manual_correction',
    jobId: b.bookingNumber ? `booking:${b.bookingNumber}` : undefined, summary, meta,
  })

  try {
    switch (action) {
      case 'select': {
        await addSelected(bookingId)
        await audit(`Selected ${b.bookingNumber} for shadow evaluation.`)
        break
      }
      case 'unselect': {
        await removeSelected(bookingId)
        await audit(`Unselected ${b.bookingNumber} from shadow evaluation.`)
        break
      }
      case 'retry': {
        // A failed/cancelled job → retrying. Respects the one-retry cap at process time.
        const job = await getShadowJob(bookingId)
        if (!job) return NextResponse.json({ error: 'no_job' }, { status: 404 })
        if (job.status !== 'failed' && job.status !== 'cancelled') {
          return NextResponse.json({ error: `Only failed/cancelled jobs can be retried (is ${job.status}).` }, { status: 400 })
        }
        job.status = 'retrying'
        job.nextRetryAt = now
        job.updatedAt = now
        await saveShadowJob(job)
        await audit(`Retry queued for ${b.bookingNumber}.`)
        break
      }
      case 'run':
      case 'rerun': {
        // Enqueue (idempotent; `rerun` forces a new attempt and snapshots prior history), then
        // process synchronously so the owner sees the result. Processing runs through the budget
        // + kill-switch gate — a blocked run parks the job rather than spending.
        const enq = await enqueueShadowJobForBooking(b, { createdBy: 'owner', manualEnqueue: true, force: action === 'rerun' })
        if (!enq.enqueued) return NextResponse.json({ error: `Not enqueued: ${enq.reason}`, reason: enq.reason }, { status: 400 })
        await audit(`${action === 'rerun' ? 'Rerun' : 'Run'} started for ${b.bookingNumber}.`, { force: action === 'rerun' })
        const result = await processShadowJob(bookingId, {})
        // A budget/kill block is a clean, expected outcome — surface it, don't 500.
        if (!result.ok && result.reason?.startsWith('budget_')) {
          const payload = await statusPayload(bookingId)
          return NextResponse.json({ ok: false, blocked: result.reason, ...payload }, { status: 200 })
        }
        break
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.name : 'action_failed' }, { status: 500 })
  }

  const payload = await statusPayload(bookingId)
  return NextResponse.json({ ok: true, ...payload })
})
