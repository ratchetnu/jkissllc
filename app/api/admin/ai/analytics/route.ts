import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { computeAiAnalytics } from '../../../../lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/admin/ai/analytics — read-only AI Control Center feed. Gated on
// ai:analytics (admin + manager). Aggregates the AI audit log into usage, cost,
// latency, quality, and per-prompt-version metrics. Never mutates anything.
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  try {
    const analytics = await computeAiAnalytics(2000)
    return NextResponse.json({ ok: true, analytics })
  } catch (e) {
    console.error('[ai/analytics]', e)
    return NextResponse.json({ error: 'Failed to load AI analytics.' }, { status: 500 })
  }
}
