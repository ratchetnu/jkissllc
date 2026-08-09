// PUBLIC route confirmation API — the token IS the credential (no admin session).
// Returns only the scrubbed PublicRoute; never exposes audit/IPs/SMS ids/other
// contractors. Handles expired, cancelled, and already-actioned (idempotent).
import { NextRequest, NextResponse } from 'next/server'
import { withPublicTokenRoute } from '../../../lib/platform/tenancy/with-public-token-route'
import {
  getRouteByConfirmToken, saveRoute, toPublicRouteFor, setStatus, syncLead, pushEvent, pushAudit, isExpired,
  CONFIRM_DISCLAIMER,
} from '../../../lib/routes'
import { withRouteLock, mutateByConfirmToken, RouteBusyError } from '../../../lib/route-mutex'
import { alertOwnerRouteEvent, alertOwnerClockLocationOff } from '../../../lib/route-notify'
import { getFinanceSettings } from '../../../lib/finance'
import { getStaff, staffUsesTimeclock } from '../../../lib/staff'
import { effectivePunch, listCorrections, punchId } from '../../../lib/time-corrections'
import { applyPunch, coord, type ClockAction } from '../../../lib/crew-timeclock'
import { withSingleOpenPunchPolicy } from '../../../lib/timeclock/punch-policy'
import { syncAssigneePunchIndex } from '../../../lib/timeclock/punch-index-sync'
import { isEnabled } from '../../../lib/platform/flags'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clientIp = (req: NextRequest) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined

const fmtCoord = (lat?: number, lng?: number) =>
  lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'location not shared'

// The crew member sees their own pay only if the owner turned that on. If the
// setting can't be read, fail CLOSED — showing money by accident is worse than
// omitting it. What the client pays and the route's profit are never in scope
// here: PublicRoute has no field for them.
async function showPay(): Promise<boolean> {
  try { return (await getFinanceSettings()).showPayInConfirm } catch { return false }
}

// Does THIS crew member use the timeclock? Read live from their staff record so
// the owner's toggle takes effect on routes already assigned. Fail OPEN (default
// on) if the record can't be read — a missing lookup shouldn't strand a punch.
async function usesTimeclock(staffId: string): Promise<boolean> {
  try { return staffUsesTimeclock(await getStaff(staffId)) } catch { return true }
}

export const GET = withPublicTokenRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const found = await getRouteByConfirmToken(token)
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  let { route, assignee } = found

  // Log this crew member's first open — under the route lock so two crew opening at
  // once can't clobber each other's stamp. Best-effort: a busy lock never blocks the
  // page from rendering.
  if (!assignee.linkOpenedAt) {
    try {
      const ua = req.headers.get('user-agent') || undefined
      const res = await mutateByConfirmToken(token, (r, a) => {
        if (a.linkOpenedAt) return false // already stamped by a concurrent open — skip the save
        a.linkOpenedAt = Date.now()
        pushEvent(r, 'link_opened', clientIp(req), ua)
        syncLead(r)
        return true
      })
      if (res) { route = res.route; assignee = res.assignee }
    } catch { /* busy or save failed — still show the page */ }
  }
  return NextResponse.json({ route: toPublicRouteFor(route, assignee, { showPay: await showPay(), timeclock: await usesTimeclock(assignee.staffId) }), disclaimer: CONFIRM_DISCLAIMER })
}, { expect: 'route' })

// Every mutation runs INSIDE the route lock (reloading the route fresh) so two crew
// members — or a crew member and the admin — acting on the same route at the same
// moment serialize instead of clobbering each other's write. The lock lambda returns
// a response plus an optional `notify` thunk; slow Twilio alerts run AFTER the lock
// releases so a text send never holds the route or risks the lock's TTL.
type PostOutcome = { response: NextResponse; notify?: () => Promise<void> }

