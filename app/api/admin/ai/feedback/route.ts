import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { setAiFeedback } from '../../../../lib/ai/telemetry'
import { tenantId } from '../../../../lib/tenant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/ai/feedback — optional helpful / not-helpful rating on a prior AI
// response, attached to its telemetry record. Same ai:use gate; tenant-scoped so a
// caller can only rate calls made within their own tenant.
export async function POST(req: NextRequest) {
  const who = await requirePermission(req, 'ai:use')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const callId = typeof body.callId === 'string' ? body.callId : ''
  if (!callId) return NextResponse.json({ error: 'callId required' }, { status: 400 })
  if (typeof body.helpful !== 'boolean') return NextResponse.json({ error: 'helpful must be a boolean' }, { status: 400 })

  const ok = await setAiFeedback(callId, body.helpful, tenantId())
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
