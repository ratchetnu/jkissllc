// Increment 3B.2D — Publish Review provider ENRICHMENT tests.
//
// Covers: deterministic change classification; the two additive READ-ONLY provider
// methods (Vercel readProductionForReview, GitHub compareCommitsDetailed); the fail-soft,
// time-bounded enrichment orchestrator; builder integration; and STATIC provider-safety
// guarantees that fail if any write method / write endpoint is introduced. Fully hermetic:
// every provider HTTP call is mocked, no live calls, no writes, no secrets surfaced.
import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

import { classifyChangedFiles } from '../app/lib/platform/release/change-classification'
import { VercelPreviewProvider, StubPreviewProvider } from '../app/lib/platform/automation/vercel-provider'
import { GitHubActionsProvider } from '../app/lib/platform/automation/github-provider'
import { enrichPublishReview, clearEnrichmentCache } from '../app/lib/platform/release/publish-review-enrichment'
import { buildPublishReview, type BuildPublishReviewInput } from '../app/lib/platform/release/build-publish-review'
import type { EligibilityResult } from '../app/lib/platform/release/promotion-eligibility'

// ── Mock fetch (records calls; matches by URL substring) ──────────────────────
type Resp = { status: number; body: unknown }
type Route = [string, (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Resp]
function mockFetch(routes: Route[]) {
  const calls: { url: string; method: string }[] = []
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() })
    for (const [pat, resp] of routes) if (url.includes(pat)) { const r = resp(url, init); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) } }
    return { status: 404, ok: false, json: async () => ({}), text: async () => '{}' }
  }
  return { fetch: fetch as never, calls }
}

const T = 1_700_000_000_000
const KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const ENV = { VERCEL_TOKEN: 'vc_secret', VERCEL_TEAM_ID: 'team_x', GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: KP.privateKey }
const REPO = { owner: 'ratchetnu', name: 'supercharged' }
const tokenRoute: Route = ['/access_tokens', () => ({ status: 201, body: { token: 'ghs_secret', expires_at: new Date(T + 3600_000).toISOString() } })]

const BUSINESS = {
  id: 'supercharged', repoName: 'ratchetnu/supercharged', githubInstallationId: '999',
  productionProjectId: 'prj_super', deployProject: 'prj_super',
}

// ── Phase 4 — deterministic change classification ─────────────────────────────
test('classify: areas map deterministically, most-specific wins', () => {
  const c = classifyChangedFiles([
    { filename: '.github/workflows/deploy.yml' },
    { filename: 'app/lib/platform/db/migrations/0007_add.sql' },
    { filename: 'app/api/admin/x/route.ts' },
    { filename: 'app/components/Button.tsx' },
    { filename: 'README.md' },
    { filename: 'package-lock.json' },
  ])
  assert.deepEqual(c.changedAreas, ['api', 'application', 'database/migrations', 'dependencies', 'documentation', 'github workflows'])
})

test('classify: workflow / migration / env indicators are exact path matches', () => {
  const wf = classifyChangedFiles([{ filename: '.github/workflows/ci.yml' }])
  assert.equal(wf.workflowChange, true)
  assert.equal(wf.highRiskFiles.some((h) => h.category === 'github workflow' && h.file === '.github/workflows/ci.yml'), true)

  const mig = classifyChangedFiles([{ filename: 'db/migrations/001_init.sql' }])
  assert.equal(mig.migrationChange, true)
  assert.equal(mig.highRiskFiles.some((h) => h.category === 'database migration'), true)

  const env = classifyChangedFiles([{ filename: '.env.production' }, { filename: 'vercel.json' }])
  assert.equal(env.envConfigChange, true)
  assert.equal(env.highRisk, true)
  assert.equal(env.highRiskFiles.some((h) => h.category === 'environment configuration' && h.file === '.env.production'), true)
  assert.equal(env.highRiskFiles.some((h) => h.category === 'deployment configuration' && h.file === 'vercel.json'), true)
})

test('classify: auth, middleware, release-engine, promotion → high-risk with file evidence', () => {
  const c = classifyChangedFiles([
    { filename: 'app/api/admin/_lib/session.ts' },
    { filename: 'middleware.ts' },
    { filename: 'app/lib/platform/release/promotion-eligibility.ts' },
  ])
  const cats = c.highRiskFiles.map((h) => h.category)
  assert.equal(cats.includes('authentication/authorization'), true)
  assert.equal(cats.includes('middleware'), true)
  assert.equal(cats.includes('release-engine code'), true)
  assert.equal(cats.includes('production promotion code'), true)
  for (const h of c.highRiskFiles) assert.ok(h.file, 'every indicator carries exact file evidence')
})