export const POST = withPublicTokenRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const first = await getRouteByConfirmToken(token)
  if (!first) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = S(body.action, 20)
  const ip = clientIp(req)
  const ua = req.headers.get('user-agent') || undefined

  let outcome: PostOutcome
  try {
    const write = () => withRouteLock(first.route.token, async (): Promise<PostOutcome> => {
      const found = await getRouteByConfirmToken(token)
      if (!found) return { response: NextResponse.json({ error: 'not_found' }, { status: 404 }) }
      const { route, assignee } = found

      const canShowPay = await showPay()
      const canClock = await usesTimeclock(assignee.staffId)
      const pub = () => toPublicRouteFor(route, assignee, { showPay: canShowPay, timeclock: canClock })
      const saveFail = { response: NextResponse.json({ error: 'Could not save — please try again.' }, { status: 500 }) }
      if (route.status === 'cancelled') return { response: NextResponse.json({ error: 'cancelled', route: pub() }, { status: 409 }) }
      if (isExpired(route)) return { response: NextResponse.json({ error: 'expired', route: pub() }, { status: 410 }) }

      // Completion — a confirmed crew member marks the whole route done on-site.
      //
      // COMPLETING ALSO CLOSES THIS CREW MEMBER'S OPEN PUNCH. Completion used to leave
      // the punch open forever: nothing in this file or anywhere else set
      // `clockOutAt` on completion, so anyone who clocked in and then finished from
      // this link stayed on the clock indefinitely. That is not an edge case — it is
      // the guaranteed outcome of the normal sequence, and it produced the one stale
      // punch found in Production (route JK-R-1004).
      if (action === 'complete') {
        if (route.status === 'completed') return { response: NextResponse.json({ ok: true, already: true, route: pub() }) }
        if (!assignee.confirmedAt) return { response: NextResponse.json({ error: 'Please confirm before marking the route complete.' }, { status: 409 }) }

        // Is THIS crew member's punch actually open? Decided on the EFFECTIVE punch,
        // so an admin time correction that already closed it is never overwritten —
        // `effectivePunch` with no corrections simply returns the raw stamps, so this
        // one check covers both "already clocked out" and "corrected closed".
        let punchOpen = false
        let punchCorrected = false
        try {
          const eff = effectivePunch(
            { clockInAt: assignee.clockInAt ?? null, clockOutAt: assignee.clockOutAt ?? null },
            await listCorrections(punchId('route', route.token, assignee.staffId)),
          )
          // Never CREATE a punch: an absent clock-in stays absent.
          punchOpen = eff.clockInAt != null && eff.clockOutAt == null
          punchCorrected = eff.corrected
        } catch {
          // Fail closed. Completing while we cannot tell whether a punch would be
          // stranded is exactly the state this change exists to prevent.
          return { response: NextResponse.json({ error: 'Could not save — please try again.' }, { status: 503 }) }
        }
        if (punchOpen && punchCorrected) {
          return {
            response: NextResponse.json({
              error: 'This shift has a time correction and is still open. Ask dispatch to close the corrected time entry before completing the route.',
              code: 'corrected_punch_open',
            }, { status: 409 }),
          }
        }

        const photos: string[] = Array.isArray(body.photos)
          ? (body.photos as unknown[]).filter((u): u is string => typeof u === 'string' && /^https:\/\/\S+$/.test(u)).slice(0, 6)
          : []
        // ONE timestamp for the completion and the automatic clock-out, so the record
        // cannot say the shift ended at a different moment than the work did.
        const completedAt = Date.now()
        route.completedAt = completedAt
        route.completedBy = 'contractor'
        route.completionNote = S(body.note, 500) || undefined
        route.completionPhotos = photos.length ? photos : undefined
        if (punchOpen) {
          assignee.clockOutAt = completedAt
          // No GPS is captured on an automatic punch, so record it as unverified
          // rather than letting a missing pin read as a verified one.
          assignee.clockOutLocationDenied = true
          pushEvent(route, 'clock_out', ip, ua)
          pushAudit(route, 'contractor', `${assignee.name} clocked out automatically on completion`)
        }
        pushEvent(route, 'completed', ip, ua)
        pushAudit(route, 'contractor', `${assignee.name} marked the route complete`)
        setStatus(route, 'completed', 'contractor')
        // ONE save for both mutations. If it throws, NOTHING is persisted — the route
        // does not become Completed and the punch is not half-closed. Atomicity here
        // is structural, not bolted on.
        try { await saveRoute(route) } catch { return saveFail }
        // Completion may have closed this crew member's punch automatically. The
        // index has to learn that here, or the shift stays "open" in enforcement
        // and blocks their next job.
        await syncAssigneePunchIndex('route', route.token, route.routeDate, assignee)
        return { response: NextResponse.json({ ok: true, route: pub(), clockedOut: punchOpen }) }
      }

      // Timeclock — a confirmed crew member punches in on arrival and out when done.
      // GPS is best-effort: `locationDenied` lets someone whose phone blocked location
      // still record their shift, and the owner sees that the pin is missing.
      if (action === 'clock_in' || action === 'clock_out') {
        if (!canClock) return { response: NextResponse.json({ error: 'The timeclock is turned off for you. Contact dispatch if this is a mistake.' }, { status: 403 }) }
        // The policy scan was made for the route date observed before taking the
        // per-route lock. If dispatch moved the route concurrently, retry against
        // the new date instead of enforcing the wrong date's punch set.
        if (
          isEnabled('SINGLE_OPEN_PUNCH_ENABLED') &&
          route.routeDate !== first.route.routeDate
        ) {
          return { response: NextResponse.json({ error: 'The route was updated — please try again.' }, { status: 503 }) }
        }
        const clockAction = action as ClockAction
        const gps = { lat: body.lat, lng: body.lng, accuracy: body.accuracy, locationDenied: body.locationDenied }
        const lat = coord(body.lat, -90, 90)
        const lng = coord(body.lng, -180, 180)
        const punch = applyPunch(assignee, clockAction, gps, Date.now())
        if (!punch.ok) {
          const error = punch.code === 'not_confirmed'
            ? 'Please confirm the route before clocking in.'
            : 'Clock in before you clock out.'
          return { response: NextResponse.json({ error }, { status: 409 }) }
        }
        if (!punch.changed) {
          return { response: NextResponse.json({ ok: true, already: true, route: pub() }) }
        }
        pushEvent(route, clockAction, ip, ua)
        pushAudit(route, 'contractor',
          `${assignee.name} ${clockAction === 'clock_in' ? 'clocked in' : 'clocked out'} · ${fmtCoord(lat, lng)}${punch.denied ? ' (location off)' : ''}`)
        try { await saveRoute(route) } catch { return saveFail }
        await syncAssigneePunchIndex('route', route.token, route.routeDate, assignee)
        // Location off → tell the carrier in real time (best-effort; runs after the lock).
        const crewName = assignee.name
        return {
          response: NextResponse.json({ ok: true, route: pub(), locationOff: punch.denied }),
          notify: punch.denied ? () => alertOwnerClockLocationOff(route, { name: crewName }, clockAction) : undefined,
        }
      }

      // Idempotent — this crew member already confirmed or declined.
      if (assignee.confirmedAt || assignee.declinedAt) return { response: NextResponse.json({ ok: true, already: true, route: pub() }) }

      if (action === 'confirm') {
        if (body.disclaimerAccepted !== true)
          return { response: NextResponse.json({ error: 'You must accept the agreement to confirm.' }, { status: 400 }) }
        const now = Date.now()
        assignee.disclaimerAcceptedAt = now
        assignee.confirmedAt = now
        assignee.confirmedVia = 'link'
        assignee.confirmIp = ip
        pushEvent(route, 'disclaimer_viewed', ip, ua)
        pushEvent(route, 'confirmed', ip, ua)
        pushAudit(route, 'contractor', `${assignee.name} confirmed — will report`)
        syncLead(route)
        try { await saveRoute(route) } catch { return saveFail }
        return { response: NextResponse.json({ ok: true, route: pub() }) }
      } else if (action === 'decline') {
        assignee.declinedAt = Date.now()
        assignee.declineReason = S(body.reason, 300) || undefined
        assignee.confirmIp = ip
        pushEvent(route, 'declined', ip, ua)
        pushAudit(route, 'contractor', assignee.declineReason ? `${assignee.name} declined — not available: ${assignee.declineReason}` : `${assignee.name} declined`)
        syncLead(route)
        try { await saveRoute(route) } catch { return saveFail }
        const crewName = assignee.name, reason = assignee.declineReason
        return {
          response: NextResponse.json({ ok: true, route: pub() }),
          notify: () => alertOwnerRouteEvent(route, 'declined', { name: crewName, reason }),
        }
      }
      return { response: NextResponse.json({ error: 'Unknown action.' }, { status: 400 }) }
    })

    if (action === 'clock_in' || action === 'clock_out') {
      const governed = await withSingleOpenPunchPolicy(action, {
        type: 'route',
        jobToken: first.route.token,
        staffId: first.assignee.staffId,
        serviceDate: first.route.routeDate,
      }, write)
      if (!governed.ok) {
        outcome = governed.block === 'other_open_punch'
          ? { response: NextResponse.json({ error: 'You’re still clocked into another job on this service date. Clock out there first.' }, { status: 409 }) }
          // Permanent until dispatch sets a date. Saying "try again" would invite a
          // retry loop against a condition the crew member cannot change.
          : governed.block === 'undated_job'
            ? { response: NextResponse.json({ error: 'This job has no service date yet. Ask dispatch to set one before clocking in.' }, { status: 409 }) }
            : { response: NextResponse.json({ error: 'Could not verify your other punches — please try again.' }, { status: 503 }) }
      } else {
        outcome = governed.value
      }
    } else {
      outcome = await write()
    }
  } catch (e) {
    if (e instanceof RouteBusyError) return NextResponse.json({ error: 'The route is being updated — please try again.' }, { status: 503 })
    throw e
  }

  if (outcome.notify) { try { await outcome.notify() } catch { /* non-fatal */ } }
  return outcome.response
}, { expect: 'route' })
