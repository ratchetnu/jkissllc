// Operion commit-transfer manifest builder — hermetic (mock provider, no network).
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommitTransferManifest } from '../app/lib/platform/automation/manifest-builder'
import { sha256, validateManifest } from '../app/lib/platform/automation/manifest'
import type { UpdateAutomationProvider } from '../app/lib/platform/automation/provider'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
// A provider stub for source + target reads. By default every existing file is identical
// across baseline/source/target, which is a safe no-drift state.
function mockProvider(files: { filename: string; status: string }[], blobs: Record<string, string>, reads: string[] = [], targetPaths: string[] = []): UpdateAutomationProvider {
  const p: Partial<UpdateAutomationProvider> = {
    name: 'mock',
    readCommit: async (_i, _r, sha) => ({ ok: true, data: { sha, message: 'test', parentSha: 'parent', parentCount: 1 } }),
    readBranch: async () => ({ ok: true, data: { commit: 'target-base' } }),
    readTree: async () => ({ ok: true, data: { paths: targetPaths } }),
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
    readTree: async () => ({ ok: true, data: { paths: [] } }),
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

// ── Dependency closure (issue #48 P1-1, Phase A) ─────────────────────────────
// The gate that would have stopped UPD-1004 at build time instead of in the
// target's CI. Wired between the rename guard and the drift loop.

type Call = { op: 'tree' | 'content'; repo: string; ref: string; path?: string }

function closureProvider(opts: {
  files: { filename: string; status: string }[]
  sources: Record<string, string>
  targetPaths: string[]
  calls?: Call[]
  treeError?: string
}): UpdateAutomationProvider {
  const calls = opts.calls ?? []
  const p: Partial<UpdateAutomationProvider> = {
    name: 'closure-mock',
    readCommit: async (_i, _r, sha) => ({ ok: true, data: { sha, message: 'u', parentSha: 'source-parent', parentCount: 1 } }),
    readBranch: async () => ({ ok: true, data: { commit: 'target-pinned-sha' } }),
    readTree: async (_i, repo, sha) => {
      calls.push({ op: 'tree', repo: repo.name, ref: sha })
      return opts.treeError
        ? { ok: false, error: opts.treeError, category: 'api' }
        : { ok: true, data: { paths: opts.targetPaths } }
    },
    readCommitFiles: async () => ({ ok: true, data: { files: opts.files } }),
    readFileContent: async (_i, repo, path, ref) => {
      calls.push({ op: 'content', repo: repo.name, ref, path })
      // Target side: present only if the tree says so, and byte-identical to source
      // (so drift never fires and closure is the only thing under test).
      if (repo.name === TARGET.name) {
        if (!opts.targetPaths.includes(path)) return { ok: false, error: 'not found', category: 'not_found' }
        const v = opts.sources[path] ?? ''
        return { ok: true, data: { contentBase64: b64(v), sha256: sha256(v) } }
      }
      const v = opts.sources[path]
      if (v === undefined) return { ok: false, error: 'not found', category: 'not_found' }
      return { ok: true, data: { contentBase64: b64(v), sha256: sha256(v) } }
    },
  }
  return p as UpdateAutomationProvider
}

const buildClosureCase = (provider: UpdateAutomationProvider, compatibility: unknown = COMPAT) =>
  buildCommitTransferManifest({
    provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'source-new', ...TARGET_INPUT, updateKey: 'UPD-1004',
    compatibility: compatibility as never,
  })

// The real incident shape: e42af39 modified record-payment.ts and quote/page.tsx,
// which import two modules created in a commit Supercharged never received.
const UPD_1004 = {
  files: [
    { filename: 'app/lib/record-payment.ts', status: 'modified' },
    { filename: 'app/quote/page.tsx', status: 'modified' },
    { filename: 'app/lib/platform/tenancy/blob-keys.ts', status: 'added' },
  ],
  sources: {
    'app/lib/record-payment.ts': `import { onPaymentRecorded } from './intake-workflow'\nimport { redis } from './redis'\n`,
    'app/quote/page.tsx': `import { PACKS } from '../lib/pack-services'\nimport { COMPANY } from '../lib/company'\n`,
    'app/lib/platform/tenancy/blob-keys.ts': `export const key = (t: string) => t\n`,
  },
  // Supercharged has both modified files (that is why they are `modified`) and the
  // two dependencies they already resolved against — but not the two new modules.
  targetPaths: ['app/lib/record-payment.ts', 'app/quote/page.tsx', 'app/lib/redis.ts', 'app/lib/company.ts'],
}

test('UPD-1004 is refused, naming exactly the two modules the target lacks', async () => {
  const r = await buildClosureCase(closureProvider(UPD_1004))
  assert.equal(r.ok, false)
  const error = (r as { error: string }).error
  assert.match(error, /dependency closure failed/)
  assert.match(error, /app\/lib\/intake-workflow\.ts \(imported by app\/lib\/record-payment\.ts as "\.\/intake-workflow"\)/)
  assert.match(error, /app\/lib\/pack-services\.ts \(imported by app\/quote\/page\.tsx as "\.\.\/lib\/pack-services"\)/)
  assert.match(error, /missing 2 required modules/)
  // No false positives: redis and company resolve on the target and are not named.
  assert.doesNotMatch(error, /redis/)
  assert.doesNotMatch(error, /company/)
})

test('a closure-blocked build reads the target tree once and never reads target file content', async () => {
  const calls: Call[] = []
  const r = await buildClosureCase(closureProvider({ ...UPD_1004, calls }))
  assert.equal(r.ok, false)
  const tree = calls.filter(c => c.op === 'tree')
  const targetContent = calls.filter(c => c.op === 'content' && c.repo === TARGET.name)
  const baseline = calls.filter(c => c.op === 'content' && c.ref === 'source-parent')
  assert.equal(tree.length, 1, 'exactly one target-tree read')
  assert.equal(tree[0].ref, 'target-pinned-sha', 'and it uses the pinned targetBaseCommit, not the branch name')
  assert.equal(targetContent.length, 0, 'zero transfer-file content reads against the target')
  assert.equal(baseline.length, 0, 'zero source-baseline reads — drift never ran')
})

test('closure reads each source file once and the transfer loop reuses those bytes', async () => {
  const calls: Call[] = []
  const passing = {
    ...UPD_1004,
    targetPaths: [...UPD_1004.targetPaths, 'app/lib/intake-workflow.ts', 'app/lib/pack-services.ts'],
    calls,
  }
  const r = await buildClosureCase(closureProvider(passing))
  assert.equal(r.ok, true)
  if (!r.ok) return
  const perFile = new Map<string, number>()
  for (const c of calls) {
    if (c.op !== 'content' || c.repo !== REPO.name || c.ref !== 'source-new') continue
    perFile.set(c.path!, (perFile.get(c.path!) ?? 0) + 1)
  }
  for (const [path, n] of perFile) assert.equal(n, 1, `${path} must be fetched exactly once`)
  assert.deepEqual(r.data.closureCheckedPaths, ['app/lib/platform/tenancy/blob-keys.ts', 'app/lib/record-payment.ts', 'app/quote/page.tsx'])
})

test('closure passes once the prerequisite update has landed on the target', async () => {
  const r = await buildClosureCase(closureProvider({
    ...UPD_1004,
    targetPaths: [...UPD_1004.targetPaths, 'app/lib/intake-workflow.ts', 'app/lib/pack-services.ts'],
  }))
  assert.equal(r.ok, true, 'splitting UPD-1004 into ordered updates is what unblocks it')
})

test('a dependency that exists on the target with different content is not a closure failure', async () => {
  // company.ts differs on Supercharged because Supercharged is branded differently.
  // Closure checks existence; content belongs to the drift gate, and only for files
  // the manifest actually transfers.
  const r = await buildClosureCase(closureProvider({
    files: [{ filename: 'app/quote/page.tsx', status: 'modified' }],
    sources: { 'app/quote/page.tsx': `import { COMPANY } from '../lib/company'\n` },
    targetPaths: ['app/quote/page.tsx', 'app/lib/company.ts'],
  }))
  assert.equal(r.ok, true)
})

test('a dependency the owner excluded for this target is refused with its own message', async () => {
  const r = await buildClosureCase(closureProvider({
    files: [
      { filename: 'app/quote/page.tsx', status: 'modified' },
      { filename: 'app/lib/branding.ts', status: 'modified' },
    ],
    sources: {
      'app/quote/page.tsx': `import { BRAND } from '../lib/branding'\n`,
      'app/lib/branding.ts': `export const BRAND = 'x'\n`,
    },
    targetPaths: [],
  }), { status: 'compatible_with_changes', pathsToExclude: ['app/lib/branding.ts'] })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /app\/lib\/branding\.ts is excluded for this target but required by app\/quote\/page\.tsx/)
})

test('a renamed file is still refused before closure ever runs', async () => {
  const calls: Call[] = []
  const r = await buildClosureCase(closureProvider({
    files: [{ filename: 'app/new-name.ts', status: 'renamed' }],
    sources: { 'app/new-name.ts': `import x from './missing'\n` },
    targetPaths: [], calls,
  }))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /renamed files require a separate reviewed update/)
  assert.equal(calls.length, 0, 'the rename guard runs before the tree read')
})