test('classify: benign changes carry no high-risk indicators', () => {
  const c = classifyChangedFiles([{ filename: 'app/components/Card.tsx' }, { filename: 'docs/guide.md' }])
  assert.equal(c.highRisk, false)
  assert.equal(c.workflowChange, false)
  assert.equal(c.migrationChange, false)
  assert.equal(c.envConfigChange, false)
})

test('classify: empty input is safe', () => {
  const c = classifyChangedFiles([])
  assert.deepEqual(c.changedAreas, [])
  assert.equal(c.highRisk, false)
})

// ── Phase 2 — Vercel readProductionForReview (READ-ONLY) ──────────────────────
const prodListRoute = (deployments: unknown[]): Route => ['/v6/deployments', () => ({ status: 200, body: { deployments } })]

test('vercel: selects the latest READY production deployment; ignores preview + failed', async () => {
  const m = mockFetch([prodListRoute([
    { uid: 'dpl_building', readyState: 'BUILDING', target: 'production', createdAt: T + 3000, meta: { githubCommitSha: 'aaa' } },
    { uid: 'dpl_ready_new', url: 'super.vercel.app', readyState: 'READY', target: 'production', createdAt: T + 2000, ready: T + 2500, meta: { githubCommitSha: 'newprod', githubCommitRef: 'main' } },
    { uid: 'dpl_ready_old', readyState: 'READY', target: 'production', createdAt: T + 1000, meta: { githubCommitSha: 'oldprod' } },
    { uid: 'dpl_preview', readyState: 'READY', target: null, createdAt: T + 4000, meta: { githubCommitSha: 'prev' } },
  ])])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const r = await p.readProductionForReview('prj_super')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.data?.deploymentId, 'dpl_ready_new')       // newest READY production
  assert.equal(r.ok && r.data?.commitSha, 'newprod')
  assert.equal(r.ok && r.data?.branch, 'main')
  assert.equal(r.ok && r.data?.ready, true)
  assert.equal(r.ok && r.data?.target, 'production')
  // Only the production-scoped GET list endpoint was hit.
  assert.equal(m.calls.every((c) => c.method === 'GET'), true)
  assert.equal(m.calls.every((c) => c.url.includes('target=production')), true)
})

test('vercel: no READY production deployment → null (Unavailable), not a guess', async () => {
  const m = mockFetch([prodListRoute([{ uid: 'x', readyState: 'BUILDING', target: 'production', createdAt: T }])])
  const r = await new VercelPreviewProvider(ENV, { fetch: m.fetch }).readProductionForReview('prj_super')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.data, null)
})

test('vercel: 401/403/404/500 map to sanitized categories', async () => {
  for (const [status, cat] of [[401, 'permission'], [403, 'permission'], [404, 'not_found'], [500, 'api']] as const) {
    const m = mockFetch([['/v6/deployments', () => ({ status, body: {} })]])
    const r = await new VercelPreviewProvider(ENV, { fetch: m.fetch }).readProductionForReview('prj_super')
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.category, cat)
    assert.equal(!r.ok && /vc_secret|Bearer/i.test(r.error), false, 'no token in error')
  }
})

test('vercel: StubPreviewProvider.readProductionForReview fails closed', async () => {
  const r = await new StubPreviewProvider().readProductionForReview()
  assert.equal(r.ok, false)
})

// ── Phase 3 — GitHub compareCommitsDetailed (READ-ONLY) ───────────────────────
const compareRoute = (body: unknown): Route => ['/compare/', () => ({ status: 200, body })]

test('github: detailed compare maps files + sums additions/deletions + commit count', async () => {
  const m = mockFetch([tokenRoute, compareRoute({
    status: 'ahead', ahead_by: 3, behind_by: 0, total_commits: 3,
    files: [
      { filename: 'app/a.ts', status: 'modified', additions: 10, deletions: 2 },
      { filename: 'app/b.ts', status: 'added', additions: 5, deletions: 0 },
    ],
  })])
  const gh = new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => T })
  const r = await gh.compareCommitsDetailed('999', REPO, 'base', 'head')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.data.fileCount, 2)
  assert.equal(r.ok && r.data.additions, 15)
  assert.equal(r.ok && r.data.deletions, 2)
  assert.equal(r.ok && r.data.totalCommits, 3)
  assert.equal(r.ok && r.data.truncated, false)
  // read path only: the compare endpoint is a GET; the only POST is the App-auth token exchange.
  const nonAuthWrites = m.calls.filter((c) => c.method !== 'GET' && !c.url.includes('/access_tokens'))
  assert.deepEqual(nonAuthWrites, [])
})

