// ── Operion Sync Status — unit + integration suite ───────────────────────────
//
// Unit tests cover the pure cores (baseline parse/generate, both status signals,
// registration validation, provider resolution). The integration test drives the
// FULL engine through the real provider adapters over a fake GitHub/Vercel `fetch`
// (a generated RSA key lets the GitHub App JWT sign), proving the wiring end-to-end —
// including the CLI-deployment "N/A + Verified" path.

import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'

import {
  parseBaselineMarker, generateBaselineMarker, serializeBaselineMarker, isCompatibleMarker,
} from '../app/lib/platform/sync/baseline'
import {
  computeDeploymentStatus, computePlatformSyncStatus, shortSha,
} from '../app/lib/platform/sync/engine-core'
import { validateAndBuildProduct } from '../app/lib/platform/sync/registry'
import { getSourceProvider, getDeploymentProvider } from '../app/lib/platform/sync/providers/registry'
import { reconcileProduct } from '../app/lib/platform/sync/engine'
import { recommendActions } from '../app/lib/platform/sync/service'
import type { SyncProduct } from '../app/lib/platform/sync/types'

// ── Baseline marker ────────────────────────────────────────────────────────────
test('baseline: parse valid marker', () => {
  const m = parseBaselineMarker('{"platform":"operion-core","baselineVersion":"1.2.0","baselineCommit":"abc123","generatedAt":"2026-01-01T00:00:00Z","compatibilityVersion":1}')
  assert.ok(m)
  assert.equal(m!.baselineVersion, '1.2.0')
  assert.equal(m!.baselineCommit, 'abc123')
})

test('baseline: malformed / missing fields → null', () => {
  assert.equal(parseBaselineMarker(''), null)
  assert.equal(parseBaselineMarker('not json'), null)
  assert.equal(parseBaselineMarker('{"platform":"operion-core"}'), null) // missing version/commit
  assert.equal(parseBaselineMarker('{"baselineVersion":"1","baselineCommit":"x"}'), null) // missing platform
})

test('baseline: generate + serialize round-trips and is compatible', () => {
  const m = generateBaselineMarker({ baselineVersion: '2.0.0', baselineCommit: 'deadbeef', generatedAt: '2026-07-17T00:00:00Z' })
  assert.equal(m.platform, 'operion-core')
  assert.equal(m.compatibilityVersion, 1)
  const round = parseBaselineMarker(serializeBaselineMarker(m))
  assert.deepEqual(round, m)
  assert.equal(isCompatibleMarker(m), true)
  assert.equal(isCompatibleMarker({ ...m, platform: 'other-core' }), false)
})

// ── Deployment status (pure) ────────────────────────────────────────────────────
test('deployment: not tracked → not_applicable', () => {
  const d = computeDeploymentStatus({ supportsTracking: false, gitConnected: false })
  assert.equal(d.applicable, false)
  assert.equal(d.state, 'not_applicable')
})

test('deployment: CLI (non-git) → N/A + Verified + upToDate, never an error', () => {
  const d = computeDeploymentStatus({ supportsTracking: true, gitConnected: false, environment: 'production', healthy: true })
  assert.equal(d.commitLabel, 'N/A (CLI Deployment)')
  assert.equal(d.statusLabel, 'Verified')
  assert.equal(d.upToDate, true)
  assert.equal(d.state, 'ok')
  assert.equal(d.health, 'healthy')
})

test('deployment: git-connected up to date vs behind', () => {
  const up = computeDeploymentStatus({ supportsTracking: true, gitConnected: true, deployedCommit: 'aaaaaaa', mainCommit: 'aaaaaaa', behindBy: 0 })
  assert.equal(up.upToDate, true)
  assert.equal(up.statusLabel, 'Up to date')
  assert.equal(up.state, 'ok')

  const behind = computeDeploymentStatus({ supportsTracking: true, gitConnected: true, deployedCommit: 'aaaaaaa', mainCommit: 'bbbbbbb', behindBy: 3 })
  assert.equal(behind.upToDate, false)
  assert.equal(behind.statusLabel, 'Behind by 3')
  assert.equal(behind.state, 'attention')
})

test('deployment: hard error → unknown', () => {
  const d = computeDeploymentStatus({ supportsTracking: true, gitConnected: true, error: 'Vercel auth/permission denied' })
  assert.equal(d.state, 'unknown')
  assert.equal(d.statusLabel, 'Unknown')
  assert.ok(d.error)
})

