// Exported-symbol verification (issue #48 §9) — the gate between "the module exists"
// (closure) and "the bytes match" (drift).
//
// The behaviour these tests defend is asymmetric on purpose. A CONFIDENT miss must
// block; anything else must not. So roughly half of this file asserts that the gate
// stays SILENT — on barrels, destructuring exports, CJS, declaration files, namespace
// imports, defaults, and any module it cannot parse. A false positive would refuse a
// legitimate transfer and teach the owner to distrust every gate; a false negative
// only restores the behaviour we had before, which the target's own typecheck catches.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeSymbols, collectTargetModules, describeSymbolProblems, extractExports, extractNamedImports,
  DEFAULT_MAX_TARGET_MODULES,
} from '../app/lib/platform/automation/exports'
import { buildCommitTransferManifest } from '../app/lib/platform/automation/manifest-builder'
import { sha256 } from '../app/lib/platform/automation/manifest'
import { evaluatePreflight } from '../app/lib/platform/automation/preflight'
import type { UpdateAutomationProvider } from '../app/lib/platform/automation/provider'

// ── Harness ──────────────────────────────────────────────────────────────────

/** Run the gate over one importer + one target module. */
function gate(opts: {
  importer?: string
  importerSource: string
  targetModule?: string
  targetSource?: string
  extraTargetPaths?: string[]
  manifestPaths?: string[]
  manifestSources?: Record<string, string>
}) {
  const importer = opts.importer ?? 'app/lib/importer.ts'
  const targetModule = opts.targetModule ?? 'app/lib/dep.ts'
  const manifestSources = { [importer]: opts.importerSource, ...(opts.manifestSources ?? {}) }
  const manifestPaths = opts.manifestPaths ?? Object.keys(manifestSources)
  const targetPaths = [
    ...(opts.targetSource === undefined ? [] : [targetModule]),
    ...(opts.extraTargetPaths ?? []),
  ]
  const input = {
    manifestPaths,
    sourceOf: (p: string) => manifestSources[p],
    targetPaths,
  }
  const plan = collectTargetModules(input)
  return {
    plan,
    result: analyzeSymbols({
      ...input,
      targetSourceOf: (p) => (p === targetModule ? opts.targetSource : undefined),
      overflow: plan.overflow,
    }),
  }
}

const problems = (r: ReturnType<typeof gate>['result']) => (r.ok ? [] : r.problems)

// ── Export-surface extraction ────────────────────────────────────────────────

test('every export form the codebase actually uses is recognised', () => {
  const surface = extractExports([
    `export const A = 1`,
    `export let B = 2`,
    `export function c() {}`,
    `export async function d() {}`,
    `export function* gen() {}`,
    `export class E {}`,
    `export abstract class F {}`,
    `export type G = string`,
    `export interface H { x: number }`,
    `export enum I { a }`,
    `export const enum J { b }`,
    `export declare function k(): void`,
    `export { local as L }`,
    `export { M, type N }`,
    `export default function () {}`,
  ].join('\n'))
  assert.equal(surface.unanalyzable, false)
  assert.deepEqual([...surface.names].sort(), [
    'A', 'B', 'E', 'F', 'G', 'H', 'I', 'J', 'L', 'M', 'N', 'c', 'd', 'default', 'gen', 'k',
  ])
})

test('a type annotation containing commas does not look like a second declarator', () => {
  const surface = extractExports(`export const MODEL: Record<string, number> = { a: 1, b: 2 }\n`)
  assert.equal(surface.unanalyzable, false, 'Record<string, number> must stay analysable')
  assert.deepEqual([...surface.names], ['MODEL'])
})

test('`export { x as y }` publishes the outward name, never the inner one', () => {
  const surface = extractExports(`const x = 1\nexport { x as y }\n`)
  assert.deepEqual([...surface.names], ['y'])
})

// ── Unanalyzable forms — the gate must stay silent ───────────────────────────

const UNANALYZABLE_FORMS: [string, string][] = [
  ['re-export barrel', `export * from './other'\n`],
  ['namespaced barrel', `export * as ns from './other'\n`],
  ['destructuring export', `export const { a, b } = thing\n`],
  ['array destructuring export', `export const [a, b] = thing\n`],
  ['multi-declarator export', `export const a = 1, b = 2\n`],
  ['TypeScript export assignment', `export = thing\n`],
  ['CommonJS module.exports', `module.exports = { a: 1 }\n`],
  ['CommonJS exports.<name>', `exports.a = 1\n`],
  ['ambient module declaration', `declare module 'x' { }\n`],
  ['no recognisable export form', `const a = 1\n`],
  ['empty or unreadable module', ``],
]

