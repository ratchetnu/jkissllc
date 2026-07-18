// ── Operion automation — live GitHub App provider ───────────────────────────
//
// Replaces the StubProvider with a real GitHub App integration: mint a short-lived App
// JWT (RS256) from GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (env only), exchange it for a
// cached installation token, and drive the GitHub REST API. READ ops are always allowed;
// WRITE ops are DOUBLE-gated — the orchestrator only calls them when the flags are on,
// AND each write op self-checks OPERION_GITHUB_ACTIONS_ENABLED and fails closed otherwise.
//
// Secrets are NEVER logged, serialized, or returned. `fetch`/`now` are injectable so the
// whole thing is testable with a mocked API + a throwaway key (no live GitHub calls).

import crypto from 'node:crypto'
import { isEnabled } from '../flags'
import type { UpdateAutomationProvider, RepoRef, ProviderResult } from './provider'
import { getPreviewProvider, type PreviewProvider } from './vercel-provider'

const API = 'https://api.github.com'
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }>

export type GitHubProviderDeps = { fetch?: FetchLike; now?: () => number }

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export class GitHubActionsProvider implements UpdateAutomationProvider {
  readonly name = 'github'
  private appId?: string
  private privateKey?: string
  private fetch: FetchLike
  private now: () => number
  private preview: PreviewProvider
  private tokenCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(env: Record<string, string | undefined> = process.env, deps: GitHubProviderDeps = {}) {
    this.appId = env.GITHUB_APP_ID
    // Support a literal PEM (multi-line) or a base64-encoded single-line value.
    const raw = env.GITHUB_APP_PRIVATE_KEY
    this.privateKey = raw && !raw.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(raw) ? Buffer.from(raw, 'base64').toString('utf8') : raw
    this.fetch = deps.fetch ?? ((globalThis.fetch as unknown) as FetchLike)
    this.now = deps.now ?? (() => Date.now())
    // Vercel Preview stage — server-side, preview-only. Fail-closed stub when no token.
    this.preview = getPreviewProvider(env, { fetch: deps.fetch, now: deps.now })
  }

  // ── App JWT (RS256) ────────────────────────────────────────────────────────
  private appJwt(): { ok: true; jwt: string } | { ok: false; error: string } {
    if (!this.appId) return { ok: false, error: 'GITHUB_APP_ID missing' }
    if (!this.privateKey) return { ok: false, error: 'GITHUB_APP_PRIVATE_KEY missing' }
    try {
      const iat = Math.floor(this.now() / 1000) - 60
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
      const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: this.appId }))
      const signingInput = `${header}.${payload}`
      const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(this.privateKey)
      return { ok: true, jwt: `${signingInput}.${b64url(sig)}` }
    } catch {
      // Never surface the key or the underlying crypto message.
      return { ok: false, error: 'JWT generation failed (check the private key format)' }
    }
  }

  private async installationToken(installationId: string): Promise<ProviderResult<string>> {
    const cached = this.tokenCache.get(installationId)
    if (cached && cached.expiresAt - 60_000 > this.now()) return { ok: true, data: cached.token }
    const jwt = this.appJwt()
    if (!jwt.ok) return { ok: false, error: jwt.error, category: 'auth' }
    let res
    try {
      res = await this.fetch(`${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
        method: 'POST', headers: this.appHeaders(jwt.jwt),
      })
    } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
    if (res.status === 404) return { ok: false, error: 'installation not found', category: 'installation' }
    if (!res.ok) return { ok: false, error: `installation token request failed (${res.status})`, category: 'auth' }
    const body = (await res.json().catch(() => null)) as { token?: string; expires_at?: string } | null
    if (!body?.token) return { ok: false, error: 'no token in response', category: 'auth' }
    this.tokenCache.set(installationId, { token: body.token, expiresAt: body.expires_at ? Date.parse(body.expires_at) : this.now() + 55 * 60_000 })
    return { ok: true, data: body.token }
  }

  private appHeaders(jwt: string): Record<string, string> {
    return { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'operion-update-center' }
  }
  private async tokenHeaders(installationId: string): Promise<ProviderResult<Record<string, string>>> {
    const t = await this.installationToken(installationId)
    if (!t.ok) return t
    return { ok: true, data: { Authorization: `Bearer ${t.data}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'operion-update-center' } }
  }

  private async get<T>(installationId: string, path: string, map: (b: unknown) => T): Promise<ProviderResult<T>> {
    const h = await this.tokenHeaders(installationId)
    if (!h.ok) return h
    let res
    try { res = await this.fetch(`${API}${path}`, { headers: h.data }) } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
    if (res.status === 404) return { ok: false, error: 'not found', category: 'not_found' }
    if (res.status === 403) return { ok: false, error: 'forbidden (permission scope?)', category: 'permission' }
    if (!res.ok) return { ok: false, error: `GitHub API error (${res.status})`, category: 'api' }
    try { return { ok: true, data: map(await res.json()) } } catch { return { ok: false, error: 'bad response', category: 'api' } }
  }

  // A write op only proceeds when the GitHub-Actions flag is on. Defence-in-depth: the
  // orchestrator already gates dispatch, and this gate stops any direct call too.
  private writeGuard(): ProviderResult<never> | null {
    return isEnabled('OPERION_GITHUB_ACTIONS_ENABLED') ? null : { ok: false, error: 'write operations disabled (OPERION_GITHUB_ACTIONS_ENABLED is off)', category: 'disabled' }
  }

  // ── READ (never mutate) ─────────────────────────────────────────────────────
  async getRepoInstallation(repo: RepoRef): Promise<ProviderResult<{ installationId: string }>> {
    const jwt = this.appJwt()
    if (!jwt.ok) return { ok: false, error: jwt.error, category: 'auth' }
    let res
    try { res = await this.fetch(`${API}/repos/${repo.owner}/${repo.name}/installation`, { headers: this.appHeaders(jwt.jwt) }) } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
    if (res.status === 404) return { ok: false, error: 'App is not installed on this repository', category: 'installation' }
    if (!res.ok) return { ok: false, error: `installation lookup failed (${res.status})`, category: 'api' }
    const b = (await res.json().catch(() => null)) as { id?: number } | null
    if (b?.id == null) return { ok: false, error: 'no installation id', category: 'api' }
    return { ok: true, data: { installationId: String(b.id) } }
  }
  async validateConnection(installationId: string): Promise<ProviderResult<{ connected: boolean; login?: string }>> {
    const t = await this.installationToken(installationId)   // proves App auth + installation
    if (!t.ok) return t
    return { ok: true, data: { connected: true } }
  }
  readRepository(installationId: string, repo: RepoRef) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}`, (b) => { const r = b as { default_branch: string; private: boolean }; return { defaultBranch: r.default_branch, private: r.private } })
  }
  readBranch(installationId: string, repo: RepoRef, branch: string) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}`, (b) => ({ commit: (b as { commit: { sha: string } }).commit.sha }))
  }
  readCommit(installationId: string, repo: RepoRef, sha: string) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(sha)}`, (b) => { const r = b as { sha: string; commit: { message: string } }; return { sha: r.sha, message: r.commit.message } })
  }
  readCommitFiles(installationId: string, repo: RepoRef, sha: string) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(sha)}`, (b) => {
      const r = b as { files?: { filename: string; status: string }[] }
      return { files: (r.files ?? []).map(f => ({ filename: f.filename, status: f.status })) }
    })
  }
  readFileContent(installationId: string, repo: RepoRef, path: string, ref: string) {
    // Contents API returns base64; we re-hash the decoded bytes so the manifest hash is
    // over the exact content we transfer (not GitHub's git-blob sha).
    const safe = path.split('/').map(encodeURIComponent).join('/')
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/contents/${safe}?ref=${encodeURIComponent(ref)}`, (b) => {
      const r = b as { content?: string; encoding?: string }
      const contentBase64 = (r.content ?? '').replace(/\n/g, '')
      const sha256 = crypto.createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex')
      return { contentBase64, sha256 }
    })
  }
  // Compare two commits/refs (read-only). ahead_by = commits `head` has that `base` lacks.
  // Sync Status uses base=target's synced baseline, head=source main → aheadBy = how many
  // source commits the target hasn't taken yet.
  compareCommits(installationId: string, repo: RepoRef, base: string, head: string) {
    return this.get(
      installationId,
      `/repos/${repo.owner}/${repo.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      (b) => {
        const r = b as { ahead_by?: number; behind_by?: number; status?: string; total_commits?: number }
        return { aheadBy: r.ahead_by ?? 0, behindBy: r.behind_by ?? 0, status: r.status ?? 'unknown', totalCommits: r.total_commits ?? 0 }
      },
    )
  }
  // Detailed compare (read-only) for Publish Review — base…head with per-file diff
  // stats. Increment 3B.2D. Returns the changed files (path + status + additions +
  // deletions), the commit count, and summed additions/deletions. Same GET compare
  // endpoint as compareCommits — no write path. `files` may be truncated by GitHub for
  // very large diffs (top-level `files` caps at 300); we surface `truncated` so the
  // caller can warn rather than imply completeness.
  compareCommitsDetailed(installationId: string, repo: RepoRef, base: string, head: string) {
    return this.get(
      installationId,
      `/repos/${repo.owner}/${repo.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      (b) => {
        const r = b as {
          ahead_by?: number; behind_by?: number; status?: string; total_commits?: number
          files?: { filename?: string; status?: string; additions?: number; deletions?: number; changes?: number }[]
        }
        const files = (r.files ?? []).map((f) => ({ filename: f.filename ?? '', status: f.status ?? 'modified', additions: f.additions ?? 0, deletions: f.deletions ?? 0 }))
        const additions = files.reduce((s, f) => s + (f.additions ?? 0), 0)
        const deletions = files.reduce((s, f) => s + (f.deletions ?? 0), 0)
        return {
          aheadBy: r.ahead_by ?? 0,
          behindBy: r.behind_by ?? 0,
          status: r.status ?? 'unknown',
          totalCommits: r.total_commits ?? 0,
          fileCount: files.length,
          files,
          additions,
          deletions,
          truncated: files.length >= 300,
        }
      },
    )
  }
  // Branch HEAD with its commit date — "latest commit on main" + when it landed.
  readBranchHead(installationId: string, repo: RepoRef, branch: string) {
    return this.get(
      installationId,
      `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}`,
      (b) => {
        const r = b as { commit: { sha: string; commit?: { committer?: { date?: string }; author?: { date?: string } } } }
        const date = r.commit.commit?.committer?.date ?? r.commit.commit?.author?.date
        return { sha: r.commit.sha, committedAt: date ? Date.parse(date) : undefined }
      },
    )
  }
  readPullRequest(installationId: string, repo: RepoRef, number: number) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/pulls/${number}`, (b) => { const r = b as { head: { sha: string }; mergeable: boolean; html_url: string }; return { headSha: r.head.sha, mergeable: !!r.mergeable, url: r.html_url } })
  }
  findPullRequest(installationId: string, repo: RepoRef, head: string) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(repo.owner)}:${encodeURIComponent(head)}&state=all&per_page=1`, (b) => {
      const arr = (b as { number: number; html_url: string }[]) ?? []
      return arr[0] ? { number: arr[0].number, url: arr[0].html_url } : null
    })
  }
  readWorkflowRun(installationId: string, repo: RepoRef, runId: string) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/actions/runs/${encodeURIComponent(runId)}`, (b) => { const r = b as { status: string; conclusion?: string; html_url: string }; return { status: r.status, conclusion: r.conclusion, url: r.html_url } })
  }
  readCheckResults(installationId: string, repo: RepoRef, ref: string) {
    return this.get(installationId, `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}/check-runs`, (b) => {
      const r = b as { check_runs?: { conclusion?: string }[] }
      const runs = r.check_runs ?? []
      const failed = runs.filter(x => x.conclusion && !['success', 'neutral', 'skipped'].includes(x.conclusion)).length
      return { passed: failed === 0, total: runs.length, failed }
    })
  }
  async runHealthCheck(url: string): Promise<ProviderResult<{ ok: boolean; status: number }>> {
    try { const res = await this.fetch(url); return { ok: true, data: { ok: res.ok, status: res.status } } } catch { return { ok: false, error: 'unreachable', category: 'network' } }
  }

  // ── WRITE (flag-gated; not executed while automation is off) ─────────────────
  async createBranch(installationId: string, repo: RepoRef, fromBranch: string, newBranch: string): Promise<ProviderResult<{ branch: string; commit: string }>> {
    const g = this.writeGuard(); if (g) return g
    const base = await this.readBranch(installationId, repo, fromBranch)
    if (!base.ok) return base
    const h = await this.tokenHeaders(installationId); if (!h.ok) return h
    try {
      const res = await this.fetch(`${API}/repos/${repo.owner}/${repo.name}/git/refs`, { method: 'POST', headers: h.data, body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: base.data.commit }) })
      if (!res.ok) return { ok: false, error: `create branch failed (${res.status})`, category: 'api' }
      return { ok: true, data: { branch: newBranch, commit: base.data.commit } }
    } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
  }
  async dispatchWorkflow(installationId: string, repo: RepoRef, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<ProviderResult<{ dispatched: boolean }>> {
    const g = this.writeGuard(); if (g) return g
    const h = await this.tokenHeaders(installationId); if (!h.ok) return h
    try {
      const res = await this.fetch(`${API}/repos/${repo.owner}/${repo.name}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, { method: 'POST', headers: h.data, body: JSON.stringify({ ref, inputs }) })
      if (res.status === 204) return { ok: true, data: { dispatched: true } }
      return { ok: false, error: `dispatch failed (${res.status})`, category: 'api' }
    } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
  }
  async createPullRequest(installationId: string, repo: RepoRef, head: string, base: string, title: string, body: string): Promise<ProviderResult<{ number: number; url: string }>> {
    const g = this.writeGuard(); if (g) return g
    const h = await this.tokenHeaders(installationId); if (!h.ok) return h
    try {
      const res = await this.fetch(`${API}/repos/${repo.owner}/${repo.name}/pulls`, { method: 'POST', headers: h.data, body: JSON.stringify({ head, base, title, body }) })
      if (!res.ok) return { ok: false, error: `create PR failed (${res.status})`, category: 'api' }
      const r = (await res.json()) as { number: number; html_url: string }
      return { ok: true, data: { number: r.number, url: r.html_url } }
    } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
  }
  async mergePullRequest(installationId: string, repo: RepoRef, number: number, expectedHeadSha: string): Promise<ProviderResult<{ merged: boolean; mergeCommit?: string }>> {
    const g = this.writeGuard(); if (g) return g
    const h = await this.tokenHeaders(installationId); if (!h.ok) return h
    try {
      // sha guard: GitHub refuses the merge if the PR head moved (commit-drift protection).
      const res = await this.fetch(`${API}/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { method: 'PUT', headers: h.data, body: JSON.stringify({ sha: expectedHeadSha, merge_method: 'squash' }) })
      if (!res.ok) return { ok: false, error: `merge failed (${res.status})`, category: res.status === 409 ? 'commit_drift' : 'api' }
      const r = (await res.json()) as { merged: boolean; sha?: string }
      return { ok: true, data: { merged: !!r.merged, mergeCommit: r.sha } }
    } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
  }
  async cancelJob(installationId: string, repo: RepoRef, runId: string): Promise<ProviderResult<{ cancelled: boolean }>> {
    const g = this.writeGuard(); if (g) return g
    const h = await this.tokenHeaders(installationId); if (!h.ok) return h
    try {
      const res = await this.fetch(`${API}/repos/${repo.owner}/${repo.name}/actions/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', headers: h.data })
      if (res.status === 202) return { ok: true, data: { cancelled: true } }
      return { ok: false, error: `cancel failed (${res.status})`, category: 'api' }
    } catch { return { ok: false, error: 'GitHub API unreachable', category: 'network' } }
  }

  // ── Vercel Preview (delegated to the server-side Vercel provider; preview-only) ──
  async readDeployment(_project: string, deploymentId: string): Promise<ProviderResult<{ state: string; url?: string }>> {
    const r = await this.preview.readPreviewDeployment(deploymentId)
    return r.ok ? { ok: true, data: { state: r.data.state, url: r.data.url } } : r
  }
  async createPreviewDeployment(project: string, ref: string): Promise<ProviderResult<{ deploymentId: string; url: string }>> {
    // repoId is required to create a git preview; the primary pilot path is git-push
    // auto-deploy (Vercel creates the preview on branch push) with server-side polling via
    // the Vercel provider. This explicit-create path needs previewRepoId wired through.
    const r = await this.preview.createPreviewDeployment({ project, ref })
    return r.ok ? { ok: true, data: { deploymentId: r.data.deploymentId, url: r.data.url ?? '' } } : r
  }
  // Production promotion stays fail-closed here — promotion is gated by the owner approval
  // path + OPERION_PRODUCTION_PROMOTION_ENABLED, never by this provider.
  promoteProduction() { return Promise.resolve({ ok: false as const, error: 'production promotion is owner-gated and disabled for the preview pilot', category: 'disabled' }) }
}
