// ── Provider registry — the single resolution point ──────────────────────────
//
// Maps a provider id → a concrete implementation. This is the ONE place that knows
// which providers exist, so adding a new backend (Docker, Kubernetes, Railway,
// Cloudflare, Azure, AWS, Netlify, DigitalOcean, …) is a single registration here —
// the engine, data model, API, and UI are untouched.
//
// Unknown/unconfigured ids resolve to a fail-closed stub, so a mis-registered product
// yields an "unknown" status (never a crash and never a false "up to date").

import type {
  SourceControlProvider, DeploymentProvider, SyncResult, RepoRef, ProductionDeployment, ProviderHealth,
} from './types'
import { GithubSourceProvider } from './github-source'
import { VercelDeploymentProvider } from './vercel-deployment'
import { CliDeploymentProvider } from './cli-deployment'

export type ProviderDeps = { fetch?: (url: string, init?: unknown) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }> }

// ── Fail-closed stubs (used for unknown/unsupported provider ids) ────────────
const NOT_SUPPORTED = (id: string) => ({ ok: false as const, error: `source provider "${id}" not supported`, category: 'not_supported' })

class StubSourceProvider implements SourceControlProvider {
  constructor(readonly id: string) {}
  async branchHead(): Promise<SyncResult<{ sha: string; committedAt?: number }>> { return NOT_SUPPORTED(this.id) }
  async compare(): Promise<SyncResult<{ aheadBy: number; behindBy: number; status: string }>> { return NOT_SUPPORTED(this.id) }
  async readTextFile(): Promise<SyncResult<{ found: boolean; text?: string }>> { return NOT_SUPPORTED(this.id) }
  async health(): Promise<ProviderHealth> { return { id: this.id, configured: false, ok: false, detail: 'unsupported source provider' } }
}

class StubDeploymentProvider implements DeploymentProvider {
  constructor(readonly id: string) {}
  async productionDeployment(): Promise<SyncResult<ProductionDeployment>> { return { ok: false, error: `deployment provider "${this.id}" not supported`, category: 'not_supported' } }
  async checkHealth(): Promise<SyncResult<{ healthy: boolean; status: number }>> { return { ok: false, error: `deployment provider "${this.id}" not supported`, category: 'not_supported' } }
  async health(): Promise<ProviderHealth> { return { id: this.id, configured: false, ok: false, detail: 'unsupported deployment provider' } }
}

/** Every source-control provider id the registry can resolve today. */
export const SOURCE_PROVIDER_IDS = ['github'] as const
/** Every deployment provider id the registry can resolve today. */
export const DEPLOYMENT_PROVIDER_IDS = ['vercel', 'cli'] as const

export function getSourceProvider(
  id: string | undefined,
  env: Record<string, string | undefined> = process.env,
  deps: ProviderDeps = {},
): SourceControlProvider {
  switch ((id ?? '').toLowerCase()) {
    case 'github': return new GithubSourceProvider(env, deps as never)
    default: return new StubSourceProvider(id || 'none')
  }
}

export function getDeploymentProvider(
  id: string | undefined,
  env: Record<string, string | undefined> = process.env,
  deps: ProviderDeps = {},
): DeploymentProvider {
  switch ((id ?? '').toLowerCase()) {
    case 'vercel': return new VercelDeploymentProvider(env, deps as never)
    case 'cli': return new CliDeploymentProvider({ fetch: deps.fetch ? (async (u: string) => { const r = await deps.fetch!(u); return { ok: r.ok, status: r.status } }) : undefined })
    default: return new StubDeploymentProvider(id || 'none')
  }
}

export type { RepoRef }
