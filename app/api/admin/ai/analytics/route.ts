import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { computeAiAnalytics } from '../../../../lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/admin/ai/analytics — read-only AI Control Center feed. Gated on
// ai:analytics (admin + manager) AND wrapped in withTenantRoute so the AI-audit reads
// run inside the caller's resolved tenant scope (this was the one analytics route that
// skipped the tenant wrapper — a latent cross-tenant read when TENANCY_ENABLED=true;
// no-op while it's off, so the response is unchanged today). Never mutates anything.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  try {
    const analytics = await computeAiAnalytics(2000)
    // Spread the analytics fields onto the envelope (matching the registry/prompts
    // routes): the Control Center page reads a.totals / a.today / a.generatedAt off
    // the top level, so nesting under `analytics` left every field undefined and
    // crashed the page on render.
    return NextResponse.json({ ok: true, ...analytics })
  } catch (e) {
    console.error('[ai/analytics]', e)
    return NextResponse.json({ error: 'Failed to load AI analytics.' }, { status: 500 })
  }
})
