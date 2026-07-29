import { NextRequest, NextResponse } from 'next/server'
import { scanAllRoutes, getRouteByToken, saveRoute, autoCancelRoute } from '../../../lib/routes'
import { withRouteLock, RouteBusyError } from '../../../lib/route-mutex'
import { isEnabled } from '../../../lib/platform/flags'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'
import { activeTenantIds } from '../../../lib/platform/tenancy/tenant-store'
import { currentTenantId } from '../../../lib/platform/tenancy/context'
import { alert } from '../../../lib/alerts'
import {
  selectAutoCancelCandidates, isCancellationWindow, centralDate, centralHour, centralStamp,
  isLiveRoute, hasNoCrew, OPS_TIMEZONE, CANCELLATION_GRACE_HOURS,
  type AutoCancelCandidate,
} from '../../../lib/schedule/auto-cancel'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Stale-route auto-cancellation — the WRITE path.
//
// A committed route dated today with nobody assigned is called off shortly after the
// route day begins. Selection lives in lib/schedule/auto-cancel (pure, clock-injected,
// independently tested); this file is scheduling, safety and persistence.
//
// NOT SCHEDULED IN THIS PR. There is deliberately no vercel.json cron entry: this
// endpoint exists, is authenticated, and can be driven by hand for a Preview dry run,
// but nothing fires it automatically. Registering the schedule and enabling the flag
// are a separate rollout change, made only after a real dry-run report is approved.
// The intended schedule when that happens is `0 5,6 * * *` — 05:00 and 06:00 UTC,
// which straddle Central midnight across CDT and CST; both land inside the grace
// window and the second is a harmless idempotent retry.
//
// GATES, all of which must hold before a single record changes:
//   1. ROUTE_AUTO_CANCEL_ENABLED — off by default, in every environment.
//   2. The cancellation window — Central midnight through the grace period.
//   3. A COMPLETE route scan. A truncated scan cancels nothing at all: acting on a
//      partial view is how a job silently does the wrong amount of work.
//   4. A resolvable, complete tenant set (see below).
// `?dryRun=1` additionally SUPPRESSES writes; it is not required to permit them.
//
// IDEMPOTENT BY CONSTRUCTION. Eligibility is re-checked INSIDE the per-route lock
// against a freshly-read record, and `autoCancelRoute` refuses an already-terminal
// route. Repeated or concurrent invocations converge on ONE cancellation and ONE
// audit entry.
// ─────────────────────────────────────────────────────────────────────────────

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed — an unconfigured secret must not leave this open
  return req.headers.get('authorization') === `Bearer ${secret}`
}

type Outcome = {
  candidates: AutoCancelCandidate[]
  scanComplete: boolean
  scanned: number
  total: number
  scanNote?: string
  cancelled: string[]
  skipped: { routeNumber: string; why: string }[]
  errors: { routeNumber: string; error: string }[]
  tenantAtStart?: string
  tenantAtEnd?: string
}

