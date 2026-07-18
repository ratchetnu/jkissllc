// ── Publish Review — provider enrichment (server-only, READ-ONLY) ────────────
//
// Increment 3B.2D. Enriches the read-only Publish Review with VERIFIED provider data:
//   • the current READY production deployment from Vercel (GET only), and
//   • a GitHub compare (base = current production commit, head = approved candidate
//     commit) classified into areas + risk indicators.
//
// STRICT SAFETY:
//   • Only read methods are called — readProductionForReview + compareCommitsDetailed.
//     There is no code path here to promote, redeploy, rollback, alias, dispatch a
//     workflow, create a branch/PR/commit/check/comment, or mutate any env/KV.
//   • Each provider is independently fail-soft AND time-bounded — one being unavailable
//     never fails the whole review; missing data becomes an explicit `null` (→ the UI
//     renders "Unavailable") plus a SANITIZED warning. Raw provider errors and secrets
//     are never surfaced.
//   • A brief in-memory cache (keyed by business + project + base…head) avoids redundant
//     provider calls. It stores only already-public review data — never a secret, never
//     release state — and mutates nothing.

import { VercelPreviewProvider, getPreviewProvider, type PreviewProvider } from '../automation/vercel-provider'
import { GitHubActionsProvider } from '../automation/github-provider'
import type { RepoRef } from '../automation/provider'
import { classifyChangedFiles, type ChangeClassification, type ChangedFile } from './change-classification'

export type EnrichmentBusiness = {
  id: string
  repoName?: string
  repositoryOwner?: string
  repositoryNameOnly?: string
  githubInstallationId?: string
  productionProjectId?: string
  deployProject?: string
}

export type PublishReviewEnrichmentInput = {
  now: number
  business: EnrichmentBusiness | null
  /** Current production commit from local reconciliation (fallback base for the compare). */
  baseCommit?: string
  /** Approved candidate commit (compare head). */
  headCommit?: string
}

export type EnrichmentDeps = {
  env?: Record<string, string | undefined>
  fetch?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }>
  now?: () => number
  /** Per-provider soft timeout. Default 6s. */
  timeoutMs?: number
  /** Short-cache TTL. Default 60s. */
  cacheTtlMs?: number
  /** Set false to bypass the in-memory cache (tests). Default true. */
  cache?: boolean
}

export type ProductionEnrichment = {
  deploymentId?: string
  url?: string
  inspectorUrl?: string
  state?: string
  ready?: boolean
  commitSha?: string
  branch?: string
  createdAt?: number
  readyAt?: number
  target?: string
  project?: string
}

export type CompareEnrichment = ChangeClassification & {
  fileCount: number
  additions: number
  deletions: number
  totalCommits: number
  files: { filename: string; status: string; additions: number; deletions: number }[]
  truncated: boolean
  identical: boolean
}

export type ProviderStatus = 'ok' | 'unavailable' | 'not_configured' | 'skipped'

export type PublishReviewEnrichment = {
  production: ProductionEnrichment | null
  compare: CompareEnrichment | null
  warnings: string[]
  providers: { vercel: ProviderStatus; github: ProviderStatus }
}

const DEFAULT_TIMEOUT_MS = 6_000
const DEFAULT_CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 200

// ── In-memory short cache (public review data only; never secrets/state) ──────
const cacheStore = new Map<string, { at: number; value: PublishReviewEnrichment }>()

/** Test/maintenance hook — clear the enrichment cache. Never called on the request path. */
export function clearEnrichmentCache(): void { cacheStore.clear() }

function resolveRepo(b: EnrichmentBusiness): RepoRef | null {
  if (b.repositoryOwner && b.repositoryNameOnly) return { owner: b.repositoryOwner, name: b.repositoryNameOnly }
  if (b.repoName && b.repoName.includes('/')) {
    const [owner, ...rest] = b.repoName.split('/')
    const name = rest.join('/')
    if (owner && name) return { owner, name }
  }
  return null
}

/** Race a provider read against a soft timeout so the route never hangs on a slow provider. */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(onTimeout) } }, ms)
    work.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(onTimeout) } },
    )
  })
}

// ── Vercel: current READY production deployment (read-only) ───────────────────
async function readProduction(
  business: EnrichmentBusiness,
  vercel: PreviewProvider,
  timeoutMs: number,
  warnings: string[],
): Promise<{ data: ProductionEnrichment | null; status: ProviderStatus }> {
  const project = business.productionProjectId || business.deployProject
  if (!project) { warnings.push('current production deployment unavailable (no Vercel project mapped for this business)'); return { data: null, status: 'skipped' } }
  if (!(vercel instanceof VercelPreviewProvider) || !vercel.configured) { warnings.push('current production deployment unavailable (Vercel not configured)'); return { data: null, status: 'not_configured' } }

  const r = await withTimeout(vercel.readProductionForReview(project), timeoutMs, { ok: false as const, error: 'timeout', category: 'timeout' })
  if (!r.ok) { warnings.push('current production deployment unavailable (Vercel could not be read)'); return { data: null, status: 'unavailable' } }
  if (!r.data) { warnings.push('no READY production deployment found for this business'); return { data: null, status: 'ok' } }
  const d = r.data
  return {
    data: {
      deploymentId: d.deploymentId, url: d.url, inspectorUrl: d.inspectorUrl, state: d.state, ready: d.ready,
      commitSha: d.commitSha, branch: d.branch, createdAt: d.createdAt, readyAt: d.readyAt, target: d.target, project,
    },
    status: 'ok',
  }
}

