import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { currentTenantId } from '../../../lib/platform/tenancy/context'
import { DEFAULT_TENANT_ID } from '../../../lib/platform/tenancy/types'
import { runHealthChecks, pingKv } from '../../../lib/health'
import { resolveTenantCapabilities } from '../../../lib/platform/capabilities/tenant-profile-store'
import { resolveAllProviderReadiness } from '../../../lib/platform/capabilities/provider-readiness'
import { platformHealth, capabilityReadiness, providerHealth } from '../../../lib/platform/readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

// GET /api/admin/readiness — the three standing readiness questions, answered
// SEPARATELY. (The fourth, release compatibility, is per update × target and lives
// on /api/admin/platform/guided, because it does not exist without a release.)
//
//   platform    Is the application running?           — critical dependencies only
//   capability  Can each optional feature operate?    — per capability
//   provider    Is each external provider usable?     — per provider
//
// Answering them in one response but never in one FIELD is the point. They were a
// single word — "healthy" — and that is how a missing Stripe key came to read as a
// sick platform, and from there as a reason to withhold an update from a business
// that had simply chosen not to take cards.
//
// Value-free: booleans, stable state codes, and variable NAMES. Admin-only, because
// the response is an accurate map of where this deployment is soft.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who

  const tenantId = currentTenantId() ?? DEFAULT_TENANT_ID
  const resolved = await resolveTenantCapabilities(tenantId)

  // Health is asked with this tenant's selections, so a provider it does not use
  // cannot contribute a degraded component in the first place.
  const report = await runHealthChecks({
    pingKv,
    env: process.env,
    providers: async () => resolved.providers,
  })

  return NextResponse.json({
    ok: true,
    tenantId,
    platform: platformHealth(report.components, report.status),
    capability: capabilityReadiness(resolved.capabilities),
    provider: providerHealth(resolveAllProviderReadiness({ enabled: resolved.providers, env: process.env })),
    // Surfaced rather than hidden: while false, provider adapters are still being
    // inferred from which credentials exist, and somebody has to close that.
    capabilityProfileInitialized: resolved.initialized,
    warnings: resolved.warnings,
  }, { headers: noStore })
})
