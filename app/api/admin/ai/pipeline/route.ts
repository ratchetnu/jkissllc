import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { getPipelineAggregate, getTracesForBooking } from '../../../../lib/observability/pipeline-read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/admin/ai/pipeline — read-only per-stage latency feed for the AI pipeline
// observability dashboard. Gated on ai:analytics (admin + manager) AND the
// AI_PIPELINE_OBSERVABILITY_ENABLED flag. Pure aggregation over persisted stage traces —
// makes ZERO AI calls and mutates nothing. `?booking=<token>` returns that booking's
// traces instead of the fleet aggregate.
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who

  if (!isEnabled('AI_PIPELINE_OBSERVABILITY_ENABLED')) {
    return NextResponse.json({ ok: true, enabled: false, reason: 'Enable AI_PIPELINE_OBSERVABILITY_ENABLED to record and view pipeline latency.' })
  }

  try {
    const booking = req.nextUrl.searchParams.get('booking')?.trim()
    if (booking) {
      const traces = await getTracesForBooking(booking)
      return NextResponse.json({ ok: true, enabled: true, booking, traces })
    }
    const limitRaw = Number(req.nextUrl.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(5000, limitRaw) : 2000
    const aggregate = await getPipelineAggregate(limit)
    return NextResponse.json({ ok: true, enabled: true, generatedAt: Date.now(), ...aggregate })
  } catch (e) {
    console.error('[ai/pipeline]', e)
    return NextResponse.json({ error: 'Failed to load pipeline observability.' }, { status: 500 })
  }
}
