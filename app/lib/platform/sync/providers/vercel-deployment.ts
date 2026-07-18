// ── Vercel deployment provider (adapter) ─────────────────────────────────────
//
// Implements DeploymentProvider over the existing VercelPreviewProvider (VERCEL_TOKEN
// + optional team). READ-ONLY: reads the latest production deployment + a health probe.
// When a production deployment carries no git commit (e.g. a CLI deploy), gitConnected
// is false and commitSha is undefined — a valid, expected state, not an error.

import { VercelPreviewProvider, type VercelProviderDeps } from '../../automation/vercel-provider'
import type { DeploymentProvider, ProductionDeployment, ProviderHealth, SyncResult } from './types'

export class VercelDeploymentProvider implements DeploymentProvider {
  readonly id = 'vercel'
  private vercel: VercelPreviewProvider
  private env: Record<string, string | undefined>

  constructor(env: Record<string, string | undefined> = process.env, deps: VercelProviderDeps = {}) {
    this.env = env
    this.vercel = new VercelPreviewProvider(env, deps)
  }

  private configured(): boolean {
    return !!this.env.VERCEL_TOKEN
  }

  async productionDeployment(project: string): Promise<SyncResult<ProductionDeployment>> {
    const r = await this.vercel.readProductionInfo(project)
    if (!r.ok) return r
    if (!r.data) return { ok: true, data: null }
    const d = r.data
    return {
      ok: true,
      data: {
        deploymentId: d.deploymentId,
        url: d.url,
        commitSha: d.commitSha,
        gitConnected: d.gitConnected,
        deployedAt: d.createdAt,
        state: d.state,
        environment: d.target === 'production' ? 'production' : d.target === 'preview' ? 'preview' : 'unknown',
      },
    }
  }

  async checkHealth(url: string): Promise<SyncResult<{ healthy: boolean; status: number }>> {
    const r = await this.vercel.verifyPreviewUrl(url) // plain reachability GET (no token needed)
    if (!r.ok) return r
    return { ok: true, data: { healthy: r.data.reachable, status: r.data.status } }
  }

  async health(): Promise<ProviderHealth> {
    if (!this.configured()) return { id: this.id, configured: false, ok: false, detail: 'VERCEL_TOKEN not set' }
    return { id: this.id, configured: true, ok: true }
  }
}
