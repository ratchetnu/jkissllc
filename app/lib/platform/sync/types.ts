// ── Operion Sync Status — data model ─────────────────────────────────────────
//
// The system-of-record for "is every product Operion runs up to date?" Two independent
// signals per product:
//   1. Platform Sync Status — has this product received the source platform's latest
//      compatible improvements (baseline-marker vs configured source).
//   2. Deployment Status — does the live deployment match the product's own repo main.
//
// Storage: Redis, the platform-global `platform:` key family (NEVER tenant-scoped —
// enforced by the key chokepoint's allowlist). No SQL, no migrations.
//
// AI-READINESS: every reconciliation is persisted as a flat, queryable record with
// explicit booleans and counts (upToDate, updateAvailable, safeToSync, commitsBehind,
// failed) and stable ids/timestamps, so an assistant can answer "which products are
// behind / safe to update / failed reconciliation this week / changed since last
// deploy" by reading these records — no schema change required.

export const SYNC_RECORD_VERSION = 1

// ── Product registry ──────────────────────────────────────────────────────────
export type ProductType = 'platform_source' | 'branded_clone' | 'standalone' | 'library' | 'other'
export type ProductStatus = 'active' | 'paused' | 'archived'

/** A product Operion manages. Adding one is pure registration — no code change. */
export type SyncProduct = {
  recordVersion: number
  id: string                       // stable slug, e.g. 'jkiss' | 'supercharged' | 'claimguard'
  displayName: string
  productType: ProductType
  status: ProductStatus
  // Source control (nullable for products with no tracked repo).
  sourceProvider: string           // 'github' (registry id)
  githubOwner?: string
  githubRepo?: string
  defaultBranch: string            // 'main'
  // Deployment / hosting.
  deploymentProvider: string       // 'vercel' | 'cli' | future
  vercelProject?: string
  productionUrl?: string
  healthPath?: string              // default '/api/health'
  // Platform relationship — CONFIGURABLE. The id of the product that is this product's
  // upstream source. null ⇒ this product is itself a source or a standalone. J KISS is
  // NOT hardcoded anywhere; it is simply the default source id in the seed.
  platformSourceId?: string | null
  // Capability switches — a product may support one signal, both, or neither.
  supportsPlatformSync: boolean
  supportsDeploymentTracking: boolean
  createdAt: number
  updatedAt: number
}

// ── Baseline marker (committed into each participating repo) ──────────────────
// Generic, platform-agnostic. Generated during an approved platform sync and committed
// as part of that update — never hand-edited. The Update Center reads it from GitHub.
export const BASELINE_MARKER_PATH = 'operion-baseline.json'
export const OPERION_PLATFORM_ID = 'operion-core'
export const BASELINE_COMPATIBILITY_VERSION = 1

export type BaselineMarker = {
  platform: string                 // e.g. 'operion-core'
  baselineVersion: string          // human/semver baseline the product was synced to
  baselineCommit: string           // the SOURCE-repo commit the product was synced from
  generatedAt: string              // ISO timestamp
  compatibilityVersion: number     // schema version of this marker contract
}

// ── Reconciled signal snapshots ───────────────────────────────────────────────
export type SignalState = 'ok' | 'attention' | 'unknown' | 'not_applicable'

/** Signal 1 — does the product carry the source platform's latest changes. */
export type PlatformSyncStatus = {
  applicable: boolean
  currentBaselineVersion?: string     // from the product repo's marker
  currentBaselineCommit?: string
  latestBaselineVersion?: string      // from the source
  latestBaselineCommit?: string       // source main HEAD
  commitsBehind?: number              // source commits the product hasn't taken
  compatibility: 'compatible' | 'needs_changes' | 'blocked' | 'unknown'
  updateAvailable: boolean
  safeToSync: boolean
  state: SignalState
  detail?: string                     // human summary / reason for unknown
  error?: string                      // redacted provider error, if any
}

/** Signal 2 — does the live deployment match the product's own repo main. */
export type DeploymentStatus = {
  applicable: boolean
  gitConnected: boolean               // false ⇒ CLI/non-git deployment
  deployedCommit?: string             // undefined for CLI deployments
  mainCommit?: string
  behindBy?: number
  deployedAt?: number
  environment: 'production' | 'preview' | 'unknown'
  health: 'healthy' | 'degraded' | 'down' | 'unknown'
  upToDate: boolean
  /** Display label for the commit field: a sha, or 'N/A (CLI Deployment)'. */
  commitLabel: string
  /** Display label for the status: e.g. 'Up to date', 'Behind', 'Verified' (CLI). */
  statusLabel: string
  state: SignalState
  detail?: string
  error?: string
}

/** One full reconciliation of one product — the unit stored in history. */
export type ReconciliationRecord = {
  recordVersion: number
  id: string                          // `${productId}:${checkedAt}`
  productId: string
  checkedAt: number
  trigger: 'cron' | 'manual' | 'seed'
  platformSync: PlatformSyncStatus
  deployment: DeploymentStatus
  ok: boolean                         // true when neither signal errored
  failed: boolean                     // convenience inverse for AI queries
}

/** The latest reconciliation per product (fast-path for the dashboard). */
export type ProductStatusSnapshot = ReconciliationRecord & { displayName: string; productType: ProductType }

// ── Dashboard summary ─────────────────────────────────────────────────────────
export type ProviderStatusView = { id: string; configured: boolean; ok: boolean; detail?: string }

export type SyncDashboardSummary = {
  productsRegistered: number
  productsCurrent: number             // up to date on BOTH applicable signals
  productsBehind: number              // at least one applicable signal needs attention
  syncsAvailable: number              // products with updateAvailable
  failedReconciliations: number       // products whose last reconcile errored
  lastGlobalSyncAt?: number
  github: ProviderStatusView
  vercel: ProviderStatusView
  products: ProductStatusSnapshot[]
  flagEnabled: boolean
}
