import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listEquipment, saveEquipment, deleteEquipment, type Equipment, type Ownership } from '../../../lib/equipment'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const OWNERSHIP: Ownership[] = ['company', 'contractor']
const isOwnership = (v: unknown): v is Ownership => typeof v === 'string' && (OWNERSHIP as string[]).includes(v)

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'equipment:manage')
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, items: await listEquipment() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'equipment:manage')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const name = S(body.name, 100)
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 })

  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
  const now = Date.now()
  const existing = body.id ? (await listEquipment()).find(e => e.id === body.id) : undefined

  const ownership: Ownership = isOwnership(body.ownership) ? body.ownership : (existing?.ownership ?? 'company')
  // Company-owned gear has no contractor name; switching to company clears it.
  const contractorName = ownership === 'contractor'
    ? (body.contractorName !== undefined ? (S(body.contractorName, 100) || undefined) : existing?.contractorName)
    : undefined

  const equipment: Equipment = {
    id, name,
    truckType: body.truckType !== undefined ? (S(body.truckType, 120) || undefined) : existing?.truckType,
    ownership,
    contractorName,
    notes: body.notes !== undefined ? (S(body.notes, 500) || undefined) : existing?.notes,
    active: body.active !== false && body.active !== 'false',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await saveEquipment(equipment)
  return NextResponse.json({ ok: true, equipment })
})

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'equipment:manage')
  if (who instanceof NextResponse) return who
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteEquipment(id)
  return NextResponse.json({ ok: true })
})
