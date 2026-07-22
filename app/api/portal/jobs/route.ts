import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { listRoutes, ROUTE_STATUS_LABEL, type RouteRecord } from '../../../lib/routes'
import {
  listBookings, effectiveServiceDate, BOOKING_STATUS_LABEL, SERVICE_LABELS,
  type Booking,
} from '../../../lib/bookings'
import { getFinanceSettings } from '../../../lib/finance'
import { isEnabled } from '../../../lib/platform/flags'
import { centralToday } from '../../../lib/dates'

// ─────────────────────────────────────────────────────────────────────────────
// My Jobs — the crew portal's UNIFIED work feed.
//
// Until now the portal read routes only (`/api/portal/routes`), so a crew member
// assigned to a moving or junk-removal job saw an empty portal: their work simply
// did not exist to the system. This feed reads BOTH lanes and returns one shape.
//
// `/api/portal/routes` is deliberately LEFT ALONE and still serves the shipped
// portal UI unchanged. This is the additive surface the new UI reads.
//
// AUTHORIZATION. Everything is scoped to `who.staffId` from the signed session —
// never an id from the request. A crew member sees only jobs they are personally
// assigned to, and only the fields they need to do the work.
//
// WHAT CREW MAY NOT SEE. Customer money is never projected here: no invoice total,
// no balance, no payment state, no deposit — those are `profitability:view` /
// admin concerns and a crew principal holds neither. Their OWN pay appears only
// when the owner has opted in (`showPayInConfirm`), matching the confirmation-link
// rule exactly. Co-workers' pay and phone numbers are never included.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROUTE_DONE = new Set(['completed', 'cancelled', 'declined'])
const BOOKING_DONE = new Set(['completed', 'partially_completed', 'could_not_complete', 'cancelled', 'refunded'])

type PortalJob = {
  kind: 'route' | 'booking'
  id: string                     // source record token (routes: the ROUTE token)
  number: string
  token: string | null           // this crew member's own confirm/clock link
  title: string                  // business name (route) / customer name (booking)
  serviceLabel: string
  address: string | null
  date: string                   // YYYY-MM-DD
  timeLabel: string | null
  status: string
  statusLabel: string
  description: string | null
  notes: string | null
  vehicle: string | null
  role: string | null
  payCents: number | null
  confirmedAt: number | null
  declinedAt: number | null
  clockInAt: number | null
  clockOutAt: number | null
  completedAt: number | null
  crew: { name: string; role: string | null }[]   // co-workers: names + roles only
  href: string
}

function fromRoute(r: RouteRecord, staffId: string, showPay: boolean): PortalJob | null {
  const me = r.assignees?.find(a => a.staffId === staffId)
  if (!me) return null
  return {
    kind: 'route',
    id: r.token,
    number: r.routeNumber,
    token: me.token,
    title: r.businessName,
    serviceLabel: 'Contract Route',
    address: r.reportAddress || null,
    date: r.routeDate,
    timeLabel: r.reportTime || null,
    status: r.status,
    statusLabel: ROUTE_STATUS_LABEL[r.status] ?? r.status,
    description: r.description ?? null,
    notes: r.specialNotes ?? null,
    vehicle: r.vehicle ?? null,
    role: me.role ?? null,
    payCents: showPay ? (me.payCents ?? null) : null,
    confirmedAt: me.confirmedAt ?? null,
    declinedAt: me.declinedAt ?? null,
    clockInAt: me.clockInAt ?? null,
    clockOutAt: me.clockOutAt ?? null,
    completedAt: r.completedAt ?? null,
    crew: (r.assignees ?? [])
      .filter(a => a.staffId !== staffId && !a.declinedAt)
      .map(a => ({ name: a.name, role: a.role ?? null })),
    href: `/route/${me.token}`,
  }
}

function fromBooking(b: Booking, staffId: string, showPay: boolean): PortalJob | null {
  const me = b.assignees?.find(a => a.staffId === staffId)
  if (!me) return null
  return {
    kind: 'booking',
    id: b.token,
    number: b.bookingNumber,
    token: me.token,
    title: b.customerName || 'Customer',
    serviceLabel: SERVICE_LABELS[b.serviceType] ?? 'Service',
    // The address the crew actually reports to, in the same precedence the
    // schedule uses. Never the customer's phone or email — dispatch owns contact.
    address: b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || null,
    date: effectiveServiceDate(b),
    timeLabel: b.selectedWindow || null,
    status: b.status,
    statusLabel: BOOKING_STATUS_LABEL[b.status] ?? b.status,
    description: b.description ?? null,
    // Access details the customer supplied (gate codes, stairs, parking) are the
    // whole point of showing a crew member their job. Internal notes are NOT here.
    notes: b.customerNotes ?? null,
    vehicle: b.vehicle ?? null,
    role: me.role ?? null,
    payCents: showPay ? (me.payCents ?? null) : null,
    confirmedAt: me.confirmedAt ?? null,
    declinedAt: me.declinedAt ?? null,
    clockInAt: me.clockInAt ?? null,
    clockOutAt: me.clockOutAt ?? null,
    completedAt: b.jobCompletedAt ?? null,
    crew: (b.assignees ?? [])
      .filter(a => a.staffId !== staffId && !a.declinedAt)
      .map(a => ({ name: a.name, role: a.role ?? null })),
    href: `/portal/jobs/${b.token}`,
  }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const bookingsEnabled = isEnabled('BOOKING_ASSIGNMENT_ENABLED')

  const [routes, bookings, fin] = await Promise.all([
    listRoutes(500),
    // With the flag off we don't even read the booking store — the feed is exactly
    // the routes feed, which is what the portal has always shown.
    bookingsEnabled ? listBookings(500) : Promise.resolve([] as Booking[]),
    getFinanceSettings(),
  ])
  const showPay = !!fin?.showPayInConfirm
  const today = centralToday()

  const mine: PortalJob[] = [
    ...routes.map(r => fromRoute(r, who.staffId, showPay)),
    // Sandbox test + archived bookings are never real work for a crew member.
    ...bookings
      .filter(b => !b.isTest && !b.archived)
      .map(b => fromBooking(b, who.staffId, showPay)),
  ].filter((x): x is PortalJob => x !== null)

  const isDone = (j: PortalJob): boolean =>
    j.kind === 'route' ? ROUTE_DONE.has(j.status) : BOOKING_DONE.has(j.status)

  // An undated job (a booking the customer hasn't scheduled yet) sorts with
  // upcoming work rather than vanishing into history.
  const upcoming = mine
    .filter(j => !isDone(j) && (!j.date || j.date >= today))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))
  const past = mine
    .filter(j => isDone(j) || (!!j.date && j.date < today))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50)

  return NextResponse.json({ ok: true, upcoming, past, showPay, today })
})