// ── Platform sync status (pure) ─────────────────────────────────────────────────
test('platform-sync: not supported → not_applicable', () => {
  const p = computePlatformSyncStatus({ supportsSync: false, sourceConfigured: false, markerFound: false })
  assert.equal(p.applicable, false)
  assert.equal(p.state, 'not_applicable')
})

test('platform-sync: no source configured → unknown', () => {
  const p = computePlatformSyncStatus({ supportsSync: true, sourceConfigured: false, markerFound: false })
  assert.equal(p.state, 'unknown')
  assert.equal(p.updateAvailable, false)
})

test('platform-sync: marker missing → update available, not safe', () => {
  const p = computePlatformSyncStatus({ supportsSync: true, sourceConfigured: true, markerFound: false })
  assert.equal(p.updateAvailable, true)
  assert.equal(p.safeToSync, false)
  assert.equal(p.state, 'attention')
})

test('platform-sync: behind by N (unknown compat) → update available, not auto-safe', () => {
  const p = computePlatformSyncStatus({
    supportsSync: true, sourceConfigured: true, markerFound: true,
    marker: { platform: 'operion-core', baselineVersion: '0.0.9', baselineCommit: 'old', generatedAt: '', compatibilityVersion: 1 },
    latestBaselineVersion: '0.1.0', latestBaselineCommit: 'new', commitsBehind: 5,
  })
  assert.equal(p.commitsBehind, 5)
  assert.equal(p.updateAvailable, true)
  assert.equal(p.compatibility, 'unknown')
  assert.equal(p.safeToSync, false)
  assert.equal(p.state, 'attention')
})

test('platform-sync: up to date → ok + compatible', () => {
  const p = computePlatformSyncStatus({
    supportsSync: true, sourceConfigured: true, markerFound: true,
    marker: { platform: 'operion-core', baselineVersion: '0.1.0', baselineCommit: 'new', generatedAt: '', compatibilityVersion: 1 },
    latestBaselineCommit: 'new', commitsBehind: 0,
  })
  assert.equal(p.updateAvailable, false)
  assert.equal(p.compatibility, 'compatible')
  assert.equal(p.state, 'ok')
})

test('platform-sync: explicit blocked compat is not safe even when behind', () => {
  const p = computePlatformSyncStatus({
    supportsSync: true, sourceConfigured: true, markerFound: true,
    marker: { platform: 'operion-core', baselineVersion: '1', baselineCommit: 'a', generatedAt: '', compatibilityVersion: 1 },
    commitsBehind: 2, compatibility: 'blocked',
  })
  assert.equal(p.safeToSync, false)
  assert.equal(p.compatibility, 'blocked')
})

// ── Registration validation ─────────────────────────────────────────────────────
test('registry: valid registration builds a product', () => {
  const r = validateAndBuildProduct({ id: 'acme', displayName: 'Acme', productType: 'branded_clone', githubOwner: 'o', githubRepo: 'r', platformSourceId: 'jkiss', supportsPlatformSync: true }, null, 1000)
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.product.id, 'acme')
    assert.equal(r.product.defaultBranch, 'main')
    assert.equal(r.product.deploymentProvider, 'vercel')
    assert.equal(r.product.createdAt, 1000)
  }
})

test('registry: rejects bad id, missing name, bad type, self-source', () => {
  assert.equal(validateAndBuildProduct({ displayName: 'x' }, null, 1).ok, false)                       // no id
  assert.equal(validateAndBuildProduct({ id: 'Bad Id', displayName: 'x' }, null, 1).ok, false)          // bad slug
  assert.equal(validateAndBuildProduct({ id: 'a', productType: 'branded_clone' }, null, 1).ok, false)   // no name
  assert.equal(validateAndBuildProduct({ id: 'a', displayName: 'x', productType: 'nope' }, null, 1).ok, false)
  assert.equal(validateAndBuildProduct({ id: 'a', displayName: 'x', platformSourceId: 'a' }, null, 1).ok, false)
})

