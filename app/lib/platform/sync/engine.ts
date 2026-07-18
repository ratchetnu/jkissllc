// ── Reconciliation engine — orchestration (provider-driven) ──────────────────
//
// Fetches the raw facts for a product via the provider ABSTRACTION (never GitHub/Vercel
// directly) and hands them to the pure core (engine-core.ts). Fail-soft: any single
// provider error degrades that signal to "unknown" with a redacted reason — it never
// throws, and it never reports a false "up to date".

import { BASELINE_MARKER_PATH, SYNC_RECORD_VERSION, type ReconciliationRecord, type SyncProduct } from './types'
import { parseBaselineMarker } from './baseline'
import {
  computeDeploymentStatus, computePlatformSyncStatus, type DeploymentFacts, type PlatformSyncFacts,
} from './engine-core'
import { getDeploymentProvider, getSourceProvider, type ProviderDeps } from './providers/registry'
import type { RepoRef } from './providers/types'

export type EngineDeps = { env?: Record<string, string | undefined>; fetch?: ProviderDeps['fetch'] }

function repoRef(p: SyncProduct | null | undefined): RepoRef | null {
  if (!p?.githubOwner || !p?.githubRepo) return null
  return { owner: p.githubOwner, name: p.githubRepo }
}

// ── Signal 2: Deployment ──────────────────────────────────────────────────────
async function fetchDeploymentFacts(product: SyncProduct, deps: EngineDeps): Promise<DeploymentFacts> {
  if (!product.supportsDeploymentTracking) return { supportsTracking: false, gitConnected: false }

  const dp = getDeploymentProvider(product.deploymentProvider, deps.env, deps.fetch ? { fetch: deps.fetch } : {})
  const project = product.vercelProject ?? product.id
  const prod = await dp.productionDeployment(project)
  if (!prod.ok) return { supportsTracking: true, gitConnected: false, error: prod.error }

  // Best-effort health probe of the production URL (never fails the signal).
  let healthy: boolean | undefined
  if (product.productionUrl) {
    const h = await dp.checkHealth(product.productionUrl)
    if (h.ok) healthy = h.data.healthy
  }

  const data = prod.data
  if (!data) return { supportsTracking: true, gitConnected: false, error: 'no production deployment found', healthy }

  // CLI / non-git deployment — the expected, non-error path.
  if (!data.gitConnected) {
    return { supportsTracking: true, gitConnected: false, deployedAt: data.deployedAt, environment: data.environment, healthy }
  }

  // Git-connected: compare the deployed commit to the product's OWN repo main.
  const deployedCommit = data.commitSha
  let mainCommit: string | undefined
  let behindBy: number | undefined
  const repo = repoRef(product)
  if (repo && deployedCommit) {
    const sp = getSourceProvider(product.sourceProvider, deps.env, deps.fetch ? { fetch: deps.fetch } : {})
    const head = await sp.branchHead(repo, product.defaultBranch)
    if (head.ok) {
      mainCommit = head.data.sha
      const cmp = await sp.compare(repo, deployedCommit, mainCommit) // base=deployed → aheadBy = commits behind
      if (cmp.ok) behindBy = cmp.data.aheadBy
    }
  }
  return { supportsTracking: true, gitConnected: true, deployedCommit, mainCommit, behindBy, deployedAt: data.deployedAt, environment: data.environment, healthy }
}

// ── Signal 1: Platform Sync ───────────────────────────────────────────────────
async function fetchPlatformSyncFacts(product: SyncProduct, source: SyncProduct | null, deps: EngineDeps): Promise<PlatformSyncFacts> {
  if (!product.supportsPlatformSync) return { supportsSync: false, sourceConfigured: false, markerFound: false }

  const sourceRepo = repoRef(source)
  const productRepo = repoRef(product)
  if (!source || !sourceRepo) return { supportsSync: true, sourceConfigured: false, markerFound: false }
  if (!productRepo) return { supportsSync: true, sourceConfigured: true, markerFound: false, error: 'product repository not configured' }

  const spProduct = getSourceProvider(product.sourceProvider, deps.env, deps.fetch ? { fetch: deps.fetch } : {})
  const spSource = getSourceProvider(source.sourceProvider, deps.env, deps.fetch ? { fetch: deps.fetch } : {})

  // The product repo's own baseline marker = its current baseline.
  const markerRead = await spProduct.readTextFile(productRepo, BASELINE_MARKER_PATH, product.defaultBranch)
  if (!markerRead.ok) return { supportsSync: true, sourceConfigured: true, markerFound: false, error: markerRead.error }
  const marker = markerRead.data.found ? parseBaselineMarker(markerRead.data.text) : null

  // The source's latest baseline: source main HEAD + (optionally) the source's own marker version.
  const srcHead = await spSource.branchHead(sourceRepo, source.defaultBranch)
  if (!srcHead.ok) return { supportsSync: true, sourceConfigured: true, markerFound: markerRead.data.found, marker, error: srcHead.error }
  const latestBaselineCommit = srcHead.data.sha

  const srcMarkerRead = await spSource.readTextFile(sourceRepo, BASELINE_MARKER_PATH, source.defaultBranch)
  const srcMarker = srcMarkerRead.ok && srcMarkerRead.data.found ? parseBaselineMarker(srcMarkerRead.data.text) : null
  const latestBaselineVersion = srcMarker?.baselineVersion

  // Commits behind = source commits present since the product's synced baseline commit.
  let commitsBehind: number | undefined
  if (marker?.baselineCommit && latestBaselineCommit) {
    const cmp = await spSource.compare(sourceRepo, marker.baselineCommit, latestBaselineCommit)
    if (cmp.ok) commitsBehind = cmp.data.aheadBy
  }

  return { supportsSync: true, sourceConfigured: true, markerFound: markerRead.data.found, marker, latestBaselineVersion, latestBaselineCommit, commitsBehind }
}

/**
 * Reconcile one product into a ReconciliationRecord. Pure of persistence — the caller
 * stores it. Never throws.
 */
export async function reconcileProduct(
  product: SyncProduct,
  source: SyncProduct | null,
  opts: { now: number; trigger: ReconciliationRecord['trigger'] } & EngineDeps,
): Promise<ReconciliationRecord> {
  const deps: EngineDeps = { env: opts.env, fetch: opts.fetch }
  const [dFacts, pFacts] = await Promise.all([
    fetchDeploymentFacts(product, deps).catch((e): DeploymentFacts => ({ supportsTracking: true, gitConnected: false, error: errText(e) })),
    fetchPlatformSyncFacts(product, source, deps).catch((e): PlatformSyncFacts => ({ supportsSync: true, sourceConfigured: false, markerFound: false, error: errText(e) })),
  ])
  const deployment = computeDeploymentStatus(dFacts)
  const platformSync = computePlatformSyncStatus(pFacts)
  const failed = !!deployment.error || !!platformSync.error
  return {
    recordVersion: SYNC_RECORD_VERSION,
    id: `${product.id}:${opts.now}`,
    productId: product.id,
    checkedAt: opts.now,
    trigger: opts.trigger,
    platformSync,
    deployment,
    ok: !failed,
    failed,
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'unexpected reconciliation error'
}
