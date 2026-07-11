import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { hasPrompt } from '../../../../lib/ai/prompts'
import { getAb } from '../../../../lib/ai/prompt-store'
import { listAiCalls } from '../../../../lib/ai/telemetry'
import { computeAbAnalysis } from '../../../../lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/admin/ai/ab?taskId=ops.command — statistical comparison of a prompt A/B
// test: control vs variant success rate + quality + feedback, with a two-proportion
// z-test and a significance verdict. Read-only (ai:analytics).
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  const taskId = req.nextUrl.searchParams.get('taskId') || ''
  if (!taskId || !hasPrompt(taskId)) return NextResponse.json({ error: 'unknown taskId' }, { status: 400 })
  try {
    const [ab, records] = await Promise.all([getAb(taskId), listAiCalls(2000)])
    const analysis = computeAbAnalysis(taskId, records)
    return NextResponse.json({ ok: true, taskId, config: ab, analysis })
  } catch (e) {
    console.error('[ai/ab]', e)
    return NextResponse.json({ error: 'Failed to load A/B analysis.' }, { status: 500 })
  }
}
