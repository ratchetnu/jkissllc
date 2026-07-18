// ── Operion Sync Status — product registry seed ──────────────────────────────
//
// Registers the products Operion runs. Adding a product later is pure registration
// (POST /api/admin/platform/sync/products) — NO code change. Existing owner-edited
// records are NEVER overwritten (idempotent create-if-absent), so a re-seed is safe.
//
// The source relationship is DATA, not code: `platformSourceId` points at whichever
// product is the upstream. Today that is J KISS, but it is not hardcoded anywhere —
// change the field and Supercharged (or any product) becomes the source.

import { getProduct, saveProduct } from './store'
import { SYNC_RECORD_VERSION, type SyncProduct } from './types'

function base(now: number): Omit<SyncProduct, 'id' | 'displayName' | 'productType'> {
  return {
    recordVersion: SYNC_RECORD_VERSION,
    status: 'active',
    sourceProvider: 'github',
    defaultBranch: 'main',
    deploymentProvider: 'vercel',
    healthPath: '/api/health',
    platformSourceId: null,
    supportsPlatformSync: false,
    supportsDeploymentTracking: true,
    createdAt: now,
    updatedAt: now,
  }
}

/** Seed the initial product roster. Idempotent: only creates records that are absent. */
export async function seedSyncProducts(now: number): Promise<{ seeded: number }> {
  const products: SyncProduct[] = [
    // The source platform. It IS the baseline, so platform-sync is N/A for it.
    {
      ...base(now), id: 'jkiss', displayName: 'J KISS LLC', productType: 'platform_source',
      githubOwner: 'ratchetnu', githubRepo: 'jkissllc', vercelProject: 'jkissllc', productionUrl: 'https://jkissllc.com',
      platformSourceId: null, supportsPlatformSync: false, supportsDeploymentTracking: true,
    },
    // A branded clone of the source — BOTH signals apply.
    {
      ...base(now), id: 'supercharged', displayName: 'Supercharged Enterprises', productType: 'branded_clone',
      githubOwner: 'ratchetnu', githubRepo: 'supercharged', vercelProject: 'supercharged', productionUrl: 'https://superchargedenterprise.com',
      platformSourceId: 'jkiss', supportsPlatformSync: true, supportsDeploymentTracking: true,
    },
    // A standalone product that deploys via the Vercel CLI (no git commit on the deploy) —
    // deployment tracking shows "N/A (CLI Deployment)" + "Verified"; platform-sync N/A.
    {
      ...base(now), id: 'claimguard', displayName: 'ClaimGuard', productType: 'standalone',
      deploymentProvider: 'cli', githubOwner: 'ratchetnu', githubRepo: 'claimguard',
      platformSourceId: null, supportsPlatformSync: false, supportsDeploymentTracking: true,
    },
    // Registered but not yet fully configured — appears in the roster as "unknown / needs
    // configuration" until repo + project are filled in via the registry UI. Demonstrates
    // that new products are added by registration alone.
    {
      ...base(now), id: 'howard-wealth', displayName: 'Howard Wealth Planning', productType: 'standalone',
      platformSourceId: null, supportsPlatformSync: false, supportsDeploymentTracking: true,
    },
    {
      ...base(now), id: 'nunubabymuzik', displayName: 'NunuBabyMuzik', productType: 'standalone',
      platformSourceId: null, supportsPlatformSync: false, supportsDeploymentTracking: true,
    },
  ]

  let seeded = 0
  for (const p of products) {
    if (!(await getProduct(p.id))) {
      await saveProduct(p)
      seeded++
    }
  }
  return { seeded }
}
