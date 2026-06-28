import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { listStaff, saveStaff, deleteStaff, type Staff } from '../../../lib/staff'

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ ok: true, items: await listStaff() })
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 })

  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
  const now = Date.now()
  const existingRaw = body.id ? (await listStaff()).find(s => s.id === body.id) : undefined
  const staff: Staff = {
    id, name,
    phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) || undefined : existingRaw?.phone,
    role: typeof body.role === 'string' ? body.role.trim().slice(0, 60) || undefined : existingRaw?.role,
    active: body.active !== false && body.active !== 'false',
    createdAt: existingRaw?.createdAt ?? now,
    updatedAt: now,
  }
  await saveStaff(staff)
  return NextResponse.json({ ok: true, staff })
}

export async function DELETE(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteStaff(id)
  return NextResponse.json({ ok: true })
}
