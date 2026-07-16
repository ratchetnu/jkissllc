// Operion Commit-Transfer apply engine — deterministic, hermetic tests (in-memory fs).
import assert from 'node:assert/strict'
import test from 'node:test'
import { validateManifest, isSafeRepoPath, sha256, sortEntries, manifestFromCommitFiles, type ApplyManifest } from '../app/lib/platform/automation/manifest'
import { applyManifest, applySummary, type FsAdapter, type ContentMap } from '../app/lib/platform/automation/apply-executor'

function memFs(seed: Record<string, string> = {}): FsAdapter & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed))
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? null,
    write: (p, c) => { files.set(p, c.toString('utf8')) },
    remove: (p) => { files.delete(p) },
  }
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const content = (s: string): { contentBase64: string; sha256: string } => ({ contentBase64: b64(s), sha256: sha256(Buffer.from(s, 'utf8')) })
function manifest(entries: ApplyManifest['entries']): ApplyManifest { return { updateKey: 'UPD-1', sourceRepo: 'ratchetnu/jkissllc', sourceCommit: 'abc', entries } }

// ── path safety ──
test('isSafeRepoPath rejects traversal / absolute / junk, accepts normal paths', () => {
  assert.equal(isSafeRepoPath('app/admin/x.tsx'), true)
  assert.equal(isSafeRepoPath('a/b/c.ts'), true)
  for (const bad of ['../etc/passwd', '/etc/passwd', '~/x', 'a/../b', './x', 'a//b', 'a\\b', 'C:/x', '', 'a/b\0c']) assert.equal(isSafeRepoPath(bad), false, bad)
})

// ── manifest validation ──
test('validateManifest rejects duplicates, unsafe paths, bad actions, missing hashes', () => {
  assert.equal(validateManifest(manifest([])).ok, false)                                   // empty
  assert.equal(validateManifest(manifest([{ path: 'a.ts', action: 'add' }])).ok, false)    // add w/o hash
  assert.equal(validateManifest(manifest([{ path: '../a', action: 'add', sha256: 'x'.repeat(64) }])).ok, false) // traversal
  const dup = validateManifest(manifest([{ path: 'a.ts', action: 'delete' }, { path: 'a.ts', action: 'delete' }]))
  assert.equal(dup.ok, false); assert.match(dup.errors.join(), /duplicate/)
  assert.equal(validateManifest(manifest([{ path: 'a.ts', action: 'delete', sha256: 'a'.repeat(64) }])).ok, false) // delete w/ hash
  assert.equal(validateManifest(manifest([{ path: 'a.ts', action: 'add', sha256: sha256('x') }])).ok, true)        // valid
})

test('sortEntries is deterministic: order, then add/modify before delete, then path', () => {
  const s = sortEntries([{ path: 'z.ts', action: 'delete' }, { path: 'a.ts', action: 'add' }, { path: 'b.ts', action: 'modify' }])
  assert.deepEqual(s.map(e => e.path), ['a.ts', 'b.ts', 'z.ts'])
})

test('manifestFromCommitFiles maps git status → action', () => {
  const m = manifestFromCommitFiles([{ filename: 'a.ts', status: 'added' }, { filename: 'b.ts', status: 'modified' }, { filename: 'c.ts', status: 'removed' }])
  assert.deepEqual(m, [{ path: 'a.ts', action: 'add' }, { path: 'b.ts', action: 'modify' }, { path: 'c.ts', action: 'delete' }])
})

// ── apply: single file ──
test('single-file add writes the file and reports changed', () => {
  const fs = memFs()
  const c = content('export const x = 1\n')
  const r = applyManifest(manifest([{ path: 'app/x.ts', action: 'add', sha256: c.sha256 }]), { 'app/x.ts': c }, fs)
  assert.equal(r.ok, true); assert.equal(r.changed, true)
  assert.deepEqual(applySummary(r), { applied: 1, skipped: 0, failed: 0, changed: true })
  assert.equal(fs.files.get('app/x.ts'), 'export const x = 1\n')
})

// ── apply: multi-file + modify ──
test('multi-file add + modify applies all', () => {
  const fs = memFs({ 'app/b.ts': 'old' })
  const a = content('A'), b = content('B-new')
  const r = applyManifest(manifest([{ path: 'app/a.ts', action: 'add', sha256: a.sha256 }, { path: 'app/b.ts', action: 'modify', sha256: b.sha256 }]), { 'app/a.ts': a, 'app/b.ts': b }, fs)
  assert.equal(r.applied.length, 2); assert.equal(r.ok, true)
  assert.equal(fs.files.get('app/a.ts'), 'A'); assert.equal(fs.files.get('app/b.ts'), 'B-new')
})

// ── apply: delete ──
test('delete removes an existing file; absent delete is skipped (idempotent)', () => {
  const fs = memFs({ 'app/gone.ts': 'x' })
  const r = applyManifest(manifest([{ path: 'app/gone.ts', action: 'delete' }, { path: 'app/never.ts', action: 'delete' }]), {}, fs)
  assert.equal(fs.files.has('app/gone.ts'), false)
  assert.equal(r.applied.length, 1); assert.equal(r.skipped.length, 1); assert.equal(r.ok, true)
})

// ── failures ──
test('missing source content is a structured failure (no write, ok=false)', () => {
  const fs = memFs()
  const c = content('X')
  const r = applyManifest(manifest([{ path: 'app/x.ts', action: 'add', sha256: c.sha256 }]), {}, fs)
  assert.equal(r.ok, false); assert.equal(r.failed[0].reason, 'missing source content'); assert.equal(fs.files.size, 0)
})

test('hash mismatch aborts that file and fails the run (branch stays clean)', () => {
  const fs = memFs()
  const r = applyManifest(manifest([{ path: 'app/x.ts', action: 'add', sha256: sha256('EXPECTED') }]), { 'app/x.ts': content('TAMPERED') }, fs)
  assert.equal(r.ok, false); assert.equal(r.failed[0].reason, 'hash mismatch'); assert.equal(fs.files.size, 0)
})

test('a validation defect fails the whole apply before any write', () => {
  const fs = memFs({ 'keep.ts': 'k' })
  const r = applyManifest(manifest([{ path: '../escape.ts', action: 'add', sha256: 'a'.repeat(64) }]), {}, fs)
  assert.equal(r.ok, false); assert.equal(r.changed, false); assert.equal(fs.files.get('keep.ts'), 'k')
})

// ── idempotent retry ──
test('idempotent retry: re-applying the same manifest yields the same tree', () => {
  const c = content('same\n')
  const m = manifest([{ path: 'app/x.ts', action: 'add', sha256: c.sha256 }])
  const fs = memFs()
  const r1 = applyManifest(m, { 'app/x.ts': c }, fs)
  const r2 = applyManifest(m, { 'app/x.ts': c }, fs)
  assert.equal(r1.ok, true); assert.equal(r2.ok, true)
  assert.equal(fs.files.get('app/x.ts'), 'same\n'); assert.equal(fs.files.size, 1)
})
