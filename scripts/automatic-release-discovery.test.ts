import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { signCallback } from '../app/lib/platform/automation/callback'
import {
  discoveryMatchesSourceBusiness, discoveredUpdateFromGitHub, validateGitHubDiscoveryPayload,
  type GitHubDiscoveryPayload,
} from '../app/lib/platform/updates/discovery'
import { saveDiscoveredUpdate } from '../app/lib/platform/updates/store'
import type { PlatformBusiness, PlatformUpdate } from '../app/lib/platform/updates/types'

const T = 1_800_000_000_000
const SHA = 'a'.repeat(40)
const BEFORE = 'b'.repeat(40)
const payload = (patch: Partial<GitHubDiscoveryPayload> = {}): GitHubDiscoveryPayload => ({
  deliveryId: 'push:123:1',
  repository: 'ratchetnu/jkissllc',
  ref: 'refs/heads/main',
  before: BEFORE,
  after: SHA,
  title: 'feat(settings): add automatic update discovery',
  commitMessage: 'feat(settings): add automatic update discovery\n\nThe owner still approves production.',
  changedFiles: ['app/api/automation/discover/route.ts', 'app/lib/platform/updates/discovery.ts'],
  changedFileCount: 2,
  filesTruncated: false,
  pullRequestNumber: 210,
  pullRequestUrl: 'https://github.com/ratchetnu/jkissllc/pull/210',
  workflowRunId: '9988',
  ...patch,
})

const sourceBusiness: Pick<PlatformBusiness, 'role' | 'repoName' | 'defaultBranch'> = {
  role: 'source', repoName: 'ratchetnu/jkissllc', defaultBranch: 'main',
}

test('validates a pinned main-branch event and rejects unsafe or ambiguous input', () => {
  const good = validateGitHubDiscoveryPayload(payload())
  assert.equal(good.ok, true)
  const bad = [
    payload({ after: 'main' }),
    payload({ ref: 'refs/heads/../main' }),
    payload({ changedFiles: ['../escape.ts'] }),
    payload({ changedFiles: ['a.ts'], changedFileCount: 2, filesTruncated: false }),
    payload({ pullRequestUrl: 'https://evil.example/ratchetnu/jkissllc/pull/210' }),
    payload({ pullRequestNumber: undefined, pullRequestUrl: 'https://github.com/ratchetnu/jkissllc/pull/210' }),
  ]
  for (const item of bad) assert.equal(validateGitHubDiscoveryPayload(item).ok, false, JSON.stringify(item))
})

test('source binding accepts only the registered source repository and branch', () => {
  assert.equal(discoveryMatchesSourceBusiness(payload(), sourceBusiness), true)
  assert.equal(discoveryMatchesSourceBusiness(payload({ repository: 'ratchetnu/other' }), sourceBusiness), false)
  assert.equal(discoveryMatchesSourceBusiness(payload({ ref: 'refs/heads/feature' }), sourceBusiness), false)
  assert.equal(discoveryMatchesSourceBusiness(payload(), { ...sourceBusiness, role: 'target' }), false)
})

test('builds a discovered—not approved—update with immutable provenance and conservative flags', () => {
  const update = discoveredUpdateFromGitHub(payload({
    title: 'feat(data)!: change the claims schema',
    commitMessage: 'feat(data)!: change the claims schema\n\nBREAKING CHANGE: new claim shape',
    changedFiles: ['app/lib/claims/schema.ts', '.env.example'],
  }), { key: 'UPD-2001', sourceBusinessId: 'jkiss', sourceBranch: 'main', now: T })
  assert.equal(update.status, 'discovered')
  assert.equal(update.sourceCommit, SHA)
  assert.equal(update.sourceBranch, 'main')
  assert.equal(update.sourceWorktreeDirty, false)
  assert.equal(update.createdBy, 'github-actions')
  assert.equal(update.type, 'feature')
  assert.equal(update.breakingChange, true)
  assert.equal(update.migrationRequired, true)
  assert.equal(update.environmentChangeRequired, true)
  assert.equal(update.rollbackSupported, false)
  assert.ok(Object.values(update.validation).every((state) => state === 'unknown'))
  assert.doesNotMatch(JSON.stringify(update), /approved|ready_for_release/)
})

