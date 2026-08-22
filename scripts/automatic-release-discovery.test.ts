import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { signCallback } from '../app/lib/platform/automation/callback'
import {
  discoveryMatchesSourceBusiness, discoveredUpdateFromGitHub, validateGitHubDiscoveryPayload,
  type GitHubDiscoveryPayload,
} from '../app/lib/platform/updates/discovery'
import { saveDiscoveredUpdate, DISCOVERY_KEY_PLACEHOLDER } from '../app/lib/platform/updates/store'
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

// EVERY rejection below asserts WHICH GUARD refused, not merely that something did.
//
// The previous version asserted `ok === false` and nothing more, which let a guard be
// removed without failing: its unsafe-path fixture carried `changedFileCount: 2` for
// ONE file, so deleting the `isSafeRepoPath` check still produced a rejection — from
// the truncation-consistency guard instead. The test passed while the guard it was
// named for was gone.
const reasonFor = (p: unknown): string => {
  const r = validateGitHubDiscoveryPayload(p)
  return r.ok ? '<<ACCEPTED>>' : r.reason
}

test('a well-formed, pinned main-branch event is accepted', () => {
  const good = validateGitHubDiscoveryPayload(payload())
  assert.equal(good.ok, true)
})

test('GAP 1: an unsafe repository path is refused BY THE PATH GUARD', () => {
  // Self-consistent counts, so nothing else can do the rejecting.
  const one = (f: string) => payload({ changedFiles: [f], changedFileCount: 1, filesTruncated: false })
  for (const f of ['../escape.ts', 'app/../../etc/passwd', '/etc/passwd', './../x.ts']) {
    assert.equal(reasonFor(one(f)), 'changedFiles contains an unsafe path', `for ${f}`)
  }
  // …and the guard it is NOT: a consistent, safe path passes this check entirely.
  assert.equal(validateGitHubDiscoveryPayload(one('app/lib/x.ts')).ok, true)
})

test('GAP 1b: the truncation-consistency guard is separate and speaks for itself', () => {
  assert.equal(
    reasonFor(payload({ changedFiles: ['a.ts'], changedFileCount: 2, filesTruncated: false })),
    'filesTruncated does not match changedFileCount',
  )
  assert.equal(
    reasonFor(payload({ changedFiles: ['a.ts'], changedFileCount: 1, filesTruncated: true })),
    'filesTruncated does not match changedFileCount',
  )
})

test('GAP 2: the pull-request URL must match the PATH, not merely the host', () => {
  // Host is github.com in every case here, so only the path check can refuse them.
  assert.equal(reasonFor(payload({ pullRequestUrl: 'https://github.com/ratchetnu/jkissllc/pull/999' })), 'invalid pullRequestUrl',
    'a real GitHub URL for a DIFFERENT pull request must not be accepted')
  assert.equal(reasonFor(payload({ pullRequestUrl: 'https://github.com/attacker/evil/pull/210' })), 'invalid pullRequestUrl',
    'a real GitHub URL for a different REPOSITORY must not be accepted')
  assert.equal(reasonFor(payload({ pullRequestUrl: 'https://github.com/ratchetnu/jkissllc/issues/210' })), 'invalid pullRequestUrl')
  assert.equal(reasonFor(payload({ pullRequestUrl: 'https://github.com/ratchetnu/jkissllc/pull/210/files' })), 'invalid pullRequestUrl')
  // The host and scheme guards, asserted separately so neither masks the other.
  assert.equal(reasonFor(payload({ pullRequestUrl: 'https://evil.example/ratchetnu/jkissllc/pull/210' })), 'invalid pullRequestUrl')
  assert.equal(reasonFor(payload({ pullRequestUrl: 'http://github.com/ratchetnu/jkissllc/pull/210' })), 'invalid pullRequestUrl')
  assert.equal(reasonFor(payload({ pullRequestUrl: 'https://github.com.evil.test/ratchetnu/jkissllc/pull/210' })), 'invalid pullRequestUrl')
  // The exact matching URL is accepted, so the assertions above are not vacuous.
  assert.equal(validateGitHubDiscoveryPayload(payload()).ok, true)
})

