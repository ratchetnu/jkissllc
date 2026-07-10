import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../_lib/session'
import { listAll, decideCorrection } from '../../../lib/pay-corrections'
import { roleLabel } from '../../../lib/rbac'

// Pay-correction review queue. Viewing needs pay:view:all; deciding needs
// pay:approve — both admin-only (managers submit adjustments but don't approve pay).
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'pay:view:all')
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, corrections: await listAll() })
}

export async function PATCH(req: NextRequest) {
  const who = await requirePermission(req, 'pay:approve')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const id = String(body?.id ?? '')
  const action = body?.action
  if (!id || (action !== 'approve' && action !== 'deny')) {
    return NextResponse.json({ ok: false, error: 'action must be approve or deny.' }, { status: 400 })
  }
  const by = who.sub === 'owner' ? 'Owner' : `${roleLabel[who.role]} (${who.sub})`
  const correction = await decideCorrection(id, action === 'approve', by, typeof body?.note === 'string' ? body.note : undefined)
  if (!correction) return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })
  return NextResponse.json({ ok: true, correction })
}
