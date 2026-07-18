// ── Operion Sync Status — service layer ──────────────────────────────────────
//
// Ties the registry (store.ts) to the reconciliation engine and computes the dashboard
// summary. This is the only layer the API routes call. All provider access is READ-ONLY
// and fail-soft; the source relationship is resolved from data (product.platformSourceId),
// never hardcoded.

import { isEnabled } from '../flags'
import {
  getProduct, listProducts, getLatest, listHistory, saveReconciliation, getMeta, setLastGlobalSync,
} from './store'
import { reconcileProduct, type EngineDeps } from './engine'
import { getSourceProvider, getDeploymentProvider } from './providers/registry'
import type {
  ReconciliationRecord, SyncProduct, SyncDashboardSummary, ProductStatusSnapshot, ProviderStatusView,
} from './types'

// ── Reconcile ─────────────────────────────────────────────────────────────────
export async function reconcileOne(
  productId: string,
  trigger: ReconciliationRecord['trigger'],
  opts: { now: number } & EngineDeps,
): Promise<ReconciliationRecord | null> {
  const product = await getProduct(productId)
  if (!product) return null
  const source = product.platformSourceId ? await getProduct(product.platformSourceId) : null
  const rec = await reconcileProduct(product, source, { now: opts.now, trigger, env: opts.env, fetch: opts.fetch })
  await saveReconciliation(rec)
  return rec
}

export async function reconcileAll(
  trigger: ReconciliationRecord['trigger'],
  opts: { now: number } & EngineDeps,
): Promise<{ reconciled: number; failed: number }> {
  const products = (await listProducts()).filter((p) => p.status !== 'archived')
  let reconciled = 0
  let failed = 0
  for (const p of products) {
    const source = p.platformSourceId ? await getProduct(p.platformSourceId) : null
    try {
      const rec = await reconcileProduct(p, source, { now: opts.now, trigger, env: opts.env, fetch: opts.fetch })
      await saveReconciliation(rec)
      reconciled++
      if (rec.failed) failed++
    } catch {
      failed++
    }
  }
  await setLastGlobalSync(opts.now)
  return { reconciled, failed }
}

// ── Drill-down ──────────────────────────────────────────────────────────────
export type ProductDetail = {
  product: SyncProduct
  source?: { id: string; displayName: string } | null
  latest: ReconciliationRecord | null
  history: ReconciliationRecord[]
  recommendedActions: string[]
}

export async function getProductDetail(productId: string, historyLimit = 25): Promise<ProductDetail | null> {
  const product = await getProduct(productId)
  if (!product) return null
  const source = product.platformSourceId ? await getProduct(product.platformSourceId) : null
  const latest = await getLatest(productId)
  const history = await listHistory(productId, historyLimit)
  return {
    product,
    source: source ? { id: source.id, displayName: source.displayName } : null,
    latest,
    history,
    recommendedActions: recommendActions(latest),
  }
}

/** Plain-language, read-only recommendations. Never triggers automation. */
export function recommendActions(rec: ReconciliationRecord | null): string[] {
  if (!rec) return ['Run a reconciliation to establish current status.']
  const out: string[] = []
  const ps = rec.platformSync
  const dep = rec.deployment

  if (ps.applicable) {
    if (ps.error) out.push('Platform sync could not be read — check GitHub connectivity and repository configuration.')
    else if (ps.state === 'unknown' && !rec.failed) out.push('Add an operion-baseline.json marker to the repository so platform drift can be measured.')
    else if (ps.updateAvailable && ps.safeToSync) out.push(`Safe to sync: ${ps.commitsBehind ?? 'pending'} platform commit(s) behind and compatible.`)
    else if (ps.updateAvailable && ps.compatibility === 'blocked') out.push('A platform update is available but marked blocked — review compatibility before syncing.')
    else if (ps.updateAvailable) out.push(`${ps.commitsBehind ?? 'Some'} platform commit(s) behind — run a compatibility review before syncing.`)
  }
  if (dep.applicable) {
    if (dep.error) out.push('Deployment status could not be read — check the Vercel project and token.')
    else if (dep.gitConnected && !dep.upToDate) out.push(`Deployment is ${dep.statusLabel.toLowerCase()} — promote the latest main to production when ready.`)
    else if (dep.health === 'down') out.push('Production health check is failing — investigate the deployment.')
  }
  if (!out.length) out.push('No action needed — product is current.')
  return out
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function isCurrent(rec: ReconciliationRecord): boolean {
  if (rec.failed) return false
  return [rec.platformSync, rec.deployment].every((s) => !s.applicable || s.state === 'ok')
}
function isBehind(rec: ReconciliationRecord): boolean {
  return [rec.platformSync, rec.deployment].some((s) => s.applicable && s.state === 'attention')
}

function snapshotFor(product: SyncProduct, rec: ReconciliationRecord | null): ProductStatusSnapshot {
  if (rec) return { ...rec, displayName: product.displayName, productType: product.productType }
  // Synthetic "never reconciled" snapshot so every registered product appears.
  return {
    recordVersion: product.recordVersion,
    id: `${product.id}:0`, productId: product.id, checkedAt: 0, trigger: 'seed',
    platformSync: {
      applicable: product.supportsPlatformSync, compatibility: 'unknown', updateAvailable: false, safeToSync: false,
      state: product.supportsPlatformSync ? 'unknown' : 'not_applicable', detail: 'Not yet reconciled.',
    },
    deployment: {
      applicable: product.supportsDeploymentTracking, gitConnected: false, environment: 'unknown', health: 'unknown',
      upToDate: false, commitLabel: '—', statusLabel: 'Not yet reconciled', state: product.supportsDeploymentTracking ? 'unknown' : 'not_applicable',
    },
    ok: true, failed: false,
    displayName: product.displayName, productType: product.productType,
  }
}

export async function buildDashboard(env: Record<string, string | undefined> = process.env): Promise<SyncDashboardSummary> {
  const products = (await listProducts()).filter((p) => p.status !== 'archived')
  const snapshots: ProductStatusSnapshot[] = []
  let current = 0, behind = 0, failedCount = 0, syncsAvailable = 0

  for (const p of products) {
    const latest = await getLatest(p.id)
    const snap = snapshotFor(p, latest)
    snapshots.push(snap)
    if (latest) {
      if (latest.failed) failedCount++
      else if (isCurrent(latest)) current++
      if (isBehind(latest)) behind++
      if (latest.platformSync.applicable && latest.platformSync.updateAvailable) syncsAvailable++
    }
  }

  const meta = await getMeta()
  const github = toProviderView(await getSourceProvider('github', env).health())
  const vercel = toProviderView(await getDeploymentProvider('vercel', env).health())

  return {
    productsRegistered: products.length,
    productsCurrent: current,
    productsBehind: behind,
    syncsAvailable,
    failedReconciliations: failedCount,
    lastGlobalSyncAt: meta.lastGlobalSyncAt,
    github,
    vercel,
    products: snapshots,
    flagEnabled: isEnabled('OPERION_SYNC_STATUS_ENABLED', env),
  }
}

function toProviderView(h: { id: string; configured: boolean; ok: boolean; detail?: string }): ProviderStatusView {
  return { id: h.id, configured: h.configured, ok: h.ok, detail: h.detail }
}