for (const [label, source] of UNANALYZABLE_FORMS) {
  test(`${label} marks the module unanalyzable, so the gate stays silent`, () => {
    assert.equal(extractExports(source).unanalyzable, true)
    const { result } = gate({ importerSource: `import { anything } from './dep'\n`, targetSource: source })
    assert.equal(result.ok, true, `${label} must never produce a symbol failure`)
  })
}

test('a declaration file is unanalyzable by path, whatever it contains', () => {
  assert.equal(extractExports(`export const A = 1\n`, 'app/lib/dep.d.ts').unanalyzable, true)
})

// ── Named-import extraction ──────────────────────────────────────────────────

test('named bindings are collected; namespace and default-only imports are not', () => {
  const got = extractNamedImports([
    `import { a, b as c } from './one'`,
    `import type { T } from './two'`,
    `import Def, { d } from './three'`,
    `import * as ns from './four'`,
    `import Solo from './five'`,
    `import './six'`,
    `export { e } from './seven'`,
    `import { type F, g } from './eight'`,
  ].join('\n'))
  assert.deepEqual(
    Object.fromEntries(got.map((x) => [x.spec, x.names])),
    { './one': ['a', 'b'], './two': ['T'], './three': ['d'], './seven': ['e'], './eight': ['F', 'g'] },
    'aliased imports resolve to the source name; * and default-only contribute nothing',
  )
})

test('import-shaped text inside comments, strings and templates is not an edge', () => {
  const got = extractNamedImports([
    `// import { fake } from './commented'`,
    `/* import { alsoFake } from './block' */`,
    `const s = "import { stringy } from './quoted'"`,
    'const t = `import { tpl } from \'./template\'`',
    `import { real } from './real'`,
  ].join('\n'))
  assert.deepEqual(got, [{ spec: './real', names: ['real'] }])
})

// ── The core verdict ─────────────────────────────────────────────────────────

