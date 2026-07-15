import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import {
  getShipment, saveShipment, deleteShipment, listShipments,
  normalizeBol, type Shipment, type ShipmentStatus,
} from '../../../lib/shipments'

const VALID_STATUSES: ShipmentStatus[] = ['created', 'dispatched', 'out-for-delivery', 'delivered']

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  try {
    const items = await listShipments(200)
    return NextResponse.json({ items })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') {
      return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    }
    console.error('[admin/shipments GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const body = await req.json()
  const norm = normalizeBol(body.bol ?? '')
  if (!norm) return NextResponse.json({ error: 'BOL is required.' }, { status: 400 })

  const status = (VALID_STATUSES as string[]).includes(body.status) ? (body.status as ShipmentStatus) : 'created'
  const now = Date.now()

  const existing = await getShipment(norm)

  // Customer name is required: it is the second factor a customer must enter
  // on /track to view this shipment, so a shipment with no name on file can
  // never be tracked (and a BOL alone must not unlock it).
  const customerName = (
    typeof body.customerName === 'string' ? body.customerName.trim().slice(0, 200) : existing?.customerName ?? ''
  ).trim()
  if (!customerName) {
    return NextResponse.json(
      { error: 'Customer or company name is required — customers use it to track the shipment.' },
      { status: 400 },
    )
  }

  const shipment: Shipment = {
    bol: norm,
    status,
    customerName,
    pickupCity:   typeof body.pickupCity   === 'string' ? body.pickupCity.slice(0, 100) : existing?.pickupCity,
    deliveryCity: typeof body.deliveryCity === 'string' ? body.deliveryCity.slice(0, 100) : existing?.deliveryCity,
    notes:        typeof body.notes        === 'string' ? body.notes.slice(0, 500) : existing?.notes,
    createdAt:    existing?.createdAt ?? now,
    updatedAt:    now,
    dispatchedAt: existing?.dispatchedAt ?? (status === 'dispatched' || status === 'out-for-delivery' || status === 'delivered' ? now : undefined),
    deliveredAt:  existing?.deliveredAt  ?? (status === 'delivered' ? now : undefined),
  }
  // If newly entering a stage, stamp the time even if a later stage was set previously inconsistently
  if (status === 'dispatched' && !shipment.dispatchedAt) shipment.dispatchedAt = now
  if (status === 'delivered'  && !shipment.deliveredAt)  shipment.deliveredAt = now

  try {
    await saveShipment(shipment)
    return NextResponse.json({ ok: true, shipment })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'save failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') {
      return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    }
    console.error('[admin/shipments POST]', err)
    return NextResponse.json({ error: 'save failed' }, { status: 500 })
  }
})

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const { searchParams } = new URL(req.url)
  const bol = searchParams.get('bol')
  if (!bol) return NextResponse.json({ error: 'bol param required' }, { status: 400 })
  try {
    await deleteShipment(bol)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[admin/shipments DELETE]', err)
    return NextResponse.json({ error: 'delete failed' }, { status: 500 })
  }
})
