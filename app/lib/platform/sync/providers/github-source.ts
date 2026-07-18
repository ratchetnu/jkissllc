// ── GitHub source-control provider (adapter) ─────────────────────────────────
//
// Implements SourceControlProvider over the existing GitHubActionsProvider (App-JWT
// auth + cached installation tokens). READ-ONLY: only branch/compare/file-content
// reads — no write method is reachable from here. Installation ids are resolved once
// per repo (App JWT) and cached in-memory.

import { GitHubActionsProvider, type GitHubProviderDeps } from '../../automation/github-provider'
import type { RepoRef, SourceControlProvider, SyncResult, ProviderHealth } from './types'

export class GithubSourceProvider implements SourceControlProvider {
  readonly id = 'github'
  private gh: GitHubActionsProvider
  private env: Record<string, string | undefined>
  private installByRepo = new Map<string, string>()

  constructor(env: Record<string, string | undefined> = process.env, deps: GitHubProviderDeps = {}) {
    this.env = env
    this.gh = new GitHubActionsProvider(env, deps)
  }

  private configured(): boolean {
    return !!this.env.GITHUB_APP_ID && !!this.env.GITHUB_APP_PRIVATE_KEY
  }

  private async installationId(repo: RepoRef): Promise<SyncResult<string>> {
    const key = `${repo.owner}/${repo.name}`.toLowerCase()
    const cached = this.installByRepo.get(key)
    if (cached) return { ok: true, data: cached }
    const r = await this.gh.getRepoInstallation(repo)
    if (!r.ok) return r
    this.installByRepo.set(key, r.data.installationId)
    return { ok: true, data: r.data.installationId }
  }

  async branchHead(repo: RepoRef, branch: string): Promise<SyncResult<{ sha: string; committedAt?: number }>> {
    const inst = await this.installationId(repo)
    if (!inst.ok) return inst
    return this.gh.readBranchHead(inst.data, repo, branch)
  }

  async compare(repo: RepoRef, base: string, head: string): Promise<SyncResult<{ aheadBy: number; behindBy: number; status: string }>> {
    const inst = await this.installationId(repo)
    if (!inst.ok) return inst
    const r = await this.gh.compareCommits(inst.data, repo, base, head)
    if (!r.ok) return r
    return { ok: true, data: { aheadBy: r.data.aheadBy, behindBy: r.data.behindBy, status: r.data.status } }
  }

  async readTextFile(repo: RepoRef, path: string, ref: string): Promise<SyncResult<{ found: boolean; text?: string }>> {
    const inst = await this.installationId(repo)
    if (!inst.ok) return inst
    const r = await this.gh.readFileContent(inst.data, repo, path, ref)
    if (!r.ok) {
      // A missing marker file is a normal, non-error outcome for the caller.
      if (r.category === 'not_found') return { ok: true, data: { found: false } }
      return r
    }
    const text = Buffer.from(r.data.contentBase64, 'base64').toString('utf8')
    return { ok: true, data: { found: true, text } }
  }

  async health(): Promise<ProviderHealth> {
    if (!this.configured()) return { id: this.id, configured: false, ok: false, detail: 'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set' }
    // A cheap App-auth probe: mint an App JWT via any installation lookup path. We avoid a
    // specific repo here and simply report configured; a per-repo read surfaces real errors.
    return { id: this.id, configured: true, ok: true }
  }
}