test('GAP 3: LENGTH is checked independently of hex-ness — 40 characters exactly', () => {
  const hex = (n: number) => 'a'.repeat(n)
  // 39 and 41 are perfectly valid hex. Only a length rule can refuse them, which is
  // what a `{7,40}`-style relaxation would silently break.
  assert.equal(reasonFor(payload({ after: hex(39) })), 'invalid after commit')
  assert.equal(reasonFor(payload({ after: hex(41) })), 'invalid after commit')
  assert.equal(reasonFor(payload({ after: hex(7) })), 'invalid after commit', 'an abbreviated sha is not an artifact')
  assert.equal(reasonFor(payload({ after: hex(12) })), 'invalid after commit')
  assert.equal(validateGitHubDiscoveryPayload(payload({ after: hex(40) })).ok, true)
  // …and non-hex of the RIGHT length is refused by the character rule.
  assert.equal(reasonFor(payload({ after: 'g'.repeat(40) })), 'invalid after commit')
  // The same rules bind `before`.
  assert.equal(reasonFor(payload({ before: hex(39) })), 'invalid before commit')
})

test('GAP 4: the all-zero commit (a deleted branch) is refused', () => {
  assert.equal(reasonFor(payload({ after: '0'.repeat(40) })), 'invalid after commit')
  // It is exactly 40 valid hex characters, so ONLY the zero rule can be refusing it.
  assert.match('0'.repeat(40), /^[0-9a-f]{40}$/)
  // `before` is legitimately all-zero for the first commit on a branch, and must stay
  // acceptable — the zero rule belongs to `after` alone.
  assert.equal(validateGitHubDiscoveryPayload(payload({ before: '0'.repeat(40) })).ok, true)
})

test('the ref guard refuses traversal and non-branch refs, by name', () => {
  assert.equal(reasonFor(payload({ ref: 'refs/heads/../main' })), 'invalid ref')
  assert.equal(reasonFor(payload({ ref: 'refs/heads//main' })), 'invalid ref')
  assert.equal(reasonFor(payload({ ref: 'refs/tags/v1' })), 'invalid ref')
  assert.equal(reasonFor(payload({ ref: 'main' })), 'invalid ref')
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
      const [markerKey, indexKey, counterKey] = keys
      const [encoded, score, prefix, placeholder] = args
      // Each load-bearing statement is executed ONLY if it is still present in the
      // real script. Deleting one from the source therefore changes what this fake
      // does, and the assertions below fail — the fake cannot paper over a guard the
      // production script no longer has.
      const checksMarker = script.includes("local existing = redis.call('GET', KEYS[1])")
      const allocatesInside = script.includes("local seq = redis.call('INCR', KEYS[3])")
      const checksCollision = script.includes("if redis.call('EXISTS', recordKey) == 1 then return '__UPDATE_KEY_COLLISION__' end")
      const writesMarker = script.includes("redis.call('SET', KEYS[1], key)")

      if (checksMarker && values.has(markerKey)) return `E:${values.get(markerKey)!}`
      if (!allocatesInside) throw new Error('script no longer allocates the sequence atomically')
      const seq = Number(values.get(counterKey) ?? '0') + 1
      values.set(counterKey, String(seq))
      const key = `UPD-${1000 + seq}`
      const recordKey = prefix + key
      if (checksCollision && values.has(recordKey)) return '__UPDATE_KEY_COLLISION__'
      values.set(recordKey, encoded.replace(placeholder, () => key))
      values.set(`${indexKey}::${key}`, score)
      if (writesMarker) values.set(markerKey, key)
      return `C:${key}`
    },
  }
}

const counterOf = (store: EvalStore) => Number(store.values.get('platform:update:counter') ?? '0')
const recordKeys = (store: EvalStore) => [...store.values.keys()].filter(k => /^platform:update:UPD-/.test(k))

/** A candidate exactly as the route builds one: the key is a PLACEHOLDER. */
function candidate(commit = SHA): PlatformUpdate {
  return discoveredUpdateFromGitHub(payload({ after: commit }), {
    key: DISCOVERY_KEY_PLACEHOLDER, sourceBusinessId: 'jkiss', sourceBranch: 'main', now: T,
  })
}

