// ── CLI deployment provider ──────────────────────────────────────────────────
//
// For products deployed OUTSIDE a git-connected pipeline (e.g. `vercel deploy` from a
// laptop, a Docker push, a manual release). These deployments legitimately expose NO
// git commit, so "deployed commit vs main" is not applicable. Per the product spec this
// is EXPECTED — the UI shows "N/A (CLI Deployment)" for the commit and a "Verified"
// deployment status, never an error.
//
// It still performs a live health probe of the production URL, so the deployment's
// reachability is real, not assumed.

import type { DeploymentProvider, ProductionDeployment, ProviderHealth, SyncResult } from './types'

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number }>

export class CliDeploymentProvider implements DeploymentProvider {
  readonly id = 'cli'
  private fetcher: Fetcher

  constructor(deps: { fetch?: Fetcher } = {}) {
    this.fetcher = deps.fetch ?? (async (url: string) => {
      const res = await fetch(url, { method: 'GET', cache: 'no-store' })
      return { ok: res.ok, status: res.status }
    })
  }

  // A CLI deployment has no queryable control plane and no git commit. We report it as a
  // ready production deployment with gitConnected:false — the engine renders this as
  // "N/A (CLI Deployment)" + "Verified".
  async productionDeployment(): Promise<SyncResult<ProductionDeployment>> {
    return { ok: true, data: { gitConnected: false, state: 'ready', environment: 'production' } }
  }

  async checkHealth(url: string): Promise<SyncResult<{ healthy: boolean; status: number }>> {
    if (!url) return { ok: false, error: 'url required', category: 'config' }
    try {
      const res = await this.fetcher(url)
      return { ok: true, data: { healthy: res.ok, status: res.status } }
    } catch {
      return { ok: false, error: 'production url unreachable', category: 'network' }
    }
  }

  async health(): Promise<ProviderHealth> {
    // No credentials required — a CLI-tracked product is always "configured".
    return { id: this.id, configured: true, ok: true }
  }
}
