import { NextRequest, NextResponse } from 'next/server'
import { requireStaffSession } from '../_lib/session'
import { listApprovals } from '../../../lib/approvals-store'
import { decideApproval } from '../../../lib/intake-workflow'
import type { ApprovalRequest } from '../../../lib/platform/approvals/types'

// Owner-facing approval queue for the governed intake workflow. Admin/manager only
// (requireStaffSession); scoped to the caller's tenant.
//   GET  ?status=pending|all → list approvals
//   POST { approvalId, decision:'approve'|'reject', reason? } → decide one

export async function GET(req: NextRequest) {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const statusParam = req.nextUrl.searchParams.get('status') ?? 'pending'
  const status = statusParam === 'all' ? undefined : (statusParam as ApprovalRequest['status'])
  const items = await listApprovals(who.tenantId, { status, limit: 100 })
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const body = (await req.json().catch(() => ({}))) as { approvalId?: string; decision?: string; reason?: string }
  if (!body.approvalId || (body.decision !== 'approve' && body.decision !== 'reject')) {
    return NextResponse.json({ error: 'approvalId and decision (approve|reject) are required' }, { status: 400 })
  }
  const res = await decideApproval({
    approvalId: body.approvalId,
    decision: body.decision,
    decidedBy: who.sub,
    decidedByRole: who.role,
    callerTenantId: who.tenantId,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  })
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status })
  return NextResponse.json({ ok: true, approval: res.approval })
}
