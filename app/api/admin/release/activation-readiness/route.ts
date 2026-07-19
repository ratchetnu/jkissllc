import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { listBusinesses } from '../../../../lib/platform/updates/store'
import { isTestOnlyBusiness } from '../../../../lib/platform/release/promotion-guards'
import { readRollbackTarget } from '../../../../lib/platform/release/production-deployment'
import { evaluateActivationReadiness } from '../../../../lib/platform/release/activation-readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store, max-age=0' }

// Owner-only and READ-ONLY. Returns boolean configuration evidence and derived blockers;
// never returns an env value, credential, provider response body, or mutation control.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  const businesses = await listBusinesses()
  const eligible = businesses.filter((b) => b.status === 'active' && !isTestOnlyBusiness(b))
  const rollbackTargets = Object.fromEntries(await Promise.all(eligible.map(async (business) => [
    business.id,
    await readRollbackTarget(business),
  ])))

  const readiness = evaluateActivationReadiness({
    now: Date.now(),
    environment: process.env.VERCEL_ENV,
    configured: {
      githubApp: !!process.env.GITHUB_APP_ID && !!process.env.GITHUB_APP_PRIVATE_KEY,
      vercel: !!process.env.VERCEL_TOKEN && !!process.env.VERCEL_PROJECT_ID,
      callbackSecret: !!process.env.OPERION_CALLBACK_SECRET,
    },
    flags: {
      automation: isEnabled('OPERION_AUTOMATION_ENABLED'),
      githubActions: isEnabled('OPERION_GITHUB_ACTIONS_ENABLED'),
      previewAutomation: isEnabled('OPERION_PREVIEW_AUTOMATION_ENABLED'),
      approvalGate: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
      productionPromotion: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
      aiAdaptation: isEnabled('OPERION_AI_ADAPTATION_ENABLED'),
      automaticRollback: isEnabled('OPERION_AUTOMATIC_ROLLBACK_ENABLED'),
    },
    businesses,
    rollbackTargets,
  })

  return NextResponse.json({ ok: true, readiness }, { headers: noStore })
})
