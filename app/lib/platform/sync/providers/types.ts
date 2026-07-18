// ── Sync Status — provider abstraction (decoupled from GitHub/Vercel) ────────
//
// The reconciliation engine talks ONLY to these two interfaces, never to GitHub or
// Vercel directly. GitHub and Vercel are simply the first implementations; future
// providers (Docker, Kubernetes, Railway, Cloudflare, Azure, AWS, Netlify,
// DigitalOcean, …) implement the same contracts and register in `registry.ts`, with
// zero change to the engine, data model, or UI.
//
// Everything here is READ-ONLY by contract: there is no method that mutates a repo or
// a deployment. That is the structural guarantee behind the feature's safety promise.

export type SyncResult<T> = { ok: true; data: T } | { ok: false; error: string; category?: string }

export type RepoRef = { owner: string; name: string }

export type DeployState = 'ready' | 'building' | 'error' | 'canceled' | 'queued' | 'unknown'
export type DeployEnvironment = 'production' | 'preview' | 'unknown'

export type ProviderHealth = { id: string; configured: boolean; ok: boolean; detail?: string }

/** Live production deployment facts. `gitConnected:false` (⇒ `commitSha` undefined) is a
 *  VALID state (e.g. CLI deployments), never an error. */
export type ProductionDeployment = {
  deploymentId?: string
  url?: string
  commitSha?: string
  gitConnected: boolean
  deployedAt?: number
  state: DeployState
  environment: DeployEnvironment
} | null

/** Source-control provider (VCS). First implementation: GitHub App. */
export interface SourceControlProvider {
  readonly id: string
  /** Latest commit on a branch + when it landed. */
  branchHead(repo: RepoRef, branch: string): Promise<SyncResult<{ sha: string; committedAt?: number }>>
  /** How far `head` is ahead of `base` — BOTH refs live in the SAME repo. `aheadBy` is the
   *  count of commits present in `head` but not `base` (i.e. how many the base is missing). */
  compare(repo: RepoRef, base: string, head: string): Promise<SyncResult<{ aheadBy: number; behindBy: number; status: string }>>
  /** UTF-8 text of a file at a ref. `found:false` when the path is absent (not an error). */
  readTextFile(repo: RepoRef, path: string, ref: string): Promise<SyncResult<{ found: boolean; text?: string }>>
  /** Connectivity/auth status for the dashboard's provider health chip. */
  health(): Promise<ProviderHealth>
}

/** Deployment/hosting provider. First implementations: Vercel (git) + CLI (non-git). */
export interface DeploymentProvider {
  readonly id: string
  /** The live production deployment for a project (or null when none exists). */
  productionDeployment(project: string): Promise<SyncResult<ProductionDeployment>>
  /** Reachability/health of a product's production URL or health endpoint. */
  checkHealth(url: string): Promise<SyncResult<{ healthy: boolean; status: number }>>
  /** Connectivity/auth status for the dashboard's provider health chip. */
  health(): Promise<ProviderHealth>
}