test('registry: update preserves createdAt', () => {
  const existing: SyncProduct = { recordVersion: 1, id: 'a', displayName: 'A', productType: 'standalone', status: 'active', sourceProvider: 'github', defaultBranch: 'main', deploymentProvider: 'vercel', platformSourceId: null, supportsPlatformSync: false, supportsDeploymentTracking: true, createdAt: 500, updatedAt: 500 }
  const r = validateAndBuildProduct({ displayName: 'A2' }, existing, 900)
  assert.ok(r.ok)
  if (r.ok) { assert.equal(r.product.createdAt, 500); assert.equal(r.product.updatedAt, 900); assert.equal(r.product.displayName, 'A2') }
})

// ── Provider registry resolution ────────────────────────────────────────────────
test('providers: unknown ids resolve to fail-closed stubs', async () => {
  const src = getSourceProvider('mercurial', {})
  const r = await src.branchHead({ owner: 'o', name: 'r' }, 'main')
  assert.equal(r.ok, false)
  const dep = getDeploymentProvider('heroku', {})
  const d = await dep.productionDeployment('p')
  assert.equal(d.ok, false)
})

test('providers: cli deployment reports gitConnected:false (no error)', async () => {
  const dep = getDeploymentProvider('cli', {})
  const d = await dep.productionDeployment('anything')
  assert.equal(d.ok, true)
  if (d.ok) { assert.equal(d.data?.gitConnected, false); assert.equal(d.data?.state, 'ready') }
})

// ── recommendActions ────────────────────────────────────────────────────────────
test('recommendActions: no record vs current vs behind', () => {
  assert.match(recommendActions(null)[0], /Run a reconciliation/)
})

// ── Integration: full engine over a fake GitHub + Vercel ────────────────────────
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const ENV = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey as string, VERCEL_TOKEN: 'vt_test' }

type World = {
  branch: Record<string, string>
  marker: Record<string, string | null>
  compare: Record<string, { ahead_by: number; behind_by: number; status: string; total_commits: number }>
  deploy: Record<string, unknown>
}

function fakeFetch(world: World) {
  const j = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) })
  return async (url: string) => {
    const u = String(url)
    if (u.includes('/access_tokens')) return j(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3600e3).toISOString() })
    if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(u)) return j(200, { id: 4242 })
    let m = u.match(/\/repos\/([^/]+)\/([^/]+)\/branches\/([^/?]+)/)
    if (m) { const sha = world.branch[`${m[1]}/${m[2]}`]; return sha ? j(200, { commit: { sha, commit: { committer: { date: '2026-07-17T00:00:00Z' } } } }) : j(404, {}) }
    m = u.match(/\/repos\/([^/]+)\/([^/]+)\/compare\/([^.]+)\.\.\.(.+)$/)
    if (m) { const key = `${decodeURIComponent(m[3])}...${decodeURIComponent(m[4])}`; return j(200, world.compare[key] ?? { ahead_by: 0, behind_by: 0, status: 'identical', total_commits: 0 }) }
    m = u.match(/\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)\?ref=/)
    if (m) { const content = world.marker[`${m[1]}/${m[2]}`]; return content == null ? j(404, {}) : j(200, { content: Buffer.from(content).toString('base64'), encoding: 'base64' }) }
    if (u.includes('api.vercel.com') && u.includes('/deployments') && u.includes('target=production')) {
      const proj = decodeURIComponent((u.match(/projectId=([^&]+)/) ?? [])[1] ?? '')
      const dep = world.deploy[proj]
      return j(200, { deployments: dep ? [dep] : [] })
    }
    return j(200, {}) // health probe / other → reachable
  }
}

function product(over: Partial<SyncProduct>): SyncProduct {
  return {
    recordVersion: 1, id: 'x', displayName: 'X', productType: 'branded_clone', status: 'active',
    sourceProvider: 'github', defaultBranch: 'main', deploymentProvider: 'vercel',
    platformSourceId: null, supportsPlatformSync: false, supportsDeploymentTracking: true,
    createdAt: 0, updatedAt: 0, ...over,
  }
}