test('github: partial file records default missing additions/deletions to 0', async () => {
  const m = mockFetch([tokenRoute, compareRoute({ total_commits: 1, files: [{ filename: 'x.ts' }] })])
  const r = await new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => T }).compareCommitsDetailed('999', REPO, 'b', 'h')
  assert.equal(r.ok && r.data.additions, 0)
  assert.equal(r.ok && r.data.deletions, 0)
  assert.equal(r.ok && r.data.files[0].status, 'modified')
})

test('github: missing commit (404) surfaces not_found; no token leaked', async () => {
  const m = mockFetch([tokenRoute, ['/compare/', () => ({ status: 404, body: {} })]])
  const r = await new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => T }).compareCommitsDetailed('999', REPO, 'b', 'h')
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.category, 'not_found')
  assert.equal(!r.ok && /ghs_secret|Bearer/i.test(r.error), false)
})

// ── Phases 2+3+4+5+6 — enrichment orchestrator ────────────────────────────────
const fullFetch = () => mockFetch([
  tokenRoute,
  prodListRoute([{ uid: 'dpl_prod', url: 'super.vercel.app', readyState: 'READY', target: 'production', createdAt: T + 1000, ready: T + 1500, meta: { githubCommitSha: 'prodsha', githubCommitRef: 'main' } }]),
  compareRoute({ ahead_by: 2, total_commits: 2, files: [{ filename: 'app/api/x/route.ts', status: 'modified', additions: 4, deletions: 1 }, { filename: '.github/workflows/ci.yml', status: 'modified', additions: 1, deletions: 0 }] }),
])

test('enrich: full enrichment — Vercel prod + GitHub compare + classification', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'localbase', headCommit: 'candsha' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.production?.deploymentId, 'dpl_prod')
  assert.equal(e.production?.commitSha, 'prodsha')
  assert.equal(e.compare?.fileCount, 2)
  assert.equal(e.compare?.additions, 5)
  assert.equal(e.compare?.workflowChange, true)
  assert.equal(e.compare?.changedAreas.includes('api'), true)
  assert.equal(e.providers.vercel, 'ok')
  assert.equal(e.providers.github, 'ok')
  // The verified Vercel prod commit becomes the compare BASE (preferred over localbase).
  assert.equal(m.calls.some((c) => c.url.includes('/compare/prodsha...candsha')), true)
})

test('enrich: Vercel-only (GitHub not configured) → production ok, compare Unavailable', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'h' }, { env: { VERCEL_TOKEN: 'vc_secret' }, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.production?.deploymentId, 'dpl_prod')
  assert.equal(e.compare, null)
  assert.equal(e.providers.github, 'not_configured')
  assert.ok(e.warnings.some((w) => /GitHub not configured/.test(w)))
})

test('enrich: GitHub-only (no Vercel project mapped) → compare ok, production Unavailable', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const biz = { ...BUSINESS, productionProjectId: undefined, deployProject: undefined }
  const e = await enrichPublishReview({ now: T, business: biz, baseCommit: 'localbase', headCommit: 'candsha' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.production, null)
  assert.equal(e.providers.vercel, 'skipped')
  assert.equal(e.compare?.fileCount, 2)                     // uses localbase as base
  assert.ok(e.warnings.some((w) => /no Vercel project mapped/.test(w)))
})

test('enrich: both providers unavailable → empty, review still enrichable', async () => {
  clearEnrichmentCache()
  const m = mockFetch([['/v6/deployments', () => ({ status: 500, body: {} })], tokenRoute, ['/compare/', () => ({ status: 500, body: {} })]])
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'h' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.production, null)
  assert.equal(e.compare, null)
  assert.equal(e.providers.vercel, 'unavailable')
  assert.equal(e.providers.github, 'unavailable')
  assert.ok(e.warnings.length >= 2)
})

