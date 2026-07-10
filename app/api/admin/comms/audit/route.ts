import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { listAudit } from '../../../../lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The central audit log view (request Part 11). Admin-gated (audit:view).
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'audit:view')
  if (who instanceof NextResponse) return who
  const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 200))
  const entries = await listAudit(limit)
  return NextResponse.json({ entries })
}
