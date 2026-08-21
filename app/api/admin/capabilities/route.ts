import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission, getPrincipal } from '../_lib/session'
import { currentTenantId } from '../../../lib/platform/tenancy/context'
import { DEFAULT_TENANT_ID } from '../../../lib/platform/tenancy/types'
import { TenantAccessDeniedError } from '../../../lib/platform/tenancy/membership'
import {
  resolveTenantCapabilities, setCapabilitySelections, CapabilityConfigError,
  type CapabilityPatch,
} from '../../../lib/platform/capabilities/tenant-profile-store'
import { CAPABILITY_REGISTRY } from '../../../lib/platform/capabilities/registry'
import { resolveAllProviderReadiness } from '../../../lib/platform/capabilities/provider-readiness'
import type { CapabilityId } from '../../../lib/platform/capabilities/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

/**
 * The tenant this request acts for. SERVER-RESOLVED from the signed session by
 * `withTenantRoute`; a body or query parameter is never consulted, so a client
 * cannot address another business's capability profile by naming it.
 */
function actingTenant(): string {
  return currentTenantId() ?? DEFAULT_TENANT_ID
}

// GET /api/admin/capabilities — what this business has switched on, and what each
// optional provider still needs. VALUE-FREE: booleans, stable state codes, and
// variable NAMES only.
//
// Gated on `settings:manage` (admin-only) for READ as well as write. The response
// enumerates which integrations a business runs and which variables it is still
// missing — an accurate map of where the deployment is soft — so it is deliberately
// not manager-visible. Managers see the effect through the ordinary refusals
// ("SMS is turned off for this business"), which is what they need to act.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who

  const tenantId = actingTenant()
  const resolved = await resolveTenantCapabilities(tenantId)
  const readiness = resolveAllProviderReadiness({ enabled: resolved.providers, env: process.env })

  return NextResponse.json({
    ok: true,
    tenantId,
    // A record this build could not trust is reported, not silently applied.
    usingDefaults: resolved.fellBackToDefaults,
    warnings: resolved.warnings,
    capabilities: Object.values(resolved.capabilities).map((c) => ({
      id: c.id,
      displayName: c.displayName,
      kind: c.kind,
      provider: c.provider,
      state: c.state,
      code: c.code,
      enabled: c.tenantEnabled,
      configured: c.providerConfigured,
      operational: c.operational,
      selectionSource: c.selectionSource,
      blockedBy: c.blockedBy,
      missingVars: c.missingVars,          // NAMES only
      configurable: CAPABILITY_REGISTRY[c.id].tenantConfigurable,
    })),
    providers: readiness.map((r) => ({
      provider: r.provider, capability: r.capability, label: r.label,
      state: r.state, code: r.code, applicable: r.applicable,
      requiredVars: r.requiredVars, missingVars: r.missingVars, notes: r.notes, detail: r.detail,
    })),
  }, { headers: noStore })
})

// PATCH /api/admin/capabilities — turn capabilities on or off for THIS business.
//
// Every guard lives in the store, not here, so a second caller cannot skip one:
// active membership, `settings:manage`, dependency closure, mandatory capabilities,
// and refusal of anything shaped like a secret in `credentialRef`. This route only
// shapes the request and translates the refusal into a status code.
export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who
  const principal = await getPrincipal(req)
  if (!principal) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore })

  const body = (await req.json().catch(() => ({}))) as { capabilities?: Record<string, unknown> }
  const raw = body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : null
  if (!raw) return NextResponse.json({ error: 'expected { capabilities: { <id>: { selection } } }' }, { status: 400, headers: noStore })

  const patch: CapabilityPatch = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (v.selection !== 'enabled' && v.selection !== 'disabled') continue
    patch[id as CapabilityId] = {
      selection: v.selection,
      credentialRef: typeof v.credentialRef === 'string' ? v.credentialRef : undefined,
      note: typeof v.note === 'string' ? v.note : undefined,
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no valid capability selections supplied' }, { status: 400, headers: noStore })
  }

  try {
    const resolved = await setCapabilitySelections(
      { sub: principal.sub, role: principal.role },
      actingTenant(),
      patch,
    )
    return NextResponse.json({
      ok: true,
      providers: resolved.providers,
      capabilities: Object.values(resolved.capabilities)
        .filter((c) => patch[c.id])
        .map((c) => ({ id: c.id, state: c.state, code: c.code, enabled: c.tenantEnabled, missingVars: c.missingVars })),
    }, { headers: noStore })
  } catch (err) {
    // 409 = "that configuration cannot exist" (the caller can fix the request).
    if (err instanceof CapabilityConfigError) {
      return NextResponse.json({ ok: false, error: err.message, errors: err.errors }, { status: 409, headers: noStore })
    }
    // 403 = "not your business, or not your permission". The message is deliberately
    // generic: it must never confirm that another tenant exists.
    if (err instanceof TenantAccessDeniedError) {
      return NextResponse.json({ ok: false, error: 'forbidden', code: err.code }, { status: 403, headers: noStore })
    }
    throw err
  }
})
