import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../_lib/session'
import { getBlackout, setBlackout, getCapacity, setCapacity, getDepositCents, setDepositCents } from '../../../lib/availability'

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const [blackout, capacity, depositCents] = await Promise.all([getBlackout(), getCapacity(), getDepositCents()])
  return NextResponse.json({ ok: true, blackout, capacity, depositCents })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  if (Array.isArray(body.blackout)) await setBlackout(body.blackout.map((x: unknown) => String(x)))
  if (body.capacity !== undefined) await setCapacity(parseInt(String(body.capacity), 10) || 1)
  if (body.depositDollars !== undefined) await setDepositCents(Math.round((parseFloat(String(body.depositDollars)) || 0) * 100))
  const [blackout, capacity, depositCents] = await Promise.all([getBlackout(), getCapacity(), getDepositCents()])
  return NextResponse.json({ ok: true, blackout, capacity, depositCents })
})
