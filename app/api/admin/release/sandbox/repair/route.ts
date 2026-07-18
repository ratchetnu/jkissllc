import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../_lib/session'
import { isEnabled } from '../../../../../lib/platform/flags'
import { kvHost } from '../../../../../lib/redis'
import { repairRefusals, guardsPass } from '../../../../../lib/platform/sandbox/guards'
import { repair } from '../../../../../lib/platform/sandbox/service'
import { SANDBOX_SLUG } from '../../../../../lib/platform/sandbox/records'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/release/sandbox/repair
// Owner-only, PREVIEW-ONLY, flag-gated. Writes ONLY the operion-sandbox keys into
// THIS deployment's KV, overwriting only missing/malformed records and preserving
// valid ones. Requires body { slug: 'operion-sandbox', confirm: 'operion-sandbox' }.
// Refuses in Production, on a production domain, when the KV target is a known
// production store, on a wrong slug, or without the explicit confirmation. Proves
// the live-business records are byte-identical before/after. Never returns secrets.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  let body: { slug?: string; confirm?: string } = {}
  try { body = (await req.json()) as typeof body } catch { /* empty body → missing_confirmation */ }

  const refusals = repairRefusals({
    vercelEnv: process.env.VERCEL_ENV,
    requestHost: req.headers.get('host') ?? undefined,
    kvStoreHost: kvHost(),
    repairFlagEnabled: isEnabled('OPERION_SANDBOX_REPAIR_ENABLED'),
    slug: body.slug,
    confirm: body.confirm,
  })
  if (!guardsPass(refusals)) {
    // 404 when the endpoint should be invisible (prod/flag/store), 400 for a bad request.
    const invisible = refusals.some((r) => r === 'vercel_env_production' || r === 'not_preview' || r === 'flag_disabled' || r === 'production_domain' || r === 'production_kv_store')
    return NextResponse.json({ ok: false, refusals }, { status: invisible ? 404 : 400 })
  }

  const result = await repair(process.env.VERCEL_ENV ?? 'unknown', Date.now())
  // Belt-and-suspenders: the Businesses API is force-dynamic (no cache), but revalidate
  // the Release Center path so any cached render is refreshed.
  try { revalidatePath('/admin/operations/release') } catch { /* no-op outside request cache */ }

  return NextResponse.json({ ok: true, slug: SANDBOX_SLUG, ...result })
})