test('integration: branded clone — platform behind, deployment up to date', async () => {
  const source = product({ id: 'jkiss', displayName: 'J KISS', productType: 'platform_source', githubOwner: 'ratchetnu', githubRepo: 'jkissllc', supportsPlatformSync: false })
  const clone = product({
    id: 'supercharged', displayName: 'Supercharged', githubOwner: 'ratchetnu', githubRepo: 'supercharged',
    vercelProject: 'supercharged', productionUrl: 'https://superchargedenterprise.com',
    platformSourceId: 'jkiss', supportsPlatformSync: true, supportsDeploymentTracking: true,
  })
  const world: World = {
    branch: { 'ratchetnu/jkissllc': 'SRC_MAIN', 'ratchetnu/supercharged': 'SC_MAIN' },
    marker: {
      'ratchetnu/supercharged': JSON.stringify({ platform: 'operion-core', baselineVersion: '0.0.9', baselineCommit: 'SRC_OLD', generatedAt: '', compatibilityVersion: 1 }),
      'ratchetnu/jkissllc': JSON.stringify({ platform: 'operion-core', baselineVersion: '0.1.0', baselineCommit: 'SRC_MAIN', generatedAt: '', compatibilityVersion: 1 }),
    },
    compare: { 'SRC_OLD...SRC_MAIN': { ahead_by: 5, behind_by: 0, status: 'ahead', total_commits: 5 } },
    deploy: { supercharged: { uid: 'dpl1', url: 'superchargedenterprise.com', readyState: 'READY', target: 'production', createdAt: 1700000000000, meta: { githubCommitSha: 'SC_MAIN' } } },
  }
  const rec = await reconcileProduct(clone, source, { now: 1000, trigger: 'manual', env: ENV, fetch: fakeFetch(world) as never })

  // Deployment: deployed SC_MAIN == main SC_MAIN → up to date
  assert.equal(rec.deployment.applicable, true)
  assert.equal(rec.deployment.gitConnected, true)
  assert.equal(rec.deployment.deployedCommit, 'SC_MAIN')
  assert.equal(rec.deployment.mainCommit, 'SC_MAIN')
  assert.equal(rec.deployment.upToDate, true)
  assert.equal(rec.deployment.health, 'healthy')

  // Platform sync: marker SRC_OLD, source main SRC_MAIN, 5 behind
  assert.equal(rec.platformSync.applicable, true)
  assert.equal(rec.platformSync.currentBaselineVersion, '0.0.9')
  assert.equal(rec.platformSync.latestBaselineVersion, '0.1.0')
  assert.equal(rec.platformSync.commitsBehind, 5)
  assert.equal(rec.platformSync.updateAvailable, true)
  assert.equal(rec.platformSync.state, 'attention')
  assert.equal(rec.failed, false)
})

test('integration: CLI-deployed product → N/A commit + Verified, no error', async () => {
  const cli = product({ id: 'claimguard', displayName: 'ClaimGuard', productType: 'standalone', deploymentProvider: 'cli', supportsPlatformSync: false, supportsDeploymentTracking: true })
  const rec = await reconcileProduct(cli, null, { now: 2000, trigger: 'manual', env: ENV, fetch: fakeFetch({ branch: {}, marker: {}, compare: {}, deploy: {} }) as never })
  assert.equal(rec.deployment.commitLabel, 'N/A (CLI Deployment)')
  assert.equal(rec.deployment.statusLabel, 'Verified')
  assert.equal(rec.deployment.upToDate, true)
  assert.equal(rec.deployment.state, 'ok')
  assert.equal(rec.platformSync.applicable, false)
  assert.equal(rec.failed, false)
})

test('integration: source platform — platform sync N/A, deploy tracked', async () => {
  const source = product({ id: 'jkiss', displayName: 'J KISS', productType: 'platform_source', githubOwner: 'ratchetnu', githubRepo: 'jkissllc', vercelProject: 'jkissllc', productionUrl: 'https://jkissllc.com', supportsPlatformSync: false, supportsDeploymentTracking: true })
  const world: World = {
    branch: { 'ratchetnu/jkissllc': 'SRC_MAIN' },
    marker: {},
    compare: {},
    deploy: { jkissllc: { uid: 'd', url: 'jkissllc.com', readyState: 'READY', target: 'production', createdAt: 1, meta: { githubCommitSha: 'SRC_MAIN' } } },
  }
  const rec = await reconcileProduct(source, null, { now: 3000, trigger: 'cron', env: ENV, fetch: fakeFetch(world) as never })
  assert.equal(rec.platformSync.applicable, false)
  assert.equal(rec.platformSync.state, 'not_applicable')
  assert.equal(rec.deployment.upToDate, true)
  assert.equal(shortSha('SRC_MAINxxxx'), 'SRC_MAI')
})