test('a target-tree read failure fails closed with zero content reads', async () => {
  const calls: Call[] = []
  const r = await buildClosureCase(closureProvider({ ...UPD_1004, calls, treeError: 'target tree listing was truncated — cannot verify dependencies' }))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /read target tree: .*truncated/)
  assert.equal(calls.filter(c => c.op === 'content').length, 0)
})

test('a delete-only manifest needs no closure analysis and still transfers', async () => {
  const calls: Call[] = []
  const r = await buildClosureCase(closureProvider({
    files: [{ filename: 'app/gone.ts', status: 'removed' }],
    sources: { 'app/gone.ts': `import x from './anything-at-all'\n` },
    targetPaths: [], calls,
  }))
  assert.equal(r.ok, true, 'deleting a file cannot introduce an import')
  if (!r.ok) return
  assert.deepEqual(r.data.closureCheckedPaths, [])
  assert.equal(calls.filter(c => c.op === 'content' && c.ref === 'source-new').length, 0)
})

test('closure runs after the compatibility gate — a repudiated target never reaches it', async () => {
  const calls: Call[] = []
  const r = await buildClosureCase(closureProvider({ ...UPD_1004, calls }), { status: 'incompatible' })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /compatibility status does not allow/)
  assert.equal(calls.length, 0, 'no tree read, no content read')
})

test('a non-literal dynamic import in a transferred file blocks the transfer', async () => {
  const r = await buildClosureCase(closureProvider({
    files: [{ filename: 'app/a.ts', status: 'modified' }],
    sources: { 'app/a.ts': `const mod = await import(process.env.PLUGIN!)\n` },
    targetPaths: [],
  }))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /non-literal dynamic import/)
})
