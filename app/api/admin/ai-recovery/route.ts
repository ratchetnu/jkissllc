import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireAdmin } from '../_lib/session'
import { currentTenantId } from '../../../lib/platform/tenancy/context'
import { listBookings } from '../../../lib/bookings'
import { runDueAiJobs, processingLeaseMs } from '../../../lib/book-now-ai'
import { runDueFinalAiJobs } from '../../../lib/book-now-confirmation'
import {
  summarizeRecovery, loadBreaker, resetBreaker, breakerEnabled, breakerConfig, stuckQueuedMs,
} from '../../../lib/ai-recovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// AI job RECOVERY operator surface (Session 2). Admin-only, tenant-scoped, audited.
//
//  GET  → read-only fleet recovery health: per-status counts, stale-processing +
//         stuck-queued + dead-letter tallies, and the current circuit-breaker state.
//         Pure reads; makes ZERO AI calls.
//  POST → a bounded, SAFE operator action:
//         • recover-stranded — drains due initial + final jobs NOW through the same
//           idempotent processors the cron uses (per-booking write-locked, so no
//           duplicate estimates/bookings; sends NO communications). This is also the
//           Preview escape hatch, where no cron runs.
//         • reset-breaker    — clears the provider-outage breaker after an outage is
//           resolved, so the worker resumes immediately instead of waiting a cooldown.
//
// No pricing / prompt / model / telemetry-schema change. Recovery is non-destructive.
// ─────────────────────────────────────────────────────────────────────────────

const SCAN = 500

function tenant(): string {
  try { return currentTenantId() ?? 'default' } catch { return 'default' }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  try {
    const bookings = await listBookings(SCAN)
    const summary = summarizeRecovery(bookings, { leaseMs: processingLeaseMs(), stuckMs: stuckQueuedMs() })
    const breaker = await loadBreaker(tenant())
    return NextResponse.json({
      ok: true,
      summary,
      breaker: { enabled: breakerEnabled(), config: breakerConfig(), state: breaker },
      at: Date.now(),
    })
  } catch (e) {
    console.error('[admin/ai-recovery] GET', e)
    return NextResponse.json({ error: 'recovery health unavailable' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who

  let body: { action?: string; limit?: number } = {}
  try { body = await req.json() } catch { /* empty body ⇒ default action */ }
  const action = body.action ?? 'recover-stranded'

  try {
    if (action === 'reset-breaker') {
      const state = await resetBreaker(tenant())
      console.log(`[admin/ai-recovery] breaker reset by ${who.sub} (tenant=${tenant()})`)
      return NextResponse.json({ ok: true, action, breaker: state })
    }

    if (action === 'recover-stranded') {
      // Bounded per-call so a manual sweep can never runaway. Reuses the exact cron
      // processors: each job is picked only if `isDue` (queued/retrying past backoff,
      // or a crash-stranded processing lease), then run under its per-booking write
      // lease — idempotent, no duplicate estimates/bookings, no customer comms.
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 20))
      const before = summarizeRecovery(await listBookings(SCAN), { leaseMs: processingLeaseMs(), stuckMs: stuckQueuedMs() })
      const initial = await runDueAiJobs(limit)
      const final = await runDueFinalAiJobs(limit)
      const after = summarizeRecovery(await listBookings(SCAN), { leaseMs: processingLeaseMs(), stuckMs: stuckQueuedMs() })
      console.log(`[admin/ai-recovery] recover-stranded by ${who.sub}: initial=${initial.processed} final=${final.processed}`)
      return NextResponse.json({
        ok: true,
        action,
        processed: { initial: initial.processed, final: final.processed },
        results: { initial: initial.results, final: final.results },
        strandedBefore: before.stranded,
        strandedAfter: after.stranded,
      })
    }

    return NextResponse.json({ error: `unknown action '${action}'` }, { status: 400 })
  } catch (e) {
    console.error('[admin/ai-recovery] POST', e)
    return NextResponse.json({ error: 'recovery action failed' }, { status: 500 })
  }
})
