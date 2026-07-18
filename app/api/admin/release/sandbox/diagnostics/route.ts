import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../_lib/session'
import { isEnabled } from '../../../../../lib/platform/flags'
import { kvHost } from '../../../../../lib/redis'
import { environmentRefusals, guardsPass } from '../../../../../lib/platform/sandbox/guards'
import { diagnose } from '../../../../../lib/platform/sandbox/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release/sandbox/diagnostics
// Owner-only, PREVIEW-ONLY, flag-gated (OPERION_SANDBOX_REPAIR_ENABLED). Read-only:
// reports whether the operion-sandbox records exist in THIS deployment's KV store
// and whether the Businesses query returns the sandbox. Returns 404 in Production /
// when the flag is off / when the KV target looks like the production store — the
// endpoint is invisible there. Never returns URLs, tokens, or connection strings.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  const refusals = environmentRefusals({
    vercelEnv: process.env.VERCEL_ENV,
    requestHost: req.headers.get('host') ?? undefined,
    kvStoreHost: kvHost(),
    repairFlagEnabled: isEnabled('OPERION_SANDBOX_REPAIR_ENABLED'),
  })
  // Hide the endpoint entirely outside a flagged Preview.
  if (!guardsPass(refusals)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const diagnostics = await diagnose(process.env.VERCEL_ENV ?? 'unknown')
  return NextResponse.json({ ok: true, diagnostics })
})