test('enrich: identical commits → no GitHub call, identical=true', async () => {
  clearEnrichmentCache()
  // Vercel prod commit === candidate head → base === head.
  const m = mockFetch([tokenRoute, prodListRoute([{ uid: 'dpl_prod', readyState: 'READY', target: 'production', createdAt: T, meta: { githubCommitSha: 'samesha' } }]), compareRoute({ files: [] })])
  const e = await enrichPublishReview({ now: T, business: BUSINESS, headCommit: 'samesha' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.compare?.identical, true)
  assert.equal(e.compare?.fileCount, 0)
  assert.equal(m.calls.some((c) => c.url.includes('/compare/')), false, 'no compare API call for identical commits')
})

test('enrich: missing candidate commit → compare skipped with sanitized warning', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: undefined }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.compare, null)
  assert.equal(e.providers.github, 'skipped')
  assert.ok(e.warnings.some((w) => /candidate commit unavailable/.test(w)))
})

test('enrich: missing repository mapping → compare skipped', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const biz = { ...BUSINESS, repoName: undefined, repositoryOwner: undefined, repositoryNameOnly: undefined }
  const e = await enrichPublishReview({ now: T, business: biz, baseCommit: 'b', headCommit: 'h' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.compare, null)
  assert.ok(e.warnings.some((w) => /no repository mapped/.test(w)))
})

test('enrich: missing credentials → both not_configured, no calls', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'h' }, { env: {}, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.providers.vercel, 'not_configured')
  assert.equal(e.providers.github, 'not_configured')
  assert.equal(m.calls.length, 0)
})

test('enrich: slow provider times out → Unavailable (never hangs)', async () => {
  clearEnrichmentCache()
  const hang = async () => new Promise<never>(() => {})       // never resolves
  const m = mockFetch([['/v6/deployments', () => ({ status: 200, body: { deployments: [] } })]])
  const fetch = (async (url: string, init?: unknown) => (url.includes('/compare/') || url.includes('/access_tokens')) ? hang() : (m.fetch as (u: string, i?: unknown) => Promise<unknown>)(url, init)) as never
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'h' }, { env: ENV, fetch, now: () => T, timeoutMs: 15, cache: false })
  assert.equal(e.providers.github, 'unavailable')
  assert.ok(e.warnings.some((w) => /GitHub/.test(w)))
})

test('enrich: malformed provider response degrades safely', async () => {
  clearEnrichmentCache()
  const m = mockFetch([['/v6/deployments', () => ({ status: 200, body: { not: 'what we expect' } })], tokenRoute, compareRoute({})])
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'h' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  assert.equal(e.production, null)                             // no deployments array → null
  assert.equal(e.compare?.fileCount, 0)                        // empty compare → 0 files, still ok
})

test('enrich: brief cache avoids a second provider round-trip', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const input = { now: T, business: BUSINESS, baseCommit: 'localbase', headCommit: 'candsha' }
  await enrichPublishReview(input, { env: ENV, fetch: m.fetch, now: () => T, cache: true })
  const first = m.calls.length
  await enrichPublishReview(input, { env: ENV, fetch: m.fetch, now: () => T + 1000, cache: true })   // within TTL
  assert.equal(m.calls.length, first, 'second call served from cache — no new provider requests')
  clearEnrichmentCache()
})

test('enrich: no token / secret ever appears in the enrichment payload', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  const e = await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'candsha' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  const blob = JSON.stringify(e).toLowerCase()
  for (const bad of ['vc_secret', 'ghs_secret', 'bearer', 'authorization', 'private_key', 'begin rsa', 'token']) {
    assert.equal(blob.includes(bad), false, `enrichment leaked "${bad}"`)
  }
})

test('enrich: only READ endpoints are ever called (no write verbs, no write paths)', async () => {
  clearEnrichmentCache()
  const m = fullFetch()
  await enrichPublishReview({ now: T, business: BUSINESS, baseCommit: 'b', headCommit: 'candsha' }, { env: ENV, fetch: m.fetch, now: () => T, cache: false })
  for (const c of m.calls) {
    // The ONLY non-GET is the GitHub App-auth token exchange (not a repo/deploy write).
    if (c.method !== 'GET') assert.ok(c.url.includes('/access_tokens'), `unexpected ${c.method} to ${c.url}`)
    // No Vercel/GitHub write endpoints.
    for (const w of ['/promote/', '/cancel', '/dispatches', '/git/refs', '/pulls', '/merge', '/check-runs', 'target=production&', 'redeploy', '/alias']) {
      if (w === 'target=production&') continue
      assert.equal(c.url.includes(w) && c.method !== 'GET', false, `write endpoint ${w} must never be POST/PATCHed`)
    }
  }
})

