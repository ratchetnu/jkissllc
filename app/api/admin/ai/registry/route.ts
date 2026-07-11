import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { featureCatalog } from '../../../../lib/ai/registry'
import { computeAiAnalytics } from '../../../../lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/admin/ai/registry — the AI Feature Registry joined with live metrics: each
// documented capability (model, prompt version, owner, access, status) plus its
// in-window usage, cost, success rate, and quality from telemetry.
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  try {
    const catalog = featureCatalog()
    const analytics = await computeAiAnalytics(2000)
    const byFeature = new Map(analytics.features.map(f => [f.feature, f]))
    const features = catalog.map(c => {
      const m = byFeature.get(c.taskId)
      return {
        ...c,
        metrics: m
          ? { calls: m.calls, successRate: m.successRate, avgLatencyMs: m.avgLatencyMs, p95LatencyMs: m.p95LatencyMs, estCostUsd: m.estCostUsd, avgQuality: m.avgQuality, helpful: m.helpful, notHelpful: m.notHelpful }
          : { calls: 0, successRate: 0, avgLatencyMs: 0, p95LatencyMs: 0, estCostUsd: 0, avgQuality: 0, helpful: 0, notHelpful: 0 },
      }
    })
    return NextResponse.json({ ok: true, features, generatedAt: analytics.generatedAt })
  } catch (e) {
    console.error('[ai/registry]', e)
    return NextResponse.json({ error: 'Failed to load feature registry.' }, { status: 500 })
  }
}
