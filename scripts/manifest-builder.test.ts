// Operion commit-transfer manifest builder — hermetic (mock provider, no network).
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommitTransferManifest } from '../app/lib/platform/automation/manifest-builder'
import { sha256, validateManifest } from '../app/lib/platform/automation/manifest'
import type { UpdateAutomationProvider } from '../app/lib/platform/automation/provider'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
// A provider stub for source + target reads. By default every existing file is identical
// across baseline/source/target, which is a safe no-drift state.
function mockProvider(files: { filename: string; status: string }[], blobs: Record<string, string>, reads: string[] = []): UpdateAutomationProvider {
  const p: Partial<UpdateAutomationProvider> = {
    name: 'mock',
    readCommit: async (_i, _r, sha) => ({ ok: true, data: { sha, message: 'test', parentSha: 'parent', parentCount: 1 } }),
    readBranch: async () => ({ ok: true, data: { commit: 'target-base' } }),
    readCommitFiles: async () => ({ ok: true, data: { files } }),
    readFileContent: async (_i, _r, path) => {
      reads.push(path)
      if (!(path in blobs)) return { ok: false, error: 'not found', category: 'not_found' }
      const contentBase64 = b64(blobs[path])
      return { ok: true, data: { contentBase64, sha256: sha256(Buffer.from(blobs[path], 'utf8')) } }
    },
  }
  return p as UpdateAutomationProvider
}
const REPO = { owner: 'ratchetnu', name: 'jkissllc' }
const TARGET = { owner: 'ratchetnu', name: 'supercharged' }
const COMPAT = { status: 'compatible' as const }
const TARGET_INPUT = { targetRepo: TARGET, targetBranch: 'main' }

test('builds a valid manifest from a commit: add + modify + delete, with content + hashes', async () => {
  const provider = mockProvider(
    [{ filename: 'app/a.tsx', status: 'added' }, { filename: 'app/b.ts', status: 'modified' }, { filename: 'app/old.ts', status: 'removed' }],
    { 'app/a.tsx': 'export const A = 1\n', 'app/b.ts': 'export const B = 2\n', 'app/old.ts': 'old' },
  )
  const r = await buildCommitTransferManifest({ provider, installationId: '146887383', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'deadbeef', updateKey: 'UPD-1004', compatibility: COMPAT, ...TARGET_INPUT })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(validateManifest(r.data.manifest).ok, true)
  const byPath = Object.fromEntries(r.data.manifest.entries.map(e => [e.path, e]))
  assert.equal(byPath['app/a.tsx'].action, 'add')
  assert.equal(byPath['app/b.ts'].action, 'modify')
  assert.equal(byPath['app/old.ts'].action, 'delete')
  assert.equal(byPath['app/old.ts'].sha256, undefined)                    // deletes carry no content
  assert.equal(byPath['app/a.tsx'].sha256, sha256(Buffer.from('export const A = 1\n')))
  // Contents are present + hash-consistent for add/modify; delete has none.
  assert.equal(r.data.contents['app/a.tsx'].sha256, byPath['app/a.tsx'].sha256)
  assert.equal(r.data.contents['app/old.ts'], undefined)
})