// ── Phase 6 — builder integration with the compare enrichment ─────────────────
const eligibleResult: EligibilityResult = {
  eligible: true, reasons: [], warnings: [],
  requirements: [{ category: 'authorization', name: 'Owner permission', ok: true }],
  evaluatedAt: 1_000, candidate: null,
}
const builderInput = (over: Partial<BuildPublishReviewInput> = {}): BuildPublishReviewInput => ({
  now: 2_000_000, ownerSub: 'owner',
  business: { id: 'supercharged', name: 'Supercharged', status: 'active', currentVersion: '1.0.0' },
  testOnly: false,
  job: { id: 'AUTO-9', status: 'awaiting_owner_review', targetCommit: 'newsha7', workBranch: 'operion/upd-9', pullRequestUrl: 'https://github.com/ratchetnu/supercharged/pull/3', updatedAt: 1_990_000 },
  currentProduction: { deploymentId: 'dpl_prod', url: 'https://super.vercel.app', deployedAt: 1_500_000, deployedCommit: 'oldsha1', version: '1.0.0', readyState: 'ready' },
  candidate: { version: '1.1.0', commit: 'newsha7', branch: 'operion/upd-9' },
  update: { rollbackSupported: true },
  eligibility: eligibleResult,
  ...over,
})

test('builder: compare enrichment populates filesChanged with verified counts + evidence', () => {
  const r = buildPublishReview(builderInput({
    changeCompare: {
      fileCount: 2, additions: 9, deletions: 3, totalCommits: 2, truncated: false, identical: false,
      files: [{ filename: 'app/api/x/route.ts', status: 'modified', additions: 8, deletions: 3 }, { filename: '.github/workflows/ci.yml', status: 'modified', additions: 1, deletions: 0 }],
      changedAreas: ['api', 'github workflows'], workflowChange: true, migrationChange: false, envConfigChange: false,
      highRisk: true, highRiskFiles: [{ category: 'github workflow', file: '.github/workflows/ci.yml' }],
    },
  }))
  const fc = r.review!.filesChanged
  assert.equal(fc.available, true)
  assert.equal(fc.fileCount, 2)
  assert.equal(fc.additions, 9)
  assert.equal(fc.deletions, 3)
  assert.equal(fc.commitCount, 2)
  assert.equal(fc.workflowChange, true)
  assert.equal(fc.highRiskFiles, true)
  assert.deepEqual(fc.highRiskDetails, [{ category: 'github workflow', file: '.github/workflows/ci.yml' }])
  assert.deepEqual(fc.changedFilePaths, ['app/api/x/route.ts', '.github/workflows/ci.yml'])
})

test('builder: without compare enrichment, filesChanged stays Unavailable (3B.2C behavior)', () => {
  const fc = buildPublishReview(builderInput({ changeCompare: null })).review!.filesChanged
  assert.equal(fc.available, false)
  assert.equal(fc.additions, undefined)
})

test('builder: verified Vercel production populates rollback readiness metadata', () => {
  const rb = buildPublishReview(builderInput()).review!.rollback
  assert.equal(rb.ready, true)
  assert.equal(rb.targetDeploymentId, 'dpl_prod')
  assert.equal(rb.targetUrl, 'https://super.vercel.app')
  assert.equal(rb.targetCommit, 'oldsha1')
  assert.equal(rb.targetDeployedAt, 1_500_000)
  assert.equal(rb.metadataComplete, true)
})

test('builder: production deployment without git commit → partial rollback metadata + warning', () => {
  const rb = buildPublishReview(builderInput({ currentProduction: { deploymentId: 'dpl_prod', url: 'https://s.vercel.app', deployedCommit: undefined, deployedAt: undefined, version: '1.0.0' } })).review!.rollback
  assert.equal(rb.ready, true)
  assert.equal(rb.metadataComplete, false)
  assert.ok(rb.warnings?.some((w) => /no linked git commit/.test(w)))
})

test('builder: identical compare renders a "no changes" summary', () => {
  const fc = buildPublishReview(builderInput({ changeCompare: { fileCount: 0, additions: 0, deletions: 0, totalCommits: 0, files: [], truncated: false, identical: true, changedAreas: [], workflowChange: false, migrationChange: false, envConfigChange: false, highRisk: false, highRiskFiles: [] } })).review!.filesChanged
  assert.equal(fc.available, true)
  assert.equal(fc.identical, true)
  assert.match(fc.summary, /No changes/)
})

