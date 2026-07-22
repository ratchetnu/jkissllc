// Operion commit-transfer manifest builder — hermetic (mock provider, no network).
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommitTransferManifest } from '../app/lib/platform/automation/manifest-builder'
import { sha256, validateManifest } from '../app/lib/platform/automation/manifest'
import type { UpdateAutomationProvider } from '../app/lib/platform/automation/provider'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
// A provider stub that only implements the two read methods the builder uses.
function mockProvider(files: { filename: string; status: string }[], blobs: Record<string, string>, reads: string[] = []): UpdateAutomationProvider {
  const p: Partial<UpdateAutomationProvider> = {
    name: 'mock',
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

test('builds a valid manifest from a commit: add + modify + delete, with content + hashes', async () => {
  const provider = mockProvider(
    [{ filename: 'app/a.tsx', status: 'added' }, { filename: 'app/b.ts', status: 'modified' }, { filename: 'app/old.ts', status: 'removed' }],
    { 'app/a.tsx': 'export const A = 1\n', 'app/b.ts': 'export const B = 2\n' },
  )
  const r = await buildCommitTransferManifest({ provider, installationId: '146887383', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'deadbeef', updateKey: 'UPD-1004' })
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
  const r = await buildCommitTransferManifest({ provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-1' })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /read app\/x\.ts/)
})

test('rejects a commit that changes an unsafe path (traversal)', async () => {
  const provider = mockProvider([{ filename: '../escape.ts', status: 'added' }], { '../escape.ts': 'x' })
  const r = await buildCommitTransferManifest({ provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-1' })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /invalid manifest/)
})

test('fails when the update has no source commit', async () => {
  const provider = mockProvider([], {})
  const r = await buildCommitTransferManifest({ provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: '', updateKey: 'UPD-1' })
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
    updateKey: 'UPD-1004',
    componentsToExclude: [' app/quote/page.tsx ', 'app/lib/telemetry.ts'],
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.data.manifest.entries.map((entry) => entry.path), ['app/lib/safe.ts'])
  assert.deepEqual(Object.keys(r.data.contents), ['app/lib/safe.ts'])
  assert.deepEqual(reads, ['app/lib/safe.ts'])
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
    updateKey: 'UPD-1',
    componentsToExclude: ['app/target-only.ts'],
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
      updateKey: 'UPD-1',
      componentsToExclude: [excluded],
    })
    assert.equal(r.ok, false, excluded)
    assert.match((r as { error: string }).error, /invalid excluded component path|not present in source commit/)
  }
})