test('a symbol the target module exports passes', () => {
  const { result } = gate({
    importerSource: `import { present } from './dep'\n`,
    targetSource: `export function present() {}\n`,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.checkedModules, ['app/lib/dep.ts'])
})

test('THE REGRESSION: a symbol the target does NOT export is refused, and named precisely', () => {
  // The real defect, in its real shape. Supercharged HAS app/api/admin/_lib/session.ts —
  // closure is satisfied — but its copy does not export isPlatformOwner, so e014ad25
  // clears every existing gate and then dies in the target's typecheck.
  const { result } = gate({
    importer: 'scripts/multitenant-phase1.test.ts',
    importerSource: `import { isPlatformOwner } from '../app/api/admin/_lib/session'\n`,
    targetModule: 'app/api/admin/_lib/session.ts',
    targetSource: [
      `export const COOKIE_NAME = 'jk_admin_session'`,
      `export async function requireAdmin() {}`,
      `export async function requirePermission() {}`,
    ].join('\n'),
  })
  assert.equal(result.ok, false)
  const p = problems(result)
  assert.equal(p.length, 1)
  assert.deepEqual(p[0], {
    kind: 'missing_export',
    module: 'app/api/admin/_lib/session.ts',
    importer: 'scripts/multitenant-phase1.test.ts',
    specifier: '../app/api/admin/_lib/session',
    names: ['isPlatformOwner'],
  })
  const text = describeSymbolProblems(p)
  assert.match(text, /app\/api\/admin\/_lib\/session\.ts does not export `isPlatformOwner`/)
  assert.match(text, /needed by scripts\/multitenant-phase1\.test\.ts/)
})

test('a symbol supplied by the transfer itself is never checked against the target', () => {
  const { result, plan } = gate({
    importerSource: `import { fresh } from './dep'\n`,
    manifestSources: { 'app/lib/dep.ts': `export const fresh = 1\n` },
    targetSource: `export const somethingElse = 1\n`,   // stale target copy — irrelevant
  })
  assert.equal(result.ok, true, 'the manifest supplies the module, so its exports are the source version')
  assert.deepEqual(plan.modules, [], 'and no target read is planned for it')
})

test('a module absent from the target is closure\'s failure, never reported twice here', () => {
  const { result } = gate({ importerSource: `import { x } from './dep'\n` })   // no targetSource
  assert.equal(result.ok, true, 'missing_dependency belongs to closure; this gate stays quiet')
})

test('bare package imports are ignored', () => {
  const { result, plan } = gate({
    importerSource: [
      `import { useState } from 'react'`,
      `import { NextRequest } from 'next/server'`,
      `import { put } from '@vercel/blob'`,
    ].join('\n'),
    targetSource: `export const unrelated = 1\n`,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(plan.modules, [])
})

test('an aliased import is checked against the source name, not the local alias', () => {
  const exportsOwner = `export function isPlatformOwner() {}\n`
  assert.equal(gate({ importerSource: `import { isPlatformOwner as owns } from './dep'\n`, targetSource: exportsOwner }).result.ok, true)
  // The alias is NOT what the module must export.
  const aliasOnly = gate({ importerSource: `import { isPlatformOwner as owns } from './dep'\n`, targetSource: `export function owns() {}\n` })
  assert.equal(aliasOnly.result.ok, false)
  const first = problems(aliasOnly.result)[0]
  assert.equal(first.kind, 'missing_export')
  assert.deepEqual(first.kind === 'missing_export' ? first.names : [], ['isPlatformOwner'])
})

test('a re-export satisfies the outward name and not the inner one', () => {
  const target = `const inner = 1\nexport { inner as outward }\n`
  assert.equal(gate({ importerSource: `import { outward } from './dep'\n`, targetSource: target }).result.ok, true)
  assert.equal(gate({ importerSource: `import { inner } from './dep'\n`, targetSource: target }).result.ok, false)
})

test('type-only imports are verified — a missing type is a typecheck failure too', () => {
  const target = `export interface Present { a: number }\nexport type Alias = string\n`
  assert.equal(gate({ importerSource: `import type { Present } from './dep'\n`, targetSource: target }).result.ok, true)
  assert.equal(gate({ importerSource: `import { type Alias } from './dep'\n`, targetSource: target }).result.ok, true)
  assert.equal(gate({ importerSource: `import type { Absent } from './dep'\n`, targetSource: target }).result.ok, false)
})

test('default imports are out of scope in v1 — deliberately, not by oversight', () => {
  const { result } = gate({
    importerSource: `import Whatever from './dep'\n`,
    targetSource: `export const named = 1\n`,   // no default export at all
  })
  assert.equal(result.ok, true, 'export-default shapes are too varied to assert confidently; named bindings are the demonstrated risk')
})

test('a re-export FROM a target module is verified like an import', () => {
  const { result } = gate({
    importerSource: `export { missing } from './dep'\n`,
    targetSource: `export const other = 1\n`,
  })
  assert.equal(result.ok, false)
})

test('a non-code dependency (json, css) is never symbol-checked', () => {
  const { plan } = gate({
    importer: 'app/lib/importer.ts',
    importerSource: `import { name } from './data.json'\n`,
    targetModule: 'app/lib/data.json',
    targetSource: `{ "name": 1 }`,
  })
  assert.deepEqual(plan.modules, [])
})

// ── Bounds ───────────────────────────────────────────────────────────────────

test('exceeding the distinct-module cap refuses and says to split the update', () => {
  const deps = Array.from({ length: DEFAULT_MAX_TARGET_MODULES + 1 }, (_, i) => `app/lib/d${i}.ts`)
  const importerSource = deps.map((d, i) => `import { s } from './d${i}'`).join('\n')
  const input = {
    manifestPaths: ['app/lib/importer.ts'],
    sourceOf: (p: string) => (p === 'app/lib/importer.ts' ? importerSource : undefined),
    targetPaths: deps,
  }
  const plan = collectTargetModules(input)
  assert.equal(plan.overflow, true)
  assert.equal(plan.modules.length, DEFAULT_MAX_TARGET_MODULES)
  const r = analyzeSymbols({ ...input, targetSourceOf: () => `export const s = 1\n`, overflow: plan.overflow })
  assert.equal(r.ok, false)
  assert.match(describeSymbolProblems(problems(r)), /exceeded the module limit \(150\).*split this update/)
})

test('a target module that could not be read is skipped, never refused', () => {
  const input = {
    manifestPaths: ['app/lib/importer.ts'],
    sourceOf: (p: string) => (p === 'app/lib/importer.ts' ? `import { x } from './dep'\n` : undefined),
    targetPaths: ['app/lib/dep.ts'],
  }
  const r = analyzeSymbols({ ...input, targetSourceOf: () => undefined })   // read failed
  assert.equal(r.ok, true, 'a transient read must never manufacture a blocking verdict')
  assert.deepEqual(r.ok && r.skippedModules, [{ module: 'app/lib/dep.ts', reason: 'target source unavailable' }])
})

// ── Integration through the real manifest builder ────────────────────────────

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const REPO = { owner: 'ratchetnu', name: 'jkissllc' }
const TARGET = { owner: 'ratchetnu', name: 'supercharged' }

type Call = { op: 'tree' | 'content'; repo: string; ref?: string; path?: string }

function builderProvider(opts: {
  files: { filename: string; status: string }[]
  sources: Record<string, string>
  targetPaths: string[]
  targetSources?: Record<string, string>
  calls?: Call[]
}): UpdateAutomationProvider {
  const calls = opts.calls ?? []
  const p: Partial<UpdateAutomationProvider> = {
    name: 'symbol-mock',
    readCommit: async (_i, _r, sha) => ({ ok: true, data: { sha, message: 'u', parentSha: 'source-parent', parentCount: 1 } }),
    readBranch: async () => ({ ok: true, data: { commit: 'target-pinned-sha' } }),
    readTree: async (_i, repo, sha) => { calls.push({ op: 'tree', repo: repo.name, ref: sha }); return { ok: true, data: { paths: opts.targetPaths } } },
    readCommitFiles: async () => ({ ok: true, data: { files: opts.files } }),
    readFileContent: async (_i, repo, path, ref) => {
      calls.push({ op: 'content', repo: repo.name, ref, path })
      if (repo.name === TARGET.name) {
        if (!opts.targetPaths.includes(path)) return { ok: false, error: 'not found', category: 'not_found' }
        // Target copy: an explicit override, else byte-identical to source so drift never fires.
        const v = opts.targetSources?.[path] ?? opts.sources[path] ?? ''
        return { ok: true, data: { contentBase64: b64(v), sha256: sha256(v) } }
      }
      const v = opts.sources[path]
      if (v === undefined) return { ok: false, error: 'not found', category: 'not_found' }
      return { ok: true, data: { contentBase64: b64(v), sha256: sha256(v) } }
    },
  }
  return p as UpdateAutomationProvider
}

const build = (provider: UpdateAutomationProvider) => buildCommitTransferManifest({
  provider, installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc',
  sourceCommit: 'source-new', targetRepo: TARGET, targetBranch: 'main',
  updateKey: 'UPD-TEST', compatibility: { status: 'compatible' },
})

test('builder: a symbol-clean transfer builds and reports the modules it verified', async () => {
  const r = await build(builderProvider({
    files: [{ filename: 'app/lib/new.ts', status: 'added' }],
    sources: { 'app/lib/new.ts': `import { helper } from './dep'\nexport const n = helper\n` },
    targetPaths: ['app/lib/dep.ts'],
    targetSources: { 'app/lib/dep.ts': `export function helper() {}\n` },
  }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.data.symbolCheckedPaths, ['app/lib/dep.ts'])
})

test('builder: a symbol-dirty transfer is refused with an actionable message', async () => {
  const r = await build(builderProvider({
    files: [{ filename: 'scripts/multitenant-phase1.test.ts', status: 'added' }],
    sources: { 'scripts/multitenant-phase1.test.ts': `import { isPlatformOwner } from '../app/api/admin/_lib/session'\n` },
    targetPaths: ['app/api/admin/_lib/session.ts'],
    targetSources: { 'app/api/admin/_lib/session.ts': `export async function requireAdmin() {}\n` },
  }))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /symbol verification failed/)
  assert.match((r as { error: string }).error, /does not export `isPlatformOwner`/)
})

test('builder: closure speaks first — a manifest failing both reports the missing MODULE, not the symbol', async () => {
  const calls: Call[] = []
  const r = await build(builderProvider({
    files: [{ filename: 'app/lib/new.ts', status: 'added' }],
    sources: { 'app/lib/new.ts': `import { gone } from './absent'\n` },
    targetPaths: [],                                   // module absent entirely
    calls,
  }))
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /dependency closure failed/)
  assert.doesNotMatch((r as { error: string }).error, /symbol verification/)
  assert.equal(calls.filter((c) => c.op === 'content' && c.repo === TARGET.name).length, 0,
    'a closure-blocked build still performs zero target content reads')
})

test('builder: an excluded path is not symbol-checked as part of the transfer', async () => {
  const calls: Call[] = []
  const r = await buildCommitTransferManifest({
    provider: builderProvider({
      files: [
        { filename: 'app/lib/kept.ts', status: 'added' },
        { filename: 'app/lib/company.ts', status: 'modified' },
      ],
      sources: { 'app/lib/kept.ts': `export const k = 1\n`, 'app/lib/company.ts': `export const COMPANY = {}\n` },
      targetPaths: ['app/lib/company.ts'],
      calls,
    }),
    installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'source-new', targetRepo: TARGET, targetBranch: 'main',
    updateKey: 'UPD-TEST', compatibility: { status: 'compatible', pathsToExclude: ['app/lib/company.ts'] },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.data.excludedPaths, ['app/lib/company.ts'])
  assert.deepEqual(r.ok && r.data.symbolCheckedPaths, [], 'nothing in the kept set imports it, so nothing was read for symbols')
})

test('builder: symbol reads never duplicate the drift loop\'s target reads', async () => {
  const calls: Call[] = []
  await build(builderProvider({
    files: [{ filename: 'app/lib/new.ts', status: 'added' }],
    sources: { 'app/lib/new.ts': `import { helper } from './dep'\n` },
    targetPaths: ['app/lib/dep.ts'],
    targetSources: { 'app/lib/dep.ts': `export function helper() {}\n` },
    calls,
  }))
  const targetReads = calls.filter((c) => c.op === 'content' && c.repo === TARGET.name).map((c) => c.path)
  assert.deepEqual([...new Set(targetReads)].sort(), targetReads.sort(), 'no target path is read twice')
  for (const c of calls) {
    if (c.op === 'content' && c.repo === TARGET.name) {
      assert.equal(c.ref, 'target-pinned-sha', 'symbol reads use the pinned base commit, not the branch name')
    }
  }
})

// ── Preflight behaviour: fail closed BEFORE a job exists ─────────────────────

test('a symbol failure fails the blocking transfer_ready gate, so no job is ever created', () => {
  // This mirrors how the orchestrator feeds checkTransferReady()'s verdict into
  // preflight. preparePreview() returns on !preflight.ok BEFORE nextJobId(), so a
  // blocking transfer_ready means: no job, no branch, no dispatch, no PR, no preview.
  const base = {
    update: {
      key: 'UPD-TEST', status: 'approved', sourceCommit: 'abc', sourceRepo: 'ratchetnu/jkissllc',
      validation: { tests: 'passed', build: 'passed' }, rollbackSupported: true,
    },
    business: {
      id: 'supercharged', role: 'target', configurationStatus: 'ready', repoName: 'ratchetnu/supercharged',
      githubInstallationId: '1', automationWorkflowFile: 'operion-update.yml', defaultBranch: 'main',
      previewProjectId: 'prj', previewDeploymentProvider: 'vercel', healthStatus: 'ok',
    },
    compat: { status: 'compatible' },
    hasActiveJob: false,
    flags: { automation: true, preview: true, githubActions: true, controlPlane: true },
  } as unknown as Parameters<typeof evaluatePreflight>[0]

  const clean = evaluatePreflight({ ...base, transferReady: { ok: true } })
  assert.equal(clean.ok, true, 'a clean transfer still passes every gate — the gate is not blanket-blocking')

  const dirty = evaluatePreflight({
    ...base,
    transferReady: { ok: false, reason: 'symbol verification failed — app/api/admin/_lib/session.ts does not export `isPlatformOwner`' },
  })
  assert.equal(dirty.ok, false)
  const g = dirty.gates.find((x) => x.id === 'transfer_ready')
  assert.equal(g?.ok, false)
  assert.equal(g?.blocking, true)
  assert.match(g?.reason ?? '', /does not export `isPlatformOwner`/)
})

test('an unevaluated transfer check (no credentials) leaves the gate green, exactly as before', () => {
  const r = evaluatePreflight({
    update: { key: 'U', status: 'approved', sourceCommit: 'abc', validation: { tests: 'passed', build: 'passed' }, rollbackSupported: true },
    business: {
      id: 'b', role: 'target', configurationStatus: 'ready', repoName: 'o/n', githubInstallationId: '1',
      automationWorkflowFile: 'w.yml', defaultBranch: 'main', previewProjectId: 'p', previewDeploymentProvider: 'vercel',
    },
    compat: { status: 'compatible' },
    hasActiveJob: false,
    flags: { automation: true, preview: true, githubActions: true, controlPlane: true },
  } as unknown as Parameters<typeof evaluatePreflight>[0])
  assert.equal(r.gates.find((x) => x.id === 'transfer_ready')?.ok, true)
})