test('builder: backward-compatible — legacy input (no enrichment) still resolves', () => {
  const r = buildPublishReview(builderInput({ changeCompare: undefined, currentProduction: null }))
  assert.equal(r.ok, true)
  assert.equal(r.review!.filesChanged.available, false)
  assert.equal(r.review!.rollback.ready, false)
})

// ── Phase 7 — STATIC provider-safety guarantees (fail if a write is introduced) ─
function src(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8') }

test('safety: enrichment module calls ONLY read provider methods', () => {
  const s = src('../app/lib/platform/release/publish-review-enrichment.ts')
  // uses only the read methods
  assert.match(s, /readProductionForReview/)
  assert.match(s, /compareCommitsDetailed/)
  // never references any write/execution method
  for (const forbidden of ['promoteProduction', 'createPreviewDeployment', 'cancelPreviewDeployment', 'dispatchWorkflow', 'createBranch', 'createPullRequest', 'mergePullRequest', 'cancelJob', 'saveBusiness', 'saveReconciliation', 'redis.set', 'redis.zadd']) {
    assert.equal(s.includes(forbidden), false, `enrichment must not reference ${forbidden}`)
  }
})

test('safety: readProductionForReview + compareCommitsDetailed issue GET only', () => {
  const v = src('../app/lib/platform/automation/vercel-provider.ts')
  // Isolate the review reader and assert it declares no POST/PATCH/DELETE.
  const body = v.slice(v.indexOf('readProductionForReview'), v.indexOf('readPreviewDeployment'))
  for (const w of ["method: 'POST'", "method: 'PATCH'", "method: 'DELETE'"]) assert.equal(body.includes(w), false, `readProductionForReview must not ${w}`)
  const g = src('../app/lib/platform/automation/github-provider.ts')
  const cmp = g.slice(g.indexOf('compareCommitsDetailed'), g.indexOf('readBranchHead'))
  assert.match(cmp, /this\.get\(/)                             // read helper
  for (const w of ["method: 'POST'", "method: 'PUT'", "method: 'PATCH'", "method: 'DELETE'"]) assert.equal(cmp.includes(w), false)
})

test('safety: route stays read-only after enrichment (no writes/exec/dispatch/promote)', () => {
  const s = src('../app/api/admin/release/businesses/[id]/publish-review/route.ts')
  assert.match(s, /requirePlatformOwner/)
  assert.match(s, /no-store/)
  assert.match(s, /enrichPublishReview/)
  for (const forbidden of ['saveBusiness', 'saveProduct', 'saveReconciliation', 'saveUpdate', 'redis.set', 'redis.zadd', 'dispatchWorkflow', 'promoteProduction', 'mergePullRequest', 'createPullRequest', 'createBranch', 'approveProduction', 'advancePromotion', 'transitionJob']) {
    assert.equal(s.includes(forbidden), false, `route must not call ${forbidden}`)
  }
  assert.equal(/process\.env\.KV_REST_API|process\.env\.GITHUB_APP|process\.env\.VERCEL_TOKEN/.test(s), false)
})

test('safety: UI drawer has no approval / publish / execution controls', () => {
  const s = src('../app/admin/operations/release/PublishReviewDrawer.tsx')
  // No execution handler PROPS of any kind (match `on…=` so composed panel component
  // names like <ProductionPublishPanel/> are not false positives).
  for (const bad of ['onApprove=', 'onPublish=', 'onPromote=', 'onConfirm=', 'onRollback=', 'Retry production', 'method: \'POST\'', 'method: "POST"']) {
    assert.equal(s.includes(bad), false, `drawer must not contain "${bad}"`)
  }
  // The ONLY control is the read-only Refresh button (repeats the GET). No action-button labels.
  for (const label of ['>Publish<', '>Approve<', '>Promote<', '>Confirm', '>Roll back<', '>Rollback<']) {
    assert.equal(s.includes(label), false, `drawer must not render a "${label}" control`)
  }
  const buttons = s.match(/<Button[\s\S]*?<\/Button>/g) ?? []
  assert.equal(buttons.length, 1, 'exactly one button (Refresh)')
  assert.match(buttons[0], /Refresh/)
  // The drawer performs only a GET fetch — no mutation verb.
  assert.equal(/fetch\([^)]*method:\s*['"](POST|PUT|PATCH|DELETE)/.test(s), false)
})
