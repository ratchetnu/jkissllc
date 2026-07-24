// One equipment's maintenance record + mutations. GET (equipment:view) reads status +
// history; POST (fleet:maintenance) dispatches on `action` through the pure mutators in
// lib/fleet/maintenance and persists via the canonical equipment store. Every mutation is
// additive (service history is append-only) and service events are idempotent by eventId.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../../_lib/session'
import { getEquipment, saveEquipment } from '../../../../../lib/equipment'
import {
  deriveMaintenanceStatus, addServiceEvent, setSchedule, setOutOfService, returnToService,
  computeNextDueAt, computeNextDueMiles, type ServiceEvent, type ServiceEventKind,
} from '../../../../../lib/fleet/maintenance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KINDS: ServiceEventKind[] = ['service', 'inspection', 'repair', 'note']
const rid = (p: string, now: number) => `${p}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`

export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'equipment:view')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const e = await getEquipment(id)
  if (!e) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const now = Date.now()
  return NextResponse.json({
    ok: true, equipment: e, status: deriveMaintenanceStatus(e, now),
    nextDueAt: computeNextDueAt(e.maintenance ?? {}) ?? null,
    nextDueMiles: computeNextDueMiles(e.maintenance ?? {}) ?? null,
  })
})

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'fleet:maintenance')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const e = await getEquipment(id)
  if (!e) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = String(body.action ?? '')
  const now = Date.now()
  const actor = who.sub

  switch (action) {
    case 'add_service': {
      const kind = KINDS.includes(body.kind as ServiceEventKind) ? (body.kind as ServiceEventKind) : 'service'
      const ev: ServiceEvent = {
        id: typeof body.eventId === 'string' && body.eventId ? body.eventId : rid('sv', now),
        at: now, kind, actor,
        note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
        odometer: typeof body.odometer === 'number' ? body.odometer : undefined,
      }
      e.maintenance = addServiceEvent(e.maintenance, ev)
      break
    }
    case 'update_schedule': {
      const patch: { intervalDays?: number; intervalMiles?: number; inspectionDueAt?: number; notes?: string } = {}
      if (typeof body.intervalDays === 'number') patch.intervalDays = body.intervalDays
      if (typeof body.intervalMiles === 'number') patch.intervalMiles = body.intervalMiles
      if (typeof body.inspectionDueAt === 'number') patch.inspectionDueAt = body.inspectionDueAt
      if (typeof body.notes === 'string') patch.notes = body.notes
      e.maintenance = setSchedule(e.maintenance, patch, actor, now)
      break
    }
    case 'mark_inspection':
      e.maintenance = addServiceEvent(e.maintenance, {
        id: typeof body.eventId === 'string' && body.eventId ? body.eventId : rid('insp', now),
        at: now, kind: 'inspection', actor, note: 'Inspection completed',
      })
      break
    case 'out_of_service':
      e.maintenance = setOutOfService(e.maintenance, typeof body.reason === 'string' ? body.reason : undefined, actor, now)
      break
    case 'return_to_service':
      e.maintenance = returnToService(e.maintenance, actor, now)
      break
    default:
      return NextResponse.json({ error: 'unknown_action' }, { status: 400 })
  }

  await saveEquipment(e)
  return NextResponse.json({ ok: true, equipment: e, status: deriveMaintenanceStatus(e, now) })
})
