import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { setAiFeedback } from '../../../../lib/ai/telemetry'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/ai/feedback — optional helpful / not-helpful rating on a prior AI
// response, attached to its telemetry record. Same ai:use gate; tenant-scoped so a
// caller can only rate calls made within their own tenant.
//
// WAVE 5 (tenant-isolation audit), defect TEN-3. This passed `tenantId()` — the
// DEPLOYMENT-wide constant — as the ownership boundary. Because ai/service.ts stamps
// every record with that same constant, the guard `rec.tenantId !== tenantId`
// compared a value against itself and could never deny anyone: under pooled tenancy
// any authenticated caller holding `ai:use` could write feedback onto ANOTHER
// tenant's AI record. The boundary is now the CALLER's own tenant, taken from the
// signed session (`who.tenantId`) and never from the body or a header, and the route
// runs inside `withTenantRoute` so downstream reads/writes inherit the same scope.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:use')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const callId = typeof body.callId === 'string' ? body.callId : ''
  if (!callId) return NextResponse.json({ error: 'callId required' }, { status: 400 })
  if (typeof body.helpful !== 'boolean') return NextResponse.json({ error: 'helpful must be a boolean' }, { status: 400 })

  const ok = await setAiFeedback(callId, body.helpful, who.tenantId)
  // 404 (not 403) on a foreign record: a caller must not be able to distinguish
  // "exists but belongs to another tenant" from "does not exist".
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
})
