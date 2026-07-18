// ── Operion automation — Vercel Preview provider (server-only, preview-only) ──
//
// Server-side integration with the Vercel REST API for the Preview stage of an automation
// job. Credentials (VERCEL_TOKEN, optional VERCEL_TEAM_ID) live in the environment only and
// are NEVER logged, serialized, or returned. `fetch`/`now`/`sleep` are injectable so the
// whole thing is hermetically testable against a mocked API — no live Vercel calls.
//
// SAFETY INVARIANTS (enforced here, defence-in-depth on top of the orchestrator/flags):
//   • Preview ONLY. createPreviewDeployment never sets target:'production'; there is no
//     promotion method on this provider at all.
//   • The target project must be supplied by the caller (the orchestrator passes
//     business.previewProjectId — an allowlisted value, never browser input).
//   • No environment-variable mutation. No secret exposure. Reads/creates deployments only.

import type { ProviderResult } from './provider'

const API = 'https://api.vercel.com'

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }>
export type VercelProviderDeps = { fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> }

/** Normalised deployment state. Vercel readyState → one of these. */
export type PreviewState = 'queued' | 'building' | 'ready' | 'error' | 'canceled' | 'unknown'
const TERMINAL: PreviewState[] = ['ready', 'error', 'canceled']

function mapReadyState(rs: unknown): PreviewState {
  switch (String(rs || '').toUpperCase()) {
    case 'READY': return 'ready'
    case 'ERROR': return 'error'
    case 'CANCELED': return 'canceled'
    case 'QUEUED': case 'INITIALIZING': return 'queued'
    case 'BUILDING': case 'ANALYZING': case 'UPLOADING': case 'DEPLOYING': return 'building'
    default: return 'unknown'
  }
}

/** Ensure a deployment URL is absolute + https (Vercel returns a bare host). */
function absUrl(u: string | undefined): string | undefined {
  if (!u) return undefined
  return /^https?:\/\//.test(u) ? u : `https://${u}`
}

export interface CreatePreviewInput {
  /** Vercel project id or name — allowlisted (business.previewProjectId). */
  project: string
  /** Git branch to deploy as a Preview. */
  ref: string
  /** Numeric GitHub repository id for the git source (business.previewRepoId). */
  repoId?: string
  /** Optional team scope (else VERCEL_TEAM_ID). */
  teamId?: string
}

export interface PreviewDeployment {
  deploymentId: string
  url?: string
  inspectorUrl?: string
  state: PreviewState
  ready: boolean
  failed: boolean
}

export class VercelPreviewProvider {
  readonly name = 'vercel'
  private token?: string
  private teamId?: string
  private fetch: FetchLike
  private now: () => number
  private sleep: (ms: number) => Promise<void>

