import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { runAiTask } from '../../../../lib/ai/service'

export const maxDuration = 30

// POST /api/admin/ai/review-reply — drafts a public reply to a customer review.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:use')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const rating = Math.max(1, Math.min(5, parseInt(String(body.rating)) || 5))
  const author = typeof body.author === 'string' ? body.author.slice(0, 80) : 'the customer'
  const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : ''

  const result = await runAiTask({
    taskId: 'ops.reviewReply', feature: 'ops.reviewReply', requiredPermission: 'ai:use',
    principal: { sub: who.sub, role: who.role },
    vars: { author, rating: String(rating), text },
    maxOutputTokens: 300, temperature: 0.6, requestChars: text.length,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, reply: result.text, callId: result.callId })
})