// ── GitHub: verified compare base…head, then deterministic classification ─────
async function readCompare(
  business: EnrichmentBusiness,
  base: string | undefined,
  head: string | undefined,
  env: Record<string, string | undefined>,
  fetchImpl: EnrichmentDeps['fetch'],
  now: () => number,
  timeoutMs: number,
  warnings: string[],
): Promise<{ data: CompareEnrichment | null; status: ProviderStatus }> {
  if (!head) { warnings.push('change comparison unavailable (candidate commit unavailable)'); return { data: null, status: 'skipped' } }
  if (!base) { warnings.push('change comparison unavailable (current production commit unavailable)'); return { data: null, status: 'skipped' } }

  const repo = resolveRepo(business)
  if (!repo) { warnings.push('change comparison unavailable (no repository mapped for this business)'); return { data: null, status: 'skipped' } }

  const configured = !!env.GITHUB_APP_ID && !!env.GITHUB_APP_PRIVATE_KEY
  if (!configured) { warnings.push('change comparison unavailable (GitHub not configured)'); return { data: null, status: 'not_configured' } }

  // Identical commits — nothing changed; report it truthfully without a provider call.
  if (base === head) {
    return { data: { fileCount: 0, additions: 0, deletions: 0, totalCommits: 0, files: [], truncated: false, identical: true, changedAreas: [], workflowChange: false, migrationChange: false, envConfigChange: false, highRisk: false, highRiskFiles: [] }, status: 'ok' }
  }

  const gh = new GitHubActionsProvider(env, { fetch: fetchImpl, now })
  const install = await resolveInstallation(gh, business, repo, timeoutMs)
  if (!install) { warnings.push('change comparison unavailable (GitHub installation could not be resolved)'); return { data: null, status: 'unavailable' } }

  const r = await withTimeout(gh.compareCommitsDetailed(install, repo, base, head), timeoutMs, { ok: false as const, error: 'timeout', category: 'timeout' })
  if (!r.ok) {
    warnings.push(r.category === 'not_found'
      ? 'change comparison unavailable (a commit could not be found in the repository)'
      : 'change comparison unavailable (GitHub compare could not be read)')
    return { data: null, status: 'unavailable' }
  }
  const files: ChangedFile[] = r.data.files
  const cls = classifyChangedFiles(files)
  if (r.data.truncated) warnings.push('change comparison is large — file list truncated by GitHub (counts may be partial)')
  return {
    data: {
      fileCount: r.data.fileCount, additions: r.data.additions, deletions: r.data.deletions, totalCommits: r.data.totalCommits,
      files: r.data.files, truncated: r.data.truncated, identical: false, ...cls,
    },
    status: 'ok',
  }
}

async function resolveInstallation(gh: GitHubActionsProvider, business: EnrichmentBusiness, repo: RepoRef, timeoutMs: number): Promise<string | null> {
  if (business.githubInstallationId) return business.githubInstallationId
  const r = await withTimeout(gh.getRepoInstallation(repo), timeoutMs, { ok: false as const, error: 'timeout', category: 'timeout' })
  return r.ok ? r.data.installationId : null
}

/**
 * Enrich a Publish Review with verified provider data. Always resolves (never throws):
 * partial or empty enrichment on any failure, with sanitized warnings.
 */
export async function enrichPublishReview(input: PublishReviewEnrichmentInput, deps: EnrichmentDeps = {}): Promise<PublishReviewEnrichment> {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const useCache = deps.cache !== false

  const empty: PublishReviewEnrichment = { production: null, compare: null, warnings: [], providers: { vercel: 'skipped', github: 'skipped' } }
  const b = input.business
  if (!b) return empty

  const project = b.productionProjectId || b.deployProject || '-'
  const cacheKey = `${b.id}|${project}|${input.baseCommit ?? '-'}|${input.headCommit ?? '-'}`
  if (useCache) {
    const hit = cacheStore.get(cacheKey)
    if (hit && now() - hit.at < ttl) return hit.value
  }

  const warnings: string[] = []
  const vercel = getPreviewProvider(env, { fetch: deps.fetch, now })

  // Vercel first — its verified production commit is the most truthful compare base.
  const prod = await readProduction(b, vercel, timeoutMs, warnings)
  const base = prod.data?.commitSha || input.baseCommit
  const cmp = await readCompare(b, base, input.headCommit, env, deps.fetch, now, timeoutMs, warnings)

  const value: PublishReviewEnrichment = {
    production: prod.data,
    compare: cmp.data,
    warnings,
    providers: { vercel: prod.status, github: cmp.status },
  }

  if (useCache) {
    if (cacheStore.size >= MAX_CACHE_ENTRIES) cacheStore.clear()
    cacheStore.set(cacheKey, { at: now(), value })
  }
  return value
}
