import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { listBusinesses, getBusiness, saveBusiness, deleteBusiness, bizKey, type Business } from '../../../lib/businesses'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ items: await listBusinesses() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
}

// Upsert a business's editable details, keyed by its (normalized) name.
export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const name = S(b.name, 200)
  if (!name) return NextResponse.json({ error: 'Business name is required.' }, { status: 400 })
  const key = bizKey(name)
  const existing = await getBusiness(key)
  const now = Date.now()
  const rec: Business = {
    key, name,
    contactName: S(b.contactName, 160) || undefined,
    contactPhone: S(b.contactPhone, 40) || undefined,
    contactEmail: S(b.contactEmail, 200) || undefined,
    address: S(b.address, 300) || undefined,
    notes: S(b.notes, 1000) || undefined,
    requiresHelper: typeof b.requiresHelper === 'boolean' ? b.requiresHelper : existing?.requiresHelper,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await saveBusiness(rec)
  return NextResponse.json({ ok: true, business: rec })
}

export async function DELETE(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const key = new URL(req.url).searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
  await deleteBusiness(key)
  return NextResponse.json({ ok: true })
}