test('fails cleanly when a source file cannot be read', async () => {
  const provider = mockProvider([{ filename: 'app/x.ts', status: 'added' }], {})  // no blob for x.ts
  const r = await buildCommitTransferManifest({ provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-1', compatibility: COMPAT, ...TARGET_INPUT })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /read app\/x\.ts/)
})

test('rejects a commit that changes an unsafe path (traversal)', async () => {
  const provider = mockProvider([{ filename: '../escape.ts', status: 'added' }], { '../escape.ts': 'x' })
  const r = await buildCommitTransferManifest({ provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-1', compatibility: COMPAT, ...TARGET_INPUT })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /invalid manifest/)
})

test('fails when the update has no source commit', async () => {
  const provider = mockProvider([], {})
  const r = await buildCommitTransferManifest({ provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: '', updateKey: 'UPD-1', compatibility: COMPAT, ...TARGET_INPUT })
  assert.equal(r.ok, false)
})

test('excludes target-specific paths before reading source content', async () => {
  const reads: string[] = []
  const provider = mockProvider(
    [
      { filename: 'app/quote/page.tsx', status: 'modified' },
      { filename: 'app/lib/telemetry.ts', status: 'modified' },
      { filename: 'app/lib/safe.ts', status: 'modified' },
    ],
    {
      'app/quote/page.tsx': 'source branding',
      'app/lib/telemetry.ts': 'older telemetry',
      'app/lib/safe.ts': 'safe change',
    },
    reads,
  )
  const r = await buildCommitTransferManifest({
    provider,
    installationId: '1',
    sourceRepo: REPO,
    sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'abc',
    ...TARGET_INPUT,
    updateKey: 'UPD-1004',
    compatibility: { status: 'compatible_with_changes', pathsToExclude: [' app/quote/page.tsx ', 'app/lib/telemetry.ts'] },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.data.manifest.entries.map((entry) => entry.path), ['app/lib/safe.ts'])
  assert.deepEqual(Object.keys(r.data.contents), ['app/lib/safe.ts'])
  assert.deepEqual(reads, ['app/lib/safe.ts', 'app/lib/safe.ts', 'app/lib/safe.ts'])
  assert.deepEqual(r.data.excludedPaths, ['app/lib/telemetry.ts', 'app/quote/page.tsx'])
})

test('excludes deletions as well as added or modified files', async () => {
  const provider = mockProvider([{ filename: 'app/target-only.ts', status: 'removed' }, { filename: 'app/safe.ts', status: 'added' }], { 'app/safe.ts': 'safe' })
  const r = await buildCommitTransferManifest({
    provider,
    installationId: '1',
    sourceRepo: REPO,
    sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'abc',
    ...TARGET_INPUT,
    updateKey: 'UPD-1',
    compatibility: { status: 'compatible_with_changes', pathsToExclude: ['app/target-only.ts'] },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.data.manifest.entries.map((entry) => entry.path), ['app/safe.ts'])
  assert.deepEqual(r.data.excludedPaths, ['app/target-only.ts'])
})

test('fails closed on unsafe or unmatched excluded component values', async () => {
  const provider = mockProvider([{ filename: 'app/safe.ts', status: 'added' }], { 'app/safe.ts': 'safe' })
  for (const excluded of ['../app/safe.ts', '/app/safe.ts', 'app/*', 'jkiss-logo']) {
    const r = await buildCommitTransferManifest({
      provider,
      installationId: '1',
      sourceRepo: REPO,
      sourceRepoName: 'ratchetnu/jkissllc',
      sourceCommit: 'abc',
      ...TARGET_INPUT,
      updateKey: 'UPD-1',
      compatibility: { status: 'compatible_with_changes', pathsToExclude: [excluded] },
    })
    assert.equal(r.ok, false, excluded)
    assert.match((r as { error: string }).error, /invalid excluded repository path|not present in source commit/)
  }
})

test('refuses missing or repudiated compatibility before reading the source commit', async () => {
  let commitReads = 0
  const provider = mockProvider([{ filename: 'app/safe.ts', status: 'added' }], { 'app/safe.ts': 'safe' })
  provider.readCommitFiles = async () => { commitReads += 1; return { ok: true, data: { files: [] } } }

  const statuses = [undefined, 'unknown', 'under_review', 'already_present', 'not_applicable', 'incompatible', 'blocked'] as const
  for (const status of statuses) {
    const r = await buildCommitTransferManifest({
      provider,
      installationId: '1',
      sourceRepo: REPO,
      sourceRepoName: 'ratchetnu/jkissllc',
      sourceCommit: 'abc',
      ...TARGET_INPUT,
      updateKey: 'UPD-1004',
      compatibility: status ? { status } : undefined,
    })
    assert.equal(r.ok, false, status)
    assert.match((r as { error: string }).error, /compatibility/)
  }
  assert.equal(commitReads, 0)
})

function driftProvider(opts: {
  action?: 'added' | 'modified' | 'removed'
  baseline?: string
  source?: string
  target?: string
  targetCommit?: string
  seenRefs?: string[]
}): UpdateAutomationProvider {
  const path = 'app/lib/telemetry.ts'
  const targetCommit = opts.targetCommit ?? 'target-pinned-sha'
  const p: Partial<UpdateAutomationProvider> = {
    name: 'drift-mock',
    readCommit: async (_i, _r, sha) => ({ ok: true, data: { sha, message: 'update', parentSha: 'source-parent', parentCount: 1 } }),
    readBranch: async () => ({ ok: true, data: { commit: targetCommit } }),
    readCommitFiles: async () => ({ ok: true, data: { files: [{ filename: path, status: opts.action ?? 'modified' }] } }),
    readFileContent: async (_i, repo, requestedPath, ref) => {
      opts.seenRefs?.push(`${repo.name}:${ref}:${requestedPath}`)
      const value = repo.name === TARGET.name
        ? opts.target
        : ref === 'source-parent' ? opts.baseline : opts.source
      if (value === undefined) return { ok: false, error: 'not found', category: 'not_found' }
      return { ok: true, data: { contentBase64: b64(value), sha256: sha256(value) } }
    },
  }
  return p as UpdateAutomationProvider
}

async function buildDriftCase(provider: UpdateAutomationProvider) {
  return buildCommitTransferManifest({
    provider,
    installationId: '1',
    sourceRepo: REPO,
    sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'source-new',
    ...TARGET_INPUT,
    updateKey: 'UPD-DRIFT',
    compatibility: COMPAT,
  })
}

test('three-way drift gate allows an unchanged target and pins reads to its resolved commit', async () => {
  const seenRefs: string[] = []
  const r = await buildDriftCase(driftProvider({ baseline: 'old', source: 'new', target: 'old', seenRefs }))
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.data.targetBaseCommit, 'target-pinned-sha')
  assert.deepEqual(r.data.driftCheckedPaths, ['app/lib/telemetry.ts'])
  assert.ok(seenRefs.includes('supercharged:target-pinned-sha:app/lib/telemetry.ts'))
  assert.ok(!seenRefs.some((ref) => ref.startsWith('supercharged:main:')))
})

test('three-way drift gate refuses an independently customized target file', async () => {
  const r = await buildDriftCase(driftProvider({ baseline: 'old', source: 'new', target: 'supercharged custom' }))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /target drift detected for app\/lib\/telemetry\.ts/)
})

test('three-way drift gate allows a target already equal to the incoming source file', async () => {
  const r = await buildDriftCase(driftProvider({ baseline: 'old', source: 'new', target: 'new' }))
  assert.equal(r.ok, true)
})

test('three-way drift gate refuses add-over-existing and delete-over-customized', async () => {
  const add = await buildDriftCase(driftProvider({ action: 'added', source: 'new', target: 'target-owned' }))
  assert.equal(add.ok, false)
  assert.match((add as { error: string }).error, /target drift detected/)

  const del = await buildDriftCase(driftProvider({ action: 'removed', baseline: 'old', target: 'target-custom' }))
  assert.equal(del.ok, false)
  assert.match((del as { error: string }).error, /target drift detected/)
})

test('three-way drift gate allows add to absent and delete of unchanged or absent files', async () => {
  assert.equal((await buildDriftCase(driftProvider({ action: 'added', source: 'new' }))).ok, true)
  assert.equal((await buildDriftCase(driftProvider({ action: 'removed', baseline: 'old', target: 'old' }))).ok, true)
  assert.equal((await buildDriftCase(driftProvider({ action: 'removed', baseline: 'old' }))).ok, true)
})

test('three-way drift gate fails closed when baseline or target reads fail unexpectedly', async () => {
  const missingBaseline = await buildDriftCase(driftProvider({ source: 'new', target: 'old' }))
  assert.equal(missingBaseline.ok, false)
  assert.match((missingBaseline as { error: string }).error, /read source baseline/)

  const provider = driftProvider({ baseline: 'old', source: 'new', target: 'old' })
  provider.readBranch = async () => ({ ok: false, error: 'forbidden', category: 'permission' })
  const targetFailure = await buildDriftCase(provider)
  assert.equal(targetFailure.ok, false)
  assert.match((targetFailure as { error: string }).error, /read target base branch/)
})

test('renamed files fail closed with an actionable split-update message', async () => {
  const provider = mockProvider([{ filename: 'app/new-name.ts', status: 'renamed' }], { 'app/new-name.ts': 'new' })
  const r = await buildCommitTransferManifest({
    provider,
    installationId: '1',
    sourceRepo: REPO,
    sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'source-new',
    ...TARGET_INPUT,
    updateKey: 'UPD-RENAME',
    compatibility: COMPAT,
  })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /renamed files require a separate reviewed update: app\/new-name\.ts/)
})
