// PUBLIC route confirmation API — the token IS the credential (no admin session).
// Returns only the scrubbed PublicRoute; never exposes audit/IPs/SMS ids/other
// contractors. Handles expired, cancelled, and already-actioned (idempotent).
import { NextRequest, NextResponse } from 'next/server'
import {
  getRouteByToken, saveRoute, toPublicRoute, setStatus, pushEvent, pushAudit, isExpired,
  CONFIRM_DISCLAIMER,
} from '../../../lib/routes'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clientIp = (req: NextRequest) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const route = await getRouteByToken(token)
  if (!route) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Log the first open (drives the "opened but didn't confirm" signal later).
  if (!route.linkOpenedAt) {
    route.linkOpenedAt = Date.now()
    pushEvent(route, 'link_opened', clientIp(req), req.headers.get('user-agent') || undefined)
    try { await saveRoute(route) } catch { /* non-fatal — still show the page */ }
  }
  return NextResponse.json({ route: toPublicRoute(route), disclaimer: CONFIRM_DISCLAIMER })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const route = await getRouteByToken(token)
  if (!route) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (route.status === 'cancelled')
    return NextResponse.json({ error: 'cancelled', route: toPublicRoute(route) }, { status: 409 })
  if (isExpired(route))
    return NextResponse.json({ error: 'expired', route: toPublicRoute(route) }, { status: 410 })
  // Idempotent — already confirmed or declined.
  if (route.status === 'confirmed' || route.status === 'declined')
    return NextResponse.json({ ok: true, already: true, route: toPublicRoute(route) })

  const body = await req.json().catch(() => ({}))
  const action = S(body.action, 20)
  const ip = clientIp(req)
  const ua = req.headers.get('user-agent') || undefined

  if (action === 'confirm') {
    if (body.disclaimerAccepted !== true)
      return NextResponse.json({ error: 'You must accept the agreement to confirm.' }, { status: 400 })
    const now = Date.now()
    route.disclaimerAcceptedAt = now
    route.confirmedAt = now
    route.confirmIp = ip
    route.confirmPhone = S(body.phone, 40) || undefined
    pushEvent(route, 'disclaimer_viewed', ip, ua)
    pushEvent(route, 'confirmed', ip, ua)
    pushAudit(route, 'contractor', 'Confirmed — will report')
    setStatus(route, 'confirmed', 'contractor')
  } else if (action === 'decline') {
    route.declinedAt = Date.now()
    route.declineReason = S(body.reason, 300) || undefined
    route.confirmIp = ip
    pushEvent(route, 'declined', ip, ua)
    pushAudit(route, 'contractor', 'Declined route')
    setStatus(route, 'declined', 'contractor')
  } else {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }

  try {
    await saveRoute(route)
  } catch {
    return NextResponse.json({ error: 'Could not save — please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, route: toPublicRoute(route) })
}
