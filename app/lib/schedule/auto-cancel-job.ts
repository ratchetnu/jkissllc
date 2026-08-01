// ─────────────────────────────────────────────────────────────────────────────
// Stale-route auto-cancellation — the JOB BODY (scheduling, safety, persistence).
//
// Extracted from app/api/cron/route-auto-cancel/route.ts so the clock is an
// ordinary parameter rather than a `Date.now()` call buried in a route handler.
// The integration suite previously had to run on one specific calendar day; it now
// pins a fixed instant through `runAutoCancelJob(req, now)`.
//
// A Next.js route module may only export its HTTP handlers and a small set of
// config names, so the injectable entry point lives here rather than beside GET.
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server'
import { scanAllRoutes, getRouteByToken, saveRoute, autoCancelRoute } from '../routes'
import { withRouteLock, RouteBusyError } from '../route-mutex'
import { isEnabled } from '../platform/flags'
import { withBackgroundTenant } from '../platform/tenancy/request-context'
import { activeTenantIdsFromRegistry } from '../platform/tenancy/tenant-registry'
import { currentTenantId } from '../platform/tenancy/context'
import { alert } from '../alerts'
import {
  selectAutoCancelCandidates, isCancellationWindow, centralDate, centralHour, centralStamp,
  OPS_TIMEZONE, CANCELLATION_GRACE_HOURS,
  type AutoCancelCandidate,
} from './auto-cancel'

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
        // Re-run the COMPLETE eligibility predicate. Checking only selected fields
        // here previously allowed a route changed back to Draft after the scan to be
        // cancelled. The locked record must qualify exactly as a fresh candidate.
        const stillEligible = selectAutoCancelCandidates([fresh], now)[0]
        if (!stillEligible) {
          const why = fresh.status === 'draft'
            ? 'route returned to draft since scan'
            : fresh.routeDate !== c.routeDate
              ? 'route date changed'
              : (fresh.assignees?.length ?? 0) > 0
                ? 'crew assigned since scan'
                : `already ${fresh.status}`
          out.skipped.push({ routeNumber: c.routeNumber, why })
          return
        }

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

/**
 * The whole job, with the clock as an ORDINARY PARAMETER.
 *
 * `now` is the single seam the integration suite uses to pin a fixed instant. It is
 * a normal function argument on an internal module — deliberately NOT a query
 * parameter, header, environment override, or any other switch reachable in
 * Production. The only caller in Production is the route handler, which passes
 * `Date.now()`, so runtime behaviour is byte-identical to before this extraction.
 */
export async function runAutoCancelJob(req: NextRequest, now: number): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const forcedDryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const flagOn = isEnabled('ROUTE_AUTO_CANCEL_ENABLED')
  const inWindow = isCancellationWindow(now)
  const tenancyOn = isEnabled('TENANCY_ENABLED')

  let activeTenants: string[]
  try {
    activeTenants = await activeTenantIdsFromRegistry()
  } catch {
    return NextResponse.json({
      ok: true, mode: 'blocked (tenant registry unavailable)', write: false,
      activationBlocked: true,
      activationBlockedReason: 'No complete active-tenant registry is available; refusing a partial sweep.',
      scanComplete: false,
      flag: { ROUTE_AUTO_CANCEL_ENABLED: flagOn, TENANCY_ENABLED: tenancyOn },
      timezone: OPS_TIMEZONE, centralDate: centralDate(now), centralHour: centralHour(now),
      graceHours: CANCELLATION_GRACE_HOURS, inCancellationWindow: inWindow,
      scheduled: false, tenants: [],
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
    for (const tenantId of activeTenants) {
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
        anyIncompleteScan = true
        tenants.push({
          tenant: tenantId,
          scanComplete: false,
          candidateCount: null,
          cancelled: [],
          cancelledCount: 0,
          error: e instanceof Error ? e.name : 'unknown',
        })
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
      ok: !anyIncompleteScan,
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
    }, { status: anyIncompleteScan ? 503 : 200 })
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