test('D5: a duplicate delivery returns the original and consumes NO update number', async () => {
  const store = discoveryStore()
  const first = await saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store)
  assert.equal(first.kind, 'created')
  assert.equal(first.update.key, 'UPD-1001')
  assert.equal(counterOf(store), 1)

  // A retry of the same run, a workflow re-run, and a fresh run id — all the same
  // artifact, and none of them may mint a number.
  for (const label of ['retry', 're-run', 'new run']) {
    const again = await saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store)
    assert.equal(again.kind, 'existing', label)
    assert.equal(again.update.key, 'UPD-1001', label)
    assert.equal(counterOf(store), 1, `${label} consumed a UPD number — the D5 regression`)
  }
  assert.equal(recordKeys(store).length, 1)
})

test('D5: simultaneous FIRST deliveries still create exactly one update', async () => {
  const store = discoveryStore()
  const results = await Promise.all([
    saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store),
    saveDiscoveredUpdate(candidate(), { repository: 'RATCHETNU/JKISSLLC', commit: SHA.toUpperCase() }, store),
    saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store),
  ])
  assert.deepEqual(results.map(r => r.kind).sort(), ['created', 'existing', 'existing'])
  assert.equal(new Set(results.map(r => r.update.key)).size, 1, 'all three resolve to one record')
  assert.equal(recordKeys(store).length, 1)
  assert.equal(counterOf(store), 1, 'one artifact, one number')
})

test('D5: the allocated key is what lands in the record, not the placeholder', async () => {
  const store = discoveryStore()
  const saved = await saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store)
  assert.equal(saved.update.key, 'UPD-1001')
  const raw = store.values.get('platform:update:UPD-1001')!
  assert.ok(!raw.includes(DISCOVERY_KEY_PLACEHOLDER), 'no placeholder survived into the record')
  assert.equal(JSON.parse(raw).key, 'UPD-1001')
})

test('D5: a candidate without exactly one placeholder is refused before any write', async () => {
  const store = discoveryStore()
  const noPlaceholder = { ...candidate(), key: 'UPD-9999' }
  await assert.rejects(
    () => saveDiscoveredUpdate(noPlaceholder, { repository: 'ratchetnu/jkissllc', commit: SHA }, store),
    /DISCOVERY_PLACEHOLDER_NOT_UNIQUE/,
  )
  assert.equal(store.evalCalls, 0, 'nothing was attempted against the store')
  assert.equal(recordKeys(store).length, 0)
})

test('different source commits remain separate discovered updates', async () => {
  const store = discoveryStore()
  const a = await saveDiscoveredUpdate(candidate(SHA), { repository: 'ratchetnu/jkissllc', commit: SHA }, store)
  const b = await saveDiscoveredUpdate(candidate('c'.repeat(40)), { repository: 'ratchetnu/jkissllc', commit: 'c'.repeat(40) }, store)
  assert.equal(a.kind, 'created')
  assert.equal(b.kind, 'created')
  assert.notEqual(a.update.key, b.update.key)
  assert.equal(counterOf(store), 2, 'two artifacts, two numbers')
})

test('GAP 6: an existing update key is REFUSED — a record is never overwritten', async () => {
  const store = discoveryStore()
  // A human-authored record already occupies the slot the counter will hand out.
  store.values.set('platform:update:UPD-1001', JSON.stringify({ key: 'UPD-1001', title: 'HUMAN', status: 'approved' }))
  await assert.rejects(
    () => saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store),
    /UPDATE_KEY_COLLISION/,
    'discovery must refuse rather than clobber',
  )
  const survived = JSON.parse(store.values.get('platform:update:UPD-1001')!)
  assert.equal(survived.title, 'HUMAN')
  assert.equal(survived.status, 'approved', 'and its approval state is intact')
  assert.equal(store.values.get('platform:update-discovery:' + 'x'), undefined)
})

test('GAP 6b: a marker pointing at a missing record fails loudly, not silently', async () => {
  const store = discoveryStore()
  const digest = createHash('sha256').update(`ratchetnu/jkissllc@${SHA}`).digest('hex')
  store.values.set('platform:update-discovery:' + digest, 'UPD-GONE')
  await assert.rejects(
    () => saveDiscoveredUpdate(candidate(), { repository: 'ratchetnu/jkissllc', commit: SHA }, store),
    /DISCOVERY_MARKER_WITHOUT_UPDATE/,
  )
  assert.equal(counterOf(store), 0, 'and no number was consumed on the way')
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
