import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../../_lib/crew'
import {
  acceptBookingAssignment, declineBookingAssignment,
  punchBookingClock, recordBookingCompletion,
  type AssignmentError,
} from '../../../../lib/booking-assignment'
import { getBookingByToken, effectiveServiceDate, BOOKING_STATUS_LABEL, SERVICE_LABELS, type Booking } from '../../../../lib/bookings'
import { crewUsesTimeclock } from '../../../../lib/crew-timeclock'
import { getFinanceSettings } from '../../../../lib/finance'
import { isEnabled } from '../../../../lib/platform/flags'
import { getIP } from '../../../../lib/req'
import { str } from '../../../../lib/validators'

// ─────────────────────────────────────────────────────────────────────────────
// One booking job, from the assigned crew member's side: accept it, decline it,
// clock in/out, and send completion photos from the field.
//
// AUTHORIZATION IS THE WHOLE POINT OF THIS FILE. The booking token in the URL is
// the customer's link key, so it can NOT be treated as a credential here. Every
// verb re-resolves the caller's own assignment by `who.staffId` from the signed
// session and refuses when they are not on this job — so possessing (or guessing
// at) a booking token grants a crew principal nothing.
//
// Gated by BOOKING_ASSIGNMENT_ENABLED: with the flag off the whole surface 404s.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 })

const ERRORS: Record<AssignmentError | 'not_confirmed' | 'not_clocked_in', { status: number; message: string }> = {
  disabled:          { status: 404, message: 'Not found.' },
  not_found:         { status: 404, message: 'Job not found.' },
  not_assigned:      { status: 404, message: 'Job not found.' },   // never confirm a job exists to someone not on it
  unknown_staff:     { status: 404, message: 'Job not found.' },
  inactive_staff:    { status: 403, message: 'Your account is inactive. Contact dispatch.' },
  unknown_equipment: { status: 400, message: 'That equipment is not on the roster.' },
  duplicate_staff:   { status: 409, message: 'You are already on this job.' },
  conflict:          { status: 409, message: 'This job is being updated — please try again.' },
  invalid:           { status: 400, message: 'That action is not valid.' },
  not_confirmed:     { status: 409, message: 'Accept the job before you clock in.' },
  not_clocked_in:    { status: 409, message: 'Clock in before you clock out.' },
}

const fail = (e: keyof typeof ERRORS) =>
  NextResponse.json({ error: e, message: ERRORS[e].message }, { status: ERRORS[e].status })

// The crew member's own view of the job. Customer MONEY is never projected — no
// invoice total, no balance, no payment state — and neither are internal notes.
function view(b: Booking, staffId: string, showPay: boolean) {
  const me = b.assignees?.find(a => a.staffId === staffId)
  if (!me) return null
  return {
    id: b.token,
    number: b.bookingNumber,
    title: b.customerName || 'Customer',
    serviceLabel: SERVICE_LABELS[b.serviceType] ?? 'Service',
    address: b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || null,
    date: effectiveServiceDate(b),
    timeLabel: b.selectedWindow || null,
    status: b.status,
    statusLabel: BOOKING_STATUS_LABEL[b.status] ?? b.status,
    description: b.description ?? null,
    // Access details the CUSTOMER supplied (gate codes, stairs, parking) — the
    // reason a crew member opens this screen. `internalNotes` stays admin-only.
    notes: b.customerNotes ?? null,
    items: b.items ?? [],
    vehicle: b.vehicle ?? null,
    me: {
      role: me.role ?? null,
      payCents: showPay ? (me.payCents ?? null) : null,
      confirmedAt: me.confirmedAt ?? null,
      declinedAt: me.declinedAt ?? null,
      clockInAt: me.clockInAt ?? null,
      clockOutAt: me.clockOutAt ?? null,
    },
    crew: (b.assignees ?? [])
      .filter(a => a.staffId !== staffId && !a.declinedAt)
      .map(a => ({ name: a.name, role: a.role ?? null })),   // names + roles only
    completion: {
      completedAt: b.jobCompletedAt ?? null,
      note: b.completionNote ?? null,
      photos: b.completionPhotos ?? [],
    },
  }
}

export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) return notFound()
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const { id } = await params
  const [b, fin] = await Promise.all([getBookingByToken(id), getFinanceSettings()])
  if (!b || b.archived) return notFound()

  const v = view(b, who.staffId, !!fin?.showPayInConfirm)
  if (!v) return notFound()          // assigned to someone else — indistinguishable from absent
  return NextResponse.json({ ok: true, job: v })
})

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) return notFound()
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  switch (body.action) {
    case 'accept':
      return respond(await acceptBookingAssignment(id, who.staffId, { ip: getIP(req) }))

    case 'decline':
      return respond(await declineBookingAssignment(id, who.staffId, str(body.reason, 500)))

    case 'clock_in':
    case 'clock_out': {
      // The owner's per-crew timeclock toggle governs both lanes identically.
      if (!(await crewUsesTimeclock(who.staffId))) {
        return NextResponse.json(
          { error: 'timeclock_off', message: 'The timeclock is turned off for you. Contact dispatch if this is a mistake.' },
          { status: 403 },
        )
      }
      const r = await punchBookingClock(id, who.staffId, body.action, {
        lat: body.lat, lng: body.lng, accuracy: body.accuracy, locationDenied: body.locationDenied,
      })
      if (!r.ok) return fail(r.error)
      return NextResponse.json({ ok: true, already: r.already, denied: r.denied })
    }

    case 'complete':
      // Proof of work, NOT a billing decision: this records photos and a note and
      // never changes BookingStatus. The owner still closes the job out.
      //
      // `staffId` comes from the SIGNED SESSION, never the body, and the
      // orchestrator refuses unless that crew member is actually on this booking
      // and has not declined it — so a booking token alone grants nothing here,
      // exactly as it grants nothing to accept / decline / clock_in / clock_out.
      return respond(await recordBookingCompletion(id, {
        note: str(body.note, 2000),
        photos: body.photos,
        by: 'crew',
        staffId: who.staffId,
      }))

    default:
      return NextResponse.json({ error: 'invalid', message: 'Unknown action.' }, { status: 400 })
  }

  function respond(r: { ok: true; booking: Booking } | { ok: false; error: AssignmentError }): NextResponse {
    if (!r.ok) return fail(r.error)
    return NextResponse.json({ ok: true })
  }
})
