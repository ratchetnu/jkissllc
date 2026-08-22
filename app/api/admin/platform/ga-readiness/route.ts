import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { listTenants } from '../../../../lib/platform/tenancy/tenant-registry'
import { listUserIdsForTenant } from '../../../../lib/platform/tenancy/membership'
import { listMigrationMarkers, MIGRATION_IDS, getMigrationMarker } from '../../../../lib/platform/tenancy/migration-markers'
import { getCapabilityProfile } from '../../../../lib/platform/capabilities/tenant-profile-store'
import { buildGaReadiness } from '../../../../lib/platform/tenancy/ga-readiness'
import { listJobs } from '../../../../lib/platform/automation/store'
import { listDeployments } from '../../../../lib/platform/updates/store'
import { allCapabilities } from '../../../../lib/platform/capabilities/registry'
import { GUARDED_ENTRY_POINTS } from '../../../../lib/platform/capabilities/guard'
import type { MigrationMarker } from '../../../../lib/platform/tenancy/migration-markers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }
const uniq = (xs: string[]) => [...new Set(xs)].sort()

// GET /api/admin/platform/ga-readiness — owner-only, READ-ONLY.
//
// The machine-readable answer to "is this actually multi-tenant yet?", reported as
// thirteen INDEPENDENT dimensions. It writes nothing, flips nothing, and runs no
// migration; `tenancyEnablementSafe` is a report, not a switch.
//
// The point of separating the dimensions is that "we shipped an update to
// Supercharged" and "tenant data is isolated" are unrelated claims, and a single
// green light would let the first quietly stand in for the second.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  const tenants = await listTenants().catch(() => [])
  const activeTenantIds = tenants.filter((t) => t.status === 'active').map((t) => t.id)

  const tenantsWithMemberships: string[] = []
  const tenantsWithCapabilityProfiles: string[] = []
  for (const id of activeTenantIds) {
    const users = await listUserIdsForTenant(id).catch(() => [])
    if (users.length > 0) tenantsWithMemberships.push(id)
    // "Has an explicit stored profile" — not "resolves to something". A default is
    // not a decision, and counting it as one would inflate this dimension.
    const profile = await getCapabilityProfile(id).catch(() => null)
    if (profile && Object.keys(profile.profile.entries).length > 0) tenantsWithCapabilityProfiles.push(id)
  }

  const markers: MigrationMarker[] = []
  for (const m of await listMigrationMarkers().catch(() => [])) markers.push(m)
  for (const id of activeTenantIds) {
    for (const mid of MIGRATION_IDS) {
      const scoped = await getMigrationMarker(mid, id).catch(() => null)
      if (scoped) markers.push(scoped)
    }
  }

  const [jobs, deployments] = await Promise.all([listJobs().catch(() => []), listDeployments().catch(() => [])])

  const report = buildGaReadiness({
    now: Date.now(),
    flags: {
      tenancyEnabled: isEnabled('TENANCY_ENABLED'),
      darkLaunch: isEnabled('TENANCY_DARK_LAUNCH'),
      dualWrite: isEnabled('TENANCY_DUAL_WRITE'),
    },
    activeTenantIds,
    tenantsWithMemberships,
    tenantsWithCapabilityProfiles,
    migrationMarkers: markers,
    // Shadow-read comparisons are reported to telemetry, not accumulated into a
    // durable counter, so this deployment cannot yet evidence a clean run. Reported
    // as unobserved rather than assumed clean.
    darkLaunchObservations: null,
    // No certification result is recorded in a deployment today — the audit is a
    // repo-side script. Reported as unrecorded rather than assumed clean; assuming
    // would be exactly the kind of unearned green this endpoint exists to prevent.
    certification: null,
    delivery: {
      previewVerifiedTargets: uniq(jobs.filter((j) => j.status === 'awaiting_owner_review' || j.status === 'completed').map((j) => j.businessId)),
      productionVerifiedTargets: uniq(deployments.filter((d) => d.verificationStatus === 'passed' && d.environment === 'production').map((d) => d.businessId)),
      rollbackCapturedTargets: uniq(jobs.filter((j) => !!j.rollbackTargetDeploymentId && !!j.rollbackTargetCommit).map((j) => j.businessId)),
      targetsReportingCapabilityEvidence: uniq(jobs.filter((j) => !!j.targetEvidence).map((j) => j.businessId)),
    },
    optionalIntegrations: {
      adapterCapabilities: allCapabilities().filter((c) => c.provider).map((c) => c.id),
      guardedEntryPoints: [...GUARDED_ENTRY_POINTS],
    },
  })

  return NextResponse.json(report, { headers: noStore })
})
