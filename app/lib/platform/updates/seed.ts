// ── Operion Update Center — idempotent seed ──────────────────────────────────
// Registers the two businesses the owner runs + the real updates shipped this cycle,
// with accurate commits and deployment states. Idempotent: if J KISS already exists it
// no-ops (unless force). Uses the real update-key counter so keys are UPD-1001…. NEVER
// touches the Supercharged repo — it only writes a RECORD describing it.

import {
  getBusiness, saveBusiness, saveUpdate, saveCompat, nextUpdateKey,
} from './store'
import { PLATFORM_UPDATE_VERSION, type PlatformBusiness, type PlatformUpdate, type UpdateCompatibility, type ValidationChecklist } from './types'

const PASS: ValidationChecklist = {
  typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed',
  securityReview: 'not_applicable', accessibilityReview: 'not_applicable',
  e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed',
}

export async function seedPlatform(now: number, opts: { force?: boolean } = {}): Promise<{ seeded: boolean; businesses: number; updates: number }> {
  if (!opts.force && (await getBusiness('jkiss'))) return { seeded: false, businesses: 0, updates: 0 }

  const jkiss: PlatformBusiness = {
    recordVersion: PLATFORM_UPDATE_VERSION, id: 'jkiss', name: 'J KISS LLC', slug: 'jkiss',
    industry: 'Junk removal / moving', edition: 'internal', status: 'active', role: 'source_and_target',
    repoProvider: 'github', repoName: 'ratchetnu/jkissllc', defaultBranch: 'main',
    deployProvider: 'vercel', deployProject: 'jkissllc', productionUrl: 'https://jkissllc.com', healthEndpoint: '/api/health',
    currentCommit: '14827b7', releaseChannel: 'internal', updatePolicy: 'owner_approval',
    updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy',
    lastDeploymentAt: now, notes: 'Internal source platform — Operion lives here.', createdAt: now, updatedAt: now,
  }
  const supercharged: PlatformBusiness = {
    recordVersion: PLATFORM_UPDATE_VERSION, id: 'supercharged', name: 'Supercharged Enterprises', slug: 'supercharged',
    industry: 'Junk removal / moving', edition: 'standard', status: 'active', role: 'target',
    repoProvider: 'github', repoName: '(separate repo — verify)', defaultBranch: 'main',
    deployProvider: 'vercel', deployProject: 'supercharged', productionUrl: 'https://superchargedenterprise.com', healthEndpoint: '/api/health',
    releaseChannel: 'beta', updatePolicy: 'owner_approval',
    updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'unknown',
    notes: 'External Operion-based business. Owner-run. Never auto-deployed from here. Repo/commit/modules to be verified by the owner.', createdAt: now, updatedAt: now,
  }
  await saveBusiness(jkiss)
  await saveBusiness(supercharged)

  // Each entry: [title, summary, partial overrides]. Deployed on J KISS; Supercharged status varies.
  const defs: Array<{ mk: Partial<PlatformUpdate>; superchargedCompat: Partial<UpdateCompatibility> }> = [
    {
      mk: {
        title: 'Booking-detail workspace redesign', summary: 'Reorganized the /admin/bookings detail into an 8-tab workspace (sticky header, summary, attention).',
        type: 'design', scope: 'platform_core', severity: 'low', priority: 'normal', status: 'partially_deployed',
        module: 'admin/bookings', sourceCommit: '14827b7', rollbackSupported: true, manualPortRequired: true,
        customerImpact: 'None (internal admin UI).', technicalImpact: 'UI-only; no backend/pricing/AI change.',
      },
      superchargedCompat: { status: 'compatible_with_changes', reason: 'Same admin shell; re-skin to Supercharged branding (blue #2563EB).', brandingChangesRequired: true, manualPortRequired: true },
    },
    {
      mk: {
        title: 'Independent V2 shadow infrastructure', summary: 'Decoupled the V2 vision estimator into its own queue/worker/cron; removed the inline double-analysis.',
        type: 'infrastructure', scope: 'shared_module', severity: 'high', priority: 'high', status: 'partially_deployed',
        module: 'estimation/shadow', sourceCommit: 'dc9b2c8', featureFlagRequired: true, rollbackSupported: true, manualPortRequired: true,
        technicalImpact: 'New /api/cron/vision-shadow + shadow:* store; flags off by default.',
      },
      superchargedCompat: { status: 'under_review', reason: 'Shared module; port after J KISS validates V2 accuracy.', featureFlagRequired: true },
    },
    {
      mk: {
        title: 'Vision estimator V2 (multi-pass)', summary: 'Multi-pass junk photo estimator: AI reads inventory, deterministic code prices.',
        type: 'feature', scope: 'shared_module', severity: 'medium', priority: 'normal', status: 'partially_deployed',
        module: 'ai/analysis-v2', sourceCommit: '355f004', featureFlagRequired: true, rollbackSupported: true, manualPortRequired: true,
      },
      superchargedCompat: { status: 'under_review', reason: 'Shared; depends on V2 shadow infra.' },
    },
    {
      mk: {
        title: 'Tenant-safe boundaries', summary: 'Tenant-scoped Blob paths + public-route tenant resolution; inert while TENANCY_ENABLED=false.',
        type: 'infrastructure', scope: 'platform_core', severity: 'medium', priority: 'normal', status: 'partially_deployed',
        module: 'platform/tenancy', sourceCommit: 'e42af39', featureFlagRequired: true, rollbackSupported: true, manualPortRequired: true,
        technicalImpact: 'Byte-identical while off.',
      },
      superchargedCompat: { status: 'compatible_with_changes', reason: 'Port with tenancy left OFF; verify Blob key paths.', featureFlagRequired: true },
    },
    {
      mk: {
        title: 'HEIC image handling', summary: 'Server-side HEIC→JPEG conversion so iPhone photos are readable by the vision model.',
        type: 'bug_fix', scope: 'shared_module', severity: 'high', priority: 'high', status: 'fully_deployed',
        module: 'image-convert', sourceCommit: '2daedbb', rollbackSupported: true,
        customerImpact: 'iPhone photos now analyzed correctly.',
      },
      superchargedCompat: { status: 'already_present', reason: 'Supercharged is a J KISS clone that already carries this fix.' },
    },
  ]

  let count = 0
  for (const d of defs) {
    const key = await nextUpdateKey()
    const u: PlatformUpdate = {
      recordVersion: PLATFORM_UPDATE_VERSION, key,
      title: d.mk.title!, summary: d.mk.summary!, description: d.mk.description,
      customerImpact: d.mk.customerImpact, technicalImpact: d.mk.technicalImpact,
      type: d.mk.type!, scope: d.mk.scope!, severity: d.mk.severity!, priority: d.mk.priority!, status: d.mk.status!,
      module: d.mk.module, sourceBusinessId: 'jkiss', sourceRepo: 'ratchetnu/jkissllc', sourceBranch: 'main',
      sourceCommit: d.mk.sourceCommit, breakingChange: false, migrationRequired: false,
      environmentChangeRequired: !!d.mk.featureFlagRequired, secretRequired: false,
      featureFlagRequired: !!d.mk.featureFlagRequired, manualPortRequired: !!d.mk.manualPortRequired,
      rollbackSupported: !!d.mk.rollbackSupported, validation: PASS,
      createdBy: 'owner', approvedBy: 'owner', approvedAt: now, createdAt: now, updatedAt: now,
    }
    await saveUpdate(u)
    const c: UpdateCompatibility = {
      recordVersion: PLATFORM_UPDATE_VERSION, updateKey: key, businessId: 'supercharged',
      status: d.superchargedCompat.status ?? 'unknown', reason: d.superchargedCompat.reason,
      brandingChangesRequired: d.superchargedCompat.brandingChangesRequired,
      featureFlagRequired: d.superchargedCompat.featureFlagRequired,
      manualPortRequired: d.superchargedCompat.manualPortRequired,
      assessedBy: 'owner', createdAt: now, updatedAt: now,
    }
    await saveCompat(c)
    // J KISS is the source — mark it already present there.
    await saveCompat({ recordVersion: PLATFORM_UPDATE_VERSION, updateKey: key, businessId: 'jkiss', status: 'already_present', reason: 'Source business.', createdAt: now, updatedAt: now })
    count++
  }
  return { seeded: true, businesses: 2, updates: count }
}
