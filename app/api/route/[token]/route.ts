// PUBLIC route confirmation API — the token IS the credential (no admin session).
// Returns only the scrubbed PublicRoute; never exposes audit/IPs/SMS ids/other
// contractors. Handles expired, cancelled, and already-actioned (idempotent).
import { NextRequest, NextResponse } from 'next/server'
import {
  getRouteByConfirmToken, saveRoute, toPublicRouteFor, setStatus, syncLead, pushEvent, pushAudit, isExpired,
  CONFIRM_DISCLAIMER,
} from '../../../lib/routes'
import { alertOwnerRouteEvent, alertOwnerClockLocationOff } from '../../../lib/route-notify'
import { getFinanceSettings } from '../../../lib/finance'
import { getStaff, staffUsesTimeclock } from '../../../lib/staff'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clientIp = (req: NextRequest) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined

// A finite number in [lo, hi], else undefined. Garbage coordinates are dropped
// rather than stored — a missing pin is honest; a fake one is worse than none.
const coord = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const found = await getRouteByConfirmToken(token)
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const { route, assignee } = found

  // Log this crew member's first open.
  if (!assignee.linkOpenedAt) {
    assignee.linkOpenedAt = Date.now()
    pushEvent(route, 'link_opened', clientIp(req), req.headers.get('user-agent') || undefined)
    syncLead(route)
    try { await saveRoute(route) } catch { /* non-fatal — still show the page */ }
  }
  return NextResponse.json({ route: toPublicRouteFor(route, assignee, { showPay: await showPay(), timeclock: await usesTimeclock(assignee.staffId) }), disclaimer: CONFIRM_DISCLAIMER })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const found = await getRouteByConfirmToken(token)
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const { route, assignee } = found

  const canShowPay = await showPay()
  const canClock = await usesTimeclock(assignee.staffId)
  const pub = () => toPublicRouteFor(route, assignee, { showPay: canShowPay, timeclock: canClock })
  if (route.status === 'cancelled') return NextResponse.json({ error: 'cancelled', route: pub() }, { status: 409 })
  if (isExpired(route)) return NextResponse.json({ error: 'expired', route: pub() }, { status: 410 })

  const body = await req.json().catch(() => ({}))
  const action = S(body.action, 20)
  const ip = clientIp(req)
  const ua = req.headers.get('user-agent') || undefined

  // Completion — a confirmed crew member marks the whole route done on-site.
  if (action === 'complete') {
    if (route.status === 'completed') return NextResponse.json({ ok: true, already: true, route: pub() })
    if (!assignee.confirmedAt) return NextResponse.json({ error: 'Please confirm before marking the route complete.' }, { status: 409 })
    const photos: string[] = Array.isArray(body.photos)
      ? (body.photos as unknown[]).filter((u): u is string => typeof u === 'string' && /^https:\/\/\S+$/.test(u)).slice(0, 6)
      : []
    route.completedAt = Date.now()
    route.completedBy = 'contractor'
    route.completionNote = S(body.note, 500) || undefined
    route.completionPhotos = photos.length ? photos : undefined
    pushEvent(route, 'completed', ip, ua)
    pushAudit(route, 'contractor', `${assignee.name} marked the route complete`)
    setStatus(route, 'completed', 'contractor')
    try { await saveRoute(route) }
    catch { return NextResponse.json({ error: 'Could not save — please try again.' }, { status: 500 }) }
    return NextResponse.json({ ok: true, route: pub() })
  }

  // Timeclock — a confirmed crew member punches in on arrival and out when done.
  // GPS is best-effort: `locationDenied` lets someone whose phone blocked location
  // still record their shift, and the owner sees that the pin is missing.
  if (action === 'clock_in' || action === 'clock_out') {
    if (!canClock) return NextResponse.json({ error: 'The timeclock is turned off for you. Contact dispatch if this is a mistake.' }, { status: 403 })
    if (!assignee.confirmedAt) return NextResponse.json({ error: 'Please confirm the route before clocking in.' }, { status: 409 })
    const lat = coord(body.lat, -90, 90)
    const lng = coord(body.lng, -180, 180)
    const acc = coord(body.accuracy, 0, 100_000)
    const hasFix = lat != null && lng != null
    const denied = body.locationDenied === true || !hasFix
    const now = Date.now()

    if (action === 'clock_in') {
      if (assignee.clockInAt) return NextResponse.json({ ok: true, already: true, route: pub() })
      assignee.clockInAt = now
      assignee.clockInLat = lat; assignee.clockInLng = lng; assignee.clockInAccuracy = acc
      assignee.clockInLocationDenied = denied || undefined
      pushEvent(route, 'clock_in', ip, ua)
      pushAudit(route, 'contractor', `${assignee.name} clocked in · ${fmtCoord(lat, lng)}${denied ? ' (location off)' : ''}`)
    } else {
      if (!assignee.clockInAt) return NextResponse.json({ error: 'Clock in before you clock out.' }, { status: 409 })
      if (assignee.clockOutAt) return NextResponse.json({ ok: true, already: true, route: pub() })
      assignee.clockOutAt = now
      assignee.clockOutLat = lat; assignee.clockOutLng = lng; assignee.clockOutAccuracy = acc
      assignee.clockOutLocationDenied = denied || undefined
      pushEvent(route, 'clock_out', ip, ua)
      pushAudit(route, 'contractor', `${assignee.name} clocked out · ${fmtCoord(lat, lng)}${denied ? ' (location off)' : ''}`)
    }
    try { await saveRoute(route) }
    catch { return NextResponse.json({ error: 'Could not save — please try again.' }, { status: 500 }) }
    // Location off → tell the carrier in real time (best-effort, never blocks the punch).
    if (denied) { try { await alertOwnerClockLocationOff(route, { name: assignee.name }, action) } catch { /* non-fatal */ } }
    return NextResponse.json({ ok: true, route: pub(), locationOff: denied })
  }

  // Idempotent — this crew member already confirmed or declined.
  if (assignee.confirmedAt || assignee.declinedAt) return NextResponse.json({ ok: true, already: true, route: pub() })

  if (action === 'confirm') {
    if (body.disclaimerAccepted !== true)
      return NextResponse.json({ error: 'You must accept the agreement to confirm.' }, { status: 400 })
    const now = Date.now()
    assignee.disclaimerAcceptedAt = now
    assignee.confirmedAt = now
    assignee.confirmedVia = 'link'
    assignee.confirmIp = ip
    pushEvent(route, 'disclaimer_viewed', ip, ua)
    pushEvent(route, 'confirmed', ip, ua)
    pushAudit(route, 'contractor', `${assignee.name} confirmed — will report`)
    syncLead(route)
  } else if (action === 'decline') {
    assignee.declinedAt = Date.now()
    assignee.declineReason = S(body.reason, 300) || undefined
    assignee.confirmIp = ip
    pushEvent(route, 'declined', ip, ua)
    pushAudit(route, 'contractor', assignee.declineReason ? `${assignee.name} declined — not available: ${assignee.declineReason}` : `${assignee.name} declined`)
    syncLead(route)
  } else {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }

  try {
    await saveRoute(route)
  } catch {
    return NextResponse.json({ error: 'Could not save — please try again.' }, { status: 500 })
  }

  if (action === 'decline') {
    try { await alertOwnerRouteEvent(route, 'declined', { name: assignee.name, reason: assignee.declineReason }) } catch { /* non-fatal */ }
  }
  return NextResponse.json({ ok: true, route: pub() })
}
