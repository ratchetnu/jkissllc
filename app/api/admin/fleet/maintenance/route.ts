// Fleet maintenance — status list + the maintenance.flag executor trigger.
// GET (equipment:view) lists every equipment's derived status + summary counts.
// POST (fleet:maintenance) runs the idempotent, internal-only maintenance.flag executor.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { listEquipment } from '../../../../lib/equipment'
import { deriveMaintenanceStatus, fleetSummary } from '../../../../lib/fleet/maintenance'
import { runMaintenanceFlag } from '../../../../lib/fleet/maintenance-flag'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'equipment:view')
  if (who instanceof NextResponse) return who
  try {
    const now = Date.now()
    const equipment = await listEquipment(500)
    const items = equipment.map((e) => ({
      id: e.id, name: e.name, truckType: e.truckType, ownership: e.ownership, active: e.active,
      status: deriveMaintenanceStatus(e, now),
      outOfService: !!e.maintenance?.outOfService,
      outOfServiceReason: e.maintenance?.outOfServiceReason ?? null,
      lastServiceAt: e.maintenance?.lastServiceAt ?? null,
      nextDueAt: e.maintenance?.nextDueAt ?? null,
      inspectionDueAt: e.maintenance?.inspectionDueAt ?? null,
      historyCount: e.maintenance?.history?.length ?? 0,
    }))
    return NextResponse.json({ ok: true, items, summary: fleetSummary(equipment, now), generatedAt: now })
  } catch (err) {
    if (err instanceof Error && err.message === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[fleet/maintenance GET]', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'fleet:maintenance')
  if (who instanceof NextResponse) return who
  const result = await runMaintenanceFlag()
  return NextResponse.json({ ok: true, ...result })
})