type EvalStore = {
  values: Map<string, string>
  evalCalls: number
  get(key: string): Promise<string | null>
  eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

function discoveryStore(): EvalStore {
  const values = new Map<string, string>()
  return {
    values,
    evalCalls: 0,
    async get(key) { return values.get(key) ?? null },
    async eval(script, keys, args) {
      this.evalCalls += 1
      const [markerKey, updateKey] = keys
      // Execute the load-bearing statements only when they still exist in the real
      // script. Mutation-removing the marker read or write makes this test create two.
      const checksMarker = script.includes("local existing = redis.call('GET', KEYS[1])")
      const writesMarker = script.includes("redis.call('SET', KEYS[1], ARGV[3])")
      if (checksMarker && values.has(markerKey)) return values.get(markerKey)!
      if (values.has(updateKey)) return '__UPDATE_KEY_COLLISION__'
      values.set(updateKey, args[0])
      if (writesMarker) values.set(markerKey, args[2])
      return args[2]
    },
  }
}

function updateWithKey(key: string): PlatformUpdate {
  return discoveredUpdateFromGitHub(payload(), { key, sourceBusinessId: 'jkiss', sourceBranch: 'main', now: T })
}

test('duplicate and concurrent deliveries produce exactly one update record', async () => {
  const store = discoveryStore()
  const [first, second] = await Promise.all([
    saveDiscoveredUpdate(updateWithKey('UPD-2001'), { repository: 'ratchetnu/jkissllc', commit: SHA }, store),
    saveDiscoveredUpdate(updateWithKey('UPD-2002'), { repository: 'RATCHETNU/JKISSLLC', commit: SHA.toUpperCase() }, store),
  ])
  assert.deepEqual([first.kind, second.kind].sort(), ['created', 'existing'])
  assert.equal(first.update.key, second.update.key)
  assert.equal([...store.values.keys()].filter((key) => key.startsWith('platform:update:')).length, 1)
  assert.equal([...store.values.keys()].filter((key) => key.startsWith('platform:update-discovery:')).length, 1)
})

test('different source commits remain separate discovered updates', async () => {
  const store = discoveryStore()
  const first = await saveDiscoveredUpdate(updateWithKey('UPD-2001'), { repository: 'ratchetnu/jkissllc', commit: SHA }, store)
  const second = await saveDiscoveredUpdate(updateWithKey('UPD-2002'), { repository: 'ratchetnu/jkissllc', commit: 'c'.repeat(40) }, store)
  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'created')
})

test('the public machine route fails closed before any store read', async () => {
  const prior = process.env.OPERION_DISCOVERY_SECRET
  process.env.OPERION_DISCOVERY_SECRET = 'test-discovery-secret'
  try {
    const { POST } = await import('../app/api/automation/discover/route')
    const raw = JSON.stringify(payload({ changedFiles: ['../escape.ts'] }))
    const ts = String(Date.now())
    const invalidSignature = await POST(new NextRequest('http://localhost/api/automation/discover', {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-operion-timestamp': ts, 'x-operion-signature': 'bad' },
    }))
    assert.equal(invalidSignature.status, 401)
    const unsafePayload = await POST(new NextRequest('http://localhost/api/automation/discover', {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-operion-timestamp': ts, 'x-operion-signature': signCallback(raw, ts, 'test-discovery-secret') },
    }))
    assert.equal(unsafePayload.status, 400)
  } finally {
    if (prior === undefined) delete process.env.OPERION_DISCOVERY_SECRET
    else process.env.OPERION_DISCOVERY_SECRET = prior
  }
})

test('GitHub workflow discovers main pushes but cannot publish', () => {
  const workflow = readFileSync(new URL('../.github/workflows/operion-discover-update.yml', import.meta.url), 'utf8')
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/)
  assert.doesNotMatch(workflow, /workflow_dispatch/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: read/)
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|git push|gh pr merge|vercel --prod/)
  assert.match(workflow, /\/api\/automation\/callback/)
  assert.match(workflow, /\/discover/)
  assert.match(workflow, /x-operion-signature/)
  assert.match(workflow, /OPERION_DISCOVERY_SECRET/)
  assert.doesNotMatch(workflow, /secrets\.OPERION_CALLBACK_SECRET/)
  assert.match(workflow, /HTTP" = "200"[\s\S]*HTTP" = "201"/)
  assert.doesNotMatch(workflow.split(/\n\s*run: \|\n/).slice(1).join('\n'), /\$\{\{/)
})

test('Release Center catalog reads the same update store automatic discovery writes', () => {
  const catalogRoute = readFileSync(new URL('../app/api/admin/platform/releases/route.ts', import.meta.url), 'utf8')
  assert.match(catalogRoute, /listUpdates\(\)/)
  assert.match(catalogRoute, /updates:\s*updates\.map/)
  const discoveryRoute = readFileSync(new URL('../app/api/automation/discover/route.ts', import.meta.url), 'utf8')
  assert.ok(discoveryRoute.indexOf('verifyCallback(') < discoveryRoute.indexOf('saveDiscoveredUpdate('))
  assert.match(discoveryRoute, /status: saved\.update\.status/)
})
