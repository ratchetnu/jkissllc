import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { getShadowKillOverride, setShadowKillOverride } from '../../../lib/estimation/shadow-store'
import { shadowBudgetFromEnv } from '../../../lib/estimation/shadow-budget'
import { recordPlatformAudit } from '../../../lib/platform/updates/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The emergency V2-inference kill switch — a runtime brake the owner can flip WITHOUT a
// redeploy. Platform-owner only + SHADOW_ANALYTICS_ENABLED. Toggling it halts ONLY new V2
// inference; V1 (customer-facing), analytics, ground-truth editing, and stored results are
// untouched because none of them call the model. Every toggle is audited.
//
// GET  → current effective state (env default + runtime override)
// POST → set the runtime override { on: boolean }
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })
  const envKilled = shadowBudgetFromEnv().killed
  const override = await getShadowKillOverride()
  return NextResponse.json({ enabled: true, envKilled, override, effective: envKilled || override === true })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ error: 'analytics disabled' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  if (typeof body?.on !== 'boolean') return NextResponse.json({ error: 'expected { on: boolean }' }, { status: 400 })

  const actor = (await getPrincipal(req))?.sub || 'owner'
  await setShadowKillOverride(body.on)
  await recordPlatformAudit({
    actor, actorType: 'owner', source: 'shadow-kill-switch', action: 'status.manual_correction',
    summary: body.on ? 'ENGAGED the V2 shadow inference kill switch — new evaluations halted.' : 'Released the V2 shadow inference kill switch — evaluations may resume.',
    meta: { killSwitch: body.on },
  })
  const envKilled = shadowBudgetFromEnv().killed
  return NextResponse.json({ ok: true, override: body.on, effective: envKilled || body.on })
})
