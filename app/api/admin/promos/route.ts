import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { listPromos, getPromo, savePromo, deletePromo, normalizeCode, type PromoCode, type PromoType } from '../../../lib/promo'

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ ok: true, items: await listPromos() })
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(body.code)
  if (!code) return NextResponse.json({ error: 'A code is required.' }, { status: 400 })

  const type: PromoType = body.type === 'fixed' ? 'fixed' : 'percent'
  const value = Math.max(0, parseFloat(String(body.value)) || 0)
  if (value <= 0) return NextResponse.json({ error: 'Enter a discount value greater than 0.' }, { status: 400 })
  if (type === 'percent' && value > 100) return NextResponse.json({ error: 'Percent cannot exceed 100.' }, { status: 400 })

  const existing = await getPromo(code)
  const now = Date.now()
  const promo: PromoCode = {
    code, type, value,
    active: body.active !== false && body.active !== 'false',
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 120) || undefined : existing?.description,
    expiresAt: body.expiresAt ? Number(body.expiresAt) || undefined : (body.expiresAt === null ? undefined : existing?.expiresAt),
    maxUses: body.maxUses ? Math.max(0, parseInt(String(body.maxUses)) || 0) || undefined : (body.maxUses === null ? undefined : existing?.maxUses),
    minSubtotalCents: body.minSubtotal ? Math.max(0, Math.round((parseFloat(String(body.minSubtotal)) || 0) * 100)) || undefined : existing?.minSubtotalCents,
    uses: existing?.uses ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await savePromo(promo)
  return NextResponse.json({ ok: true, promo })
}

export async function DELETE(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const code = normalizeCode(new URL(req.url).searchParams.get('code'))
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })
  await deletePromo(code)
  return NextResponse.json({ ok: true })
}
