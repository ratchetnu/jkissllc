// PUBLIC route confirmation API — the token IS the credential (no admin session).
// Returns only the scrubbed PublicRoute; never exposes audit/IPs/SMS ids/other
// contractors. Handles expired, cancelled, and already-actioned (idempotent).
import { NextRequest, NextResponse } from 'next/server'
import {
  getRouteByConfirmToken, saveRoute, toPublicRouteFor, setStatus, syncLead, pushEvent, pushAudit, isExpired,
  CONFIRM_DISCLAIMER,
} from '../../../lib/routes'
import { alertOwnerRouteEvent } from '../../../lib/route-notify'
import { getFinanceSettings } from '../../../lib/finance'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clientIp = (req: NextRequest) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined

// The crew member sees their own pay only if the owner turned that on. If the
// setting can't be read, fail CLOSED — showing money by accident is worse than
// omitting it. What the client pays and the route's profit are never in scope
// here: PublicRoute has no field for them.
async function showPay(): Promise<boolean> {
  try { return (await getFinanceSettings()).showPayInConfirm } catch { return false }
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
  return NextResponse.json({ route: toPublicRouteFor(route, assignee, { showPay: await showPay() }), disclaimer: CONFIRM_DISCLAIMER })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const found = await getRouteByConfirmToken(token)
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const { route, assignee } = found

  const canShowPay = await showPay()
  const pub = () => toPublicRouteFor(route, assignee, { showPay: canShowPay })
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

  // Idempotent — this crew member already confirmed or declined.
  if (assignee.confirmedAt || assignee.declinedAt) return NextResponse.json({ ok: true, already: true, route: pub() })

  if (action === 'confirm') {
    if (body.disclaimerAccepted !== true)
      return NextResponse.json({ error: 'You must accept the agreement to confirm.' }, { status: 400 })
    const now = Date.now()
    assignee.disclaimerAcceptedAt = now
    assignee.confirmedAt = now
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