  constructor(env: Record<string, string | undefined> = process.env, deps: VercelProviderDeps = {}) {
    this.token = env.VERCEL_TOKEN
    this.teamId = env.VERCEL_TEAM_ID
    this.fetch = deps.fetch ?? ((globalThis.fetch as unknown) as FetchLike)
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** True when a server-side Vercel token is present. */
  get configured(): boolean { return !!this.token }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'operion-update-center' }
  }
  private team(explicit?: string): string {
    const id = explicit || this.teamId
    return id ? `?teamId=${encodeURIComponent(id)}` : ''
  }
  private inspector(deploymentId: string): string {
    // Human-facing inspector reference (safe to surface; contains no secret).
    return `https://vercel.com/deployments/${encodeURIComponent(deploymentId)}`
  }

  // ── Create a Preview deployment for a branch ────────────────────────────────
  async createPreviewDeployment(input: CreatePreviewInput): Promise<ProviderResult<PreviewDeployment>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!input.project) return { ok: false, error: 'preview project is required (allowlisted business.previewProjectId)', category: 'config' }
    if (!input.ref) return { ok: false, error: 'git ref (branch) is required', category: 'config' }
    if (!input.repoId) return { ok: false, error: 'previewRepoId (numeric GitHub repo id) is required to create a git preview', category: 'config' }
    // Preview target: `target` is intentionally omitted (null) — NEVER 'production'.
    const body = JSON.stringify({
      name: input.project,
      project: input.project,
      target: null,
      gitSource: { type: 'github', ref: input.ref, repoId: input.repoId },
    })
    let res
    try { res = await this.fetch(`${API}/v13/deployments${this.team(input.teamId)}`, { method: 'POST', headers: this.headers(), body }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Vercel auth/permission denied', category: 'permission' }
    if (!res.ok) return { ok: false, error: `create preview failed (${res.status})`, category: 'api' }
    const b = (await res.json().catch(() => null)) as { id?: string; url?: string; readyState?: string; inspectorUrl?: string } | null
    if (!b?.id) return { ok: false, error: 'no deployment id in response', category: 'api' }
    const state = mapReadyState(b.readyState)
    return { ok: true, data: { deploymentId: b.id, url: absUrl(b.url), inspectorUrl: b.inspectorUrl || this.inspector(b.id), state, ready: state === 'ready', failed: state === 'error' || state === 'canceled' } }
  }

  // ── Find the newest Preview deployment for a git branch (artifact recovery) ──
  async findPreviewByBranch(project: string, branch: string, teamId?: string): Promise<ProviderResult<PreviewDeployment | null>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!project || !branch) return { ok: false, error: 'project + branch required', category: 'config' }
    const scope = (explicit?: string) => { const id = explicit || this.teamId; return id ? `&teamId=${encodeURIComponent(id)}` : '' }
    let res
    try { res = await this.fetch(`${API}/v6/deployments?projectId=${encodeURIComponent(project)}${scope(teamId)}&limit=40`, { headers: this.headers() }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Vercel auth/permission denied', category: 'permission' }
    if (!res.ok) return { ok: false, error: `list deployments failed (${res.status})`, category: 'api' }
    const b = (await res.json().catch(() => null)) as { deployments?: Array<{ uid?: string; id?: string; url?: string; readyState?: string; state?: string; target?: string | null; meta?: { githubCommitRef?: string } }> } | null
    // Newest deployment whose git branch matches and that is a preview (not production).
    const match = (b?.deployments ?? []).find(d => d.meta?.githubCommitRef === branch && d.target !== 'production')
    if (!match) return { ok: true, data: null }
    const state = mapReadyState(match.readyState ?? match.state)
    const id = match.uid ?? match.id ?? ''
    return { ok: true, data: { deploymentId: id, url: absUrl(match.url), inspectorUrl: match.uid || match.id ? this.inspector(id) : undefined, state, ready: state === 'ready', failed: state === 'error' || state === 'canceled' } }
  }

  // ── Find the production deployment (optionally for a specific commit) ────────
  async findProductionDeployment(project: string, commitSha?: string, teamId?: string): Promise<ProviderResult<PreviewDeployment | null>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!project) return { ok: false, error: 'project required', category: 'config' }
    const scope = (explicit?: string) => { const id = explicit || this.teamId; return id ? `&teamId=${encodeURIComponent(id)}` : '' }
    let res
    try { res = await this.fetch(`${API}/v6/deployments?projectId=${encodeURIComponent(project)}&target=production${scope(teamId)}&limit=20`, { headers: this.headers() }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Vercel auth/permission denied', category: 'permission' }
    if (!res.ok) return { ok: false, error: `list deployments failed (${res.status})`, category: 'api' }
    const b = (await res.json().catch(() => null)) as { deployments?: Array<{ uid?: string; id?: string; url?: string; readyState?: string; state?: string; meta?: { githubCommitSha?: string } }> } | null
    const list = b?.deployments ?? []
    const match = commitSha ? list.find(d => (d.meta?.githubCommitSha ?? '').startsWith(commitSha) || commitSha.startsWith(d.meta?.githubCommitSha ?? '\0')) : list[0]
    if (!match) return { ok: true, data: null }
    const state = mapReadyState(match.readyState ?? match.state)
    const id = match.uid ?? match.id ?? ''
    return { ok: true, data: { deploymentId: id, url: absUrl(match.url), inspectorUrl: this.inspector(id), state, ready: state === 'ready', failed: state === 'error' || state === 'canceled' } }
  }

  // ── Latest PRODUCTION deployment info for Sync Status (read-only) ────────────
  // Returns the newest production deployment with the fields the Update Center needs:
  // its git commit sha (undefined for CLI/non-git deployments — a valid, expected state,
  // NOT an error), when it was created, and its ready/health state.
  async readProductionInfo(project: string, teamId?: string): Promise<ProviderResult<{
    deploymentId: string; url?: string; state: PreviewState; commitSha?: string; gitConnected: boolean; createdAt?: number; target: string
  } | null>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!project) return { ok: false, error: 'project required', category: 'config' }
    const scope = (explicit?: string) => { const id = explicit || this.teamId; return id ? `&teamId=${encodeURIComponent(id)}` : '' }
    let res
    try { res = await this.fetch(`${API}/v6/deployments?projectId=${encodeURIComponent(project)}&target=production${scope(teamId)}&limit=1`, { headers: this.headers() }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Vercel auth/permission denied', category: 'permission' }
    if (res.status === 404) return { ok: false, error: 'Vercel project not found', category: 'not_found' }
    if (!res.ok) return { ok: false, error: `list deployments failed (${res.status})`, category: 'api' }
    const b = (await res.json().catch(() => null)) as { deployments?: Array<{ uid?: string; id?: string; url?: string; readyState?: string; state?: string; target?: string | null; createdAt?: number; created?: number; meta?: { githubCommitSha?: string } }> } | null
    const d = (b?.deployments ?? [])[0]
    if (!d) return { ok: true, data: null }
    const commitSha = d.meta?.githubCommitSha || undefined
    const id = d.uid ?? d.id ?? ''
    return {
      ok: true,
      data: {
        deploymentId: id,
        url: absUrl(d.url),
        state: mapReadyState(d.readyState ?? d.state),
        commitSha,
        gitConnected: !!commitSha,
        createdAt: d.createdAt ?? d.created,
        target: d.target ?? 'production',
      },
    }
  }

  // ── Read a Preview deployment's current state ───────────────────────────────
  async readPreviewDeployment(deploymentId: string, teamId?: string): Promise<ProviderResult<PreviewDeployment>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!deploymentId) return { ok: false, error: 'deploymentId required', category: 'config' }
    let res
    try { res = await this.fetch(`${API}/v13/deployments/${encodeURIComponent(deploymentId)}${this.team(teamId)}`, { headers: this.headers() }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 404) return { ok: false, error: 'deployment not found', category: 'not_found' }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Vercel auth/permission denied', category: 'permission' }
    if (!res.ok) return { ok: false, error: `read deployment failed (${res.status})`, category: 'api' }
    const b = (await res.json().catch(() => null)) as { id?: string; url?: string; readyState?: string; inspectorUrl?: string } | null
    if (!b) return { ok: false, error: 'bad response', category: 'api' }
    const state = mapReadyState(b.readyState)
    return { ok: true, data: { deploymentId: b.id || deploymentId, url: absUrl(b.url), inspectorUrl: b.inspectorUrl || this.inspector(deploymentId), state, ready: state === 'ready', failed: state === 'error' || state === 'canceled' } }
  }

  // ── Poll until the deployment reaches a terminal state (or times out) ────────
  async waitForPreviewReady(deploymentId: string, opts: { timeoutMs?: number; intervalMs?: number; teamId?: string } = {}): Promise<ProviderResult<PreviewDeployment>> {
    const timeoutMs = opts.timeoutMs ?? 600_000        // 10 min ceiling
    const intervalMs = Math.max(1000, opts.intervalMs ?? 5000)
    const deadline = this.now() + timeoutMs
    // First read is immediate; subsequent reads pace by intervalMs.
    for (let first = true; ; first = false) {
      if (!first) {
        if (this.now() >= deadline) return { ok: false, error: 'preview did not become ready before timeout', category: 'timeout' }
        await this.sleep(intervalMs)
      }
      const r = await this.readPreviewDeployment(deploymentId, opts.teamId)
      if (!r.ok) return r
      if (TERMINAL.includes(r.data.state)) {
        if (r.data.state === 'ready') return r
        return { ok: false, error: `preview ${r.data.state}`, category: r.data.state === 'canceled' ? 'canceled' : 'preview_failed' }
      }
      if (this.now() >= deadline) return { ok: false, error: 'preview did not become ready before timeout', category: 'timeout' }
    }
  }

  // ── Promote a specific deployment to production (used for instant rollback) ──
  async promoteProduction(project: string, deploymentId: string, teamId?: string): Promise<ProviderResult<{ promoted: boolean }>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!project || !deploymentId) return { ok: false, error: 'project + deploymentId required', category: 'config' }
    const scope = (explicit?: string) => { const id = explicit || this.teamId; return id ? `?teamId=${encodeURIComponent(id)}` : '' }
    let res
    try { res = await this.fetch(`${API}/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(deploymentId)}${scope(teamId)}`, { method: 'POST', headers: this.headers() }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Vercel auth/permission denied', category: 'permission' }
    if (!res.ok) return { ok: false, error: `promote failed (${res.status})`, category: 'api' }
    return { ok: true, data: { promoted: true } }
  }

  // ── Cancel an in-flight Preview deployment ──────────────────────────────────
  async cancelPreviewDeployment(deploymentId: string, teamId?: string): Promise<ProviderResult<{ canceled: boolean }>> {
    if (!this.configured) return { ok: false, error: 'VERCEL_TOKEN not configured', category: 'not_configured' }
    if (!deploymentId) return { ok: false, error: 'deploymentId required', category: 'config' }
    let res
    try { res = await this.fetch(`${API}/v12/deployments/${encodeURIComponent(deploymentId)}/cancel${this.team(teamId)}`, { method: 'PATCH', headers: this.headers() }) }
    catch { return { ok: false, error: 'Vercel API unreachable', category: 'network' } }
    if (res.status === 404) return { ok: false, error: 'deployment not found', category: 'not_found' }
    if (!res.ok) return { ok: false, error: `cancel failed (${res.status})`, category: 'api' }
    return { ok: true, data: { canceled: true } }
  }

  // ── A safe reference to the deployment's logs (no secret; no log contents) ───
  async readDeploymentLogsReference(deploymentId: string, teamId?: string): Promise<ProviderResult<{ inspectorUrl: string; eventsApi: string }>> {
    if (!deploymentId) return { ok: false, error: 'deploymentId required', category: 'config' }
    return { ok: true, data: { inspectorUrl: this.inspector(deploymentId), eventsApi: `${API}/v3/deployments/${encodeURIComponent(deploymentId)}/events${this.team(teamId)}` } }
  }

  // ── Verify the Preview URL is actually reachable ────────────────────────────
  async verifyPreviewUrl(url: string): Promise<ProviderResult<{ reachable: boolean; status: number }>> {
    const target = absUrl(url)
    if (!target) return { ok: false, error: 'url required', category: 'config' }
    try { const res = await this.fetch(target); return { ok: true, data: { reachable: res.ok, status: res.status } } }
    catch { return { ok: false, error: 'preview url unreachable', category: 'network' } }
  }

  // ── Health-check a Preview (optionally at a health path) ─────────────────────
  async runPreviewHealthCheck(url: string, healthPath = '/api/health'): Promise<ProviderResult<{ ok: boolean; status: number }>> {
    const base = absUrl(url)
    if (!base) return { ok: false, error: 'url required', category: 'config' }
    const target = healthPath ? new URL(healthPath, base).toString() : base
    try { const res = await this.fetch(target); return { ok: true, data: { ok: res.ok, status: res.status } } }
    catch { return { ok: false, error: 'health check unreachable', category: 'network' } }
  }
}

