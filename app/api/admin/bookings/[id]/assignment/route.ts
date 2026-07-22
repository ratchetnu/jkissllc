import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../../_lib/session'
import {
  type AssignmentError, type AssignmentResult,
  assignCrewToBooking, unassignCrewFromBooking, setBookingCrewPay,
  setBookingEquipment, recordBookingCompletion,
} from '../../../../../lib/booking-assignment'
import { getBookingByToken } from '../../../../../lib/bookings'
import { jobCrewGap } from '../../../../../lib/job-assignment'
import { isEnabled } from '../../../../../lib/platform/flags'
import { parseMoneyCents } from '../../../../../lib/finance'
import { str } from '../../../../../lib/validators'

// ─────────────────────────────────────────────────────────────────────────────
// Crew + equipment assignment for a customer Booking.
//
// A DEDICATED route rather than more branches inside the booking PATCH handler:
// that handler carries the money, AI, status, and customer-notification paths,
// and assignment shares none of them. Keeping it separate means assignment cannot
// accidentally trip a customer email or a status transition, and the permission
// story is exact — `crew:assign` / `equipment:assign`, the same permissions the
// Routes lane already gates on, rather than the broader booking-edit rights.
//
// Gated by BOOKING_ASSIGNMENT_ENABLED. With the flag off every verb 404s, so the
// surface is genuinely absent rather than merely hidden.
//
// This route SENDS NOTHING. Assigning a crew member does not text them, does not
// touch the customer, and does not change booking status — all separate actions.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Assignment errors → HTTP + owner-facing copy. Internal reasons never leak.
const ERRORS: Record<AssignmentError, { status: number; message: string }> = {
  disabled:          { status: 404, message: 'Not found.' },
  not_found:         { status: 404, message: 'Booking not found.' },
  unknown_staff:     { status: 400, message: 'That crew member is not on the roster.' },
  inactive_staff:    { status: 400, message: 'That crew member is deactivated.' },
  unknown_equipment: { status: 400, message: 'That equipment is not on the roster.' },
  duplicate_staff:   { status: 409, message: 'That crew member is already on this job.' },
  not_assigned:      { status: 404, message: 'That crew member is not on this job.' },
  conflict:          { status: 409, message: 'This booking is being updated — please retry in a moment.' },
  invalid:           { status: 400, message: 'That assignment is not valid.' },
}

function respond(r: AssignmentResult): NextResponse {
  if (r.ok) return NextResponse.json({ ok: true, assignment: view(r.booking) })
  const { status, message } = ERRORS[r.error]
  return NextResponse.json({ error: r.error, message }, { status })
}

// What the admin UI reads back. Pay IS included — this route already requires
// `crew:assign`, which only admin and manager hold, and it is the same figure the
// Routes lane's crew editor shows.
function view(b: { assignees?: import('../../../../../lib/job-assignment').JobAssignee[]; equipmentId?: string; vehicle?: string; crewSize?: number; assignedTo?: string; assignedHelper?: string }) {
  return {
    crew: (b.assignees ?? []).map(a => ({
      staffId: a.staffId,
      name: a.name,
      role: a.role ?? null,
      phone: a.phone ?? null,
      payCents: a.payCents ?? null,
      paySource: a.paySource ?? null,
      confirmedAt: a.confirmedAt ?? null,
      declinedAt: a.declinedAt ?? null,
      clockInAt: a.clockInAt ?? null,
      clockOutAt: a.clockOutAt ?? null,
    })),
    equipmentId: b.equipmentId ?? null,
    vehicle: b.vehicle ?? null,
    gap: jobCrewGap(b.assignees, b.crewSize),
    // The derived legacy names, echoed back so the UI can show the owner exactly
    // what the customer will see on the confirmation page.
    customerFacing: { assignedTo: b.assignedTo ?? null, assignedHelper: b.assignedHelper ?? null },
  }
}

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 })

// GET — the current crew + equipment for this booking.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) return notFound()
  const who = await requirePermission(req, 'crew:view')
  if (who instanceof NextResponse) return who

  const { id } = await params
  const b = await getBookingByToken(id)
  if (!b) return notFound()
  return NextResponse.json({ ok: true, assignment: view(b) })
})

// POST — one assignment action. `action` selects the verb; each maps to exactly
// one orchestrator in lib/booking-assignment, which owns the invariants.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) return notFound()

  const { id } = await params
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string') {
    return NextResponse.json({ error: 'invalid', message: 'Missing action.' }, { status: 400 })
  }

  switch (body.action) {
    case 'assign_crew': {
      const who = await requirePermission(req, 'crew:assign')
      if (who instanceof NextResponse) return who
      const staffId = str(body.staffId, 64)
      if (!staffId) return NextResponse.json({ error: 'invalid', message: 'Pick a crew member.' }, { status: 400 })
      // A manual rate is dollars-in, cents-out through the ONE money parser, so
      // "$175", "175.00", and "175" all behave exactly as they do on a route.
      const manual = body.pay === undefined || body.pay === null || body.pay === ''
        ? null
        : parseMoneyCents(body.pay)
      if (body.pay !== undefined && body.pay !== null && body.pay !== '' && manual === null) {
        return NextResponse.json({ error: 'invalid', message: 'Enter a valid amount, e.g. 175.00.' }, { status: 400 })
      }
      return respond(await assignCrewToBooking(id, staffId, {
        role: str(body.role, 40) || undefined,
        manualPayCents: manual,
        actor: who.sub,
      }))
    }

    case 'unassign_crew': {
      const who = await requirePermission(req, 'crew:assign')
      if (who instanceof NextResponse) return who
      const staffId = str(body.staffId, 64)
      if (!staffId) return NextResponse.json({ error: 'invalid', message: 'Missing crew member.' }, { status: 400 })
      return respond(await unassignCrewFromBooking(id, staffId, { actor: who.sub }))
    }

    case 'set_pay': {
      // Re-pricing is a compensation decision, not a scheduling one.
      const who = await requirePermission(req, 'pay:configure')
      if (who instanceof NextResponse) return who
      const staffId = str(body.staffId, 64)
      if (!staffId) return NextResponse.json({ error: 'invalid', message: 'Missing crew member.' }, { status: 400 })
      // Explicit null/'' clears back to unpriced; anything else must parse.
      const clear = body.pay === null || body.pay === ''
      const cents = clear ? null : parseMoneyCents(body.pay)
      if (!clear && cents === null) {
        return NextResponse.json({ error: 'invalid', message: 'Enter a valid amount, e.g. 175.00.' }, { status: 400 })
      }
      return respond(await setBookingCrewPay(id, staffId, cents, { actor: who.sub }))
    }

    case 'set_equipment': {
      const who = await requirePermission(req, 'equipment:assign')
      if (who instanceof NextResponse) return who
      return respond(await setBookingEquipment(id, {
        equipmentId: str(body.equipmentId, 64) || null,
        vehicleLabel: str(body.vehicleLabel, 120) || null,
      }, { actor: who.sub }))
    }

    case 'record_completion': {
      const who = await requirePermission(req, 'routes:manage')
      if (who instanceof NextResponse) return who
      return respond(await recordBookingCompletion(id, {
        note: str(body.note, 2000) || undefined,
        photos: body.photos,
        by: 'admin',
        actor: who.sub,
      }))
    }

    default:
      return NextResponse.json({ error: 'invalid', message: 'Unknown action.' }, { status: 400 })
  }
})