async function runForTenant(now: number, write: boolean): Promise<Outcome> {
  const scan = await scanAllRoutes()
  const out: Outcome = {
    candidates: [], scanComplete: scan.complete, scanned: scan.scanned, total: scan.total,
    scanNote: scan.truncatedReason, cancelled: [], skipped: [], errors: [],
    tenantAtStart: currentTenantId(),
  }

  // A truncated scan cannot distinguish "no eligible routes" from "did not look at
  // all of them". Cancel nothing and report no candidate list at all, so nothing
  // downstream can read this as a clean pass.
  if (!scan.complete) {
    out.tenantAtEnd = currentTenantId()
    return out
  }

  out.candidates = selectAutoCancelCandidates(scan.routes, now)
  if (!write) { out.tenantAtEnd = currentTenantId(); return out }

  for (const c of out.candidates) {
    try {
      await withRouteLock(c.token, async () => {
        // Re-read under the lock. The scan is seconds old; between then and here an
        // admin may have assigned crew, cancelled it by hand, or completed it. The
        // scan proposes — the record under the lock decides.
        const fresh = await getRouteByToken(c.token)
        if (!fresh) { out.skipped.push({ routeNumber: c.routeNumber, why: 'route no longer exists' }); return }
        if (!isLiveRoute(fresh)) { out.skipped.push({ routeNumber: c.routeNumber, why: `already ${fresh.status}` }); return }
        if (!hasNoCrew(fresh)) { out.skipped.push({ routeNumber: c.routeNumber, why: 'crew assigned since scan' }); return }
        if (fresh.routeDate !== c.routeDate) { out.skipped.push({ routeNumber: c.routeNumber, why: 'route date changed' }); return }

        // ONE attributed lifecycle entry carrying actor, reason, route date, previous
        // and new status, and the Central execution stamp.
        const changed = autoCancelRoute(fresh, {
          reason: c.detail, routeDate: c.routeDate, centralAt: centralStamp(now),
        })
        if (!changed) { out.skipped.push({ routeNumber: c.routeNumber, why: `already ${fresh.status}` }); return }
        await saveRoute(fresh)
        out.cancelled.push(c.routeNumber)
      })
    } catch (e) {
      if (e instanceof RouteBusyError) {
        // Someone else holds the lock. Not an error: a later run inside the grace
        // window picks it up, and the route is still dated today.
        out.skipped.push({ routeNumber: c.routeNumber, why: 'route busy — will retry in the grace window' })
        continue
      }
      // One route's failure must not abort the rest of the batch.
      out.errors.push({ routeNumber: c.routeNumber, error: e instanceof Error ? e.name : 'unknown' })
    }
  }
  out.tenantAtEnd = currentTenantId()
  return out
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const now = Date.now()
  const forcedDryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const flagOn = isEnabled('ROUTE_AUTO_CANCEL_ENABLED')
  const inWindow = isCancellationWindow(now)
  const tenancyOn = isEnabled('TENANCY_ENABLED')

  // TENANT COMPLETENESS. `activeTenantIds()` is a hardcoded single-tenant list, not a
  // registry — it cannot enumerate every tenant. With tenancy OFF that is exactly
  // right (the reference tenant IS the complete set). With tenancy ON it would mean
  // sweeping one tenant and reporting as though all had been processed, so activation
  // is refused outright rather than being silently partial.
  if (tenancyOn) {
    try {
      await alert({
        type: 'cron_job_failed', severity: 'WARNING', worker: 'route-auto-cancel',
        route: '/api/cron/route-auto-cancel', errorClass: 'TenantRegistryIncomplete',
      })
    } catch { /* alerting must never mask the refusal */ }
    return NextResponse.json({
      ok: true, mode: 'blocked (no complete tenant registry)', write: false,
      activationBlocked: true,
      activationBlockedReason:
        'TENANCY_ENABLED is on but activeTenantIds() is a hardcoded single-tenant list, ' +
        'so a complete tenant sweep cannot be proven. Refusing to run rather than ' +
        'processing one tenant and reporting success.',
      scanComplete: false,
      flag: { ROUTE_AUTO_CANCEL_ENABLED: flagOn, TENANCY_ENABLED: tenancyOn },
      timezone: OPS_TIMEZONE, centralDate: centralDate(now), centralHour: centralHour(now),
      graceHours: CANCELLATION_GRACE_HOURS, inCancellationWindow: inWindow,
      scheduled: false,
      tenants: [],
    })
  }

  const write = flagOn && inWindow && !forcedDryRun
  const mode = write ? 'live'
    : forcedDryRun ? 'dry-run (forced by ?dryRun=1)'
    : !flagOn ? 'dry-run (ROUTE_AUTO_CANCEL_ENABLED off)'
    : 'dry-run (outside the cancellation window)'

  try {
    const tenants: Record<string, unknown>[] = []
    let anyIncompleteScan = false
    for (const tenantId of activeTenantIds()) {
      try {
        const r = await withBackgroundTenant('cron', () => runForTenant(now, write), tenantId)
        if (!r.scanComplete) anyIncompleteScan = true
        tenants.push({
          tenant: tenantId,
          scanComplete: r.scanComplete,
          scanned: r.scanned,
          total: r.total,
          ...(r.scanNote ? { scanNote: r.scanNote } : {}),
          // candidateCount is null — never 0 — when the scan was truncated, so a
          // partial pass can never be misread as "nothing to do".
          ...(r.scanComplete
            ? {
                candidates: r.candidates.map(c => ({
                  routeNumber: c.routeNumber, routeDate: c.routeDate, business: c.businessName,
                  status: c.status, reason: c.reason, detail: c.detail,
                })),
                candidateCount: r.candidates.length,
              }
            : { candidateCount: null }),
          cancelled: r.cancelled,
          cancelledCount: r.cancelled.length,
          skipped: r.skipped,
          errors: r.errors,
          tenantContextRestored: r.tenantAtStart === r.tenantAtEnd,
        })
      } catch (e) {
        console.error('[cron/route-auto-cancel] tenant', tenantId, e)
        tenants.push({ tenant: tenantId, error: e instanceof Error ? e.name : 'unknown' })
      }
    }

    if (anyIncompleteScan) {
      try {
        await alert({
          type: 'cron_job_failed', severity: 'WARNING', worker: 'route-auto-cancel',
          route: '/api/cron/route-auto-cancel', errorClass: 'IncompleteRouteScan',
        })
      } catch (alertErr) { console.error('[cron/route-auto-cancel] alert failed', alertErr) }
    }

    return NextResponse.json({
      ok: true,
      mode,
      write,
      scanComplete: !anyIncompleteScan,
      activationBlocked: false,
      flag: { ROUTE_AUTO_CANCEL_ENABLED: flagOn, TENANCY_ENABLED: tenancyOn },
      timezone: OPS_TIMEZONE,
      centralDate: centralDate(now),
      centralHour: centralHour(now),
      centralAt: centralStamp(now),
      graceHours: CANCELLATION_GRACE_HOURS,
      inCancellationWindow: inWindow,
      scheduled: false,
      tenants,
    })
  } catch (e) {
    console.error('[cron/route-auto-cancel] fatal', e)
    try {
      await alert({
        type: 'cron_job_failed', severity: 'WARNING', worker: 'route-auto-cancel',
        route: '/api/cron/route-auto-cancel',
        errorClass: e instanceof Error ? e.name : 'unknown',
      })
    } catch (alertErr) {
      console.error('[cron/route-auto-cancel] alert failed', alertErr)
    }
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