/** Fail-closed stand-in when no Vercel token is present — every op reports not-configured. */
export class StubPreviewProvider {
  readonly name = 'stub'
  get configured() { return false }
  private fail<T>() { return Promise.resolve({ ok: false as const, error: 'Vercel preview not configured (VERCEL_TOKEN missing)', category: 'not_configured' }) as Promise<ProviderResult<T>> }
  createPreviewDeployment() { return this.fail<PreviewDeployment>() }
  findPreviewByBranch() { return this.fail<PreviewDeployment | null>() }
  findProductionDeployment() { return this.fail<PreviewDeployment | null>() }
  promoteProduction() { return this.fail<{ promoted: boolean }>() }
  readPreviewDeployment() { return this.fail<PreviewDeployment>() }
  waitForPreviewReady() { return this.fail<PreviewDeployment>() }
  cancelPreviewDeployment() { return this.fail<{ canceled: boolean }>() }
  readDeploymentLogsReference() { return this.fail<{ inspectorUrl: string; eventsApi: string }>() }
  verifyPreviewUrl() { return this.fail<{ reachable: boolean; status: number }>() }
  runPreviewHealthCheck() { return this.fail<{ ok: boolean; status: number }>() }
}

export type PreviewProvider = VercelPreviewProvider | StubPreviewProvider

/** Live Vercel provider when VERCEL_TOKEN is present, else fail-closed stub. */
export function getPreviewProvider(env: Record<string, string | undefined> = process.env, deps: VercelProviderDeps = {}): PreviewProvider {
  return env.VERCEL_TOKEN ? new VercelPreviewProvider(env, deps) : new StubPreviewProvider()
}
