// Dependency closure — the pure analysis half (issue #48 P1-1, Phase A).
//
// The gate exists because a commit-transfer manifest is a DIFF: self-sufficient in
// the tree it was authored against, not necessarily in the tree it lands in. These
// tests pin the resolver and the traversal without any network, so the engine can be
// reasoned about independently of the provider.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeClosure, describeClosureProblems, extractSpecifiers, isCodePath,
  normalizePath, resolveCandidates, DEFAULT_CLOSURE_LIMITS,
} from '../app/lib/platform/automation/closure'

// ── Specifier extraction ─────────────────────────────────────────────────────

test('every import form the codebase actually uses produces an edge', () => {
  const src = [
    `import { a } from './value'`,
    `import type { T } from './type-only'`,
    `import type Default from '../types/default'`,
    `import './side-effect'`,
    `import Thing, { other } from '@/lib/aliased'`,
    `export * from './barrel'`,
    `export * as ns from './barrel-ns'`,
    `export { x } from './re-export'`,
    `export type { Y } from './type-re-export'`,
    `const m = await import('./dynamic')`,
    `const r = require('./required')`,
    `import react from 'react'`,
    `import { NextRequest } from 'next/server'`,
  ].join('\n')
  const { specifiers } = extractSpecifiers(src)
  const got = specifiers.map(s => s.spec).sort()
  assert.deepEqual(got, [
    '../types/default', './barrel', './barrel-ns', './dynamic', './re-export',
    './required', './side-effect', './type-only', './type-re-export', './value',
    '@/lib/aliased', 'next/server', 'react',
  ])
  // Kind is retained for the operator-facing report.
  assert.equal(specifiers.find(s => s.spec === './type-only')?.kind, 'type-import')
  assert.equal(specifiers.find(s => s.spec === './barrel')?.kind, 're-export')
  assert.equal(specifiers.find(s => s.spec === './dynamic')?.kind, 'dynamic')
  assert.equal(specifiers.find(s => s.spec === './side-effect')?.kind, 'side-effect')
})

test('a non-literal dynamic import is reported, never silently ignored', () => {
  const { unresolvable } = extractSpecifiers(`const mod = await import(pathFromConfig)\n`)
  assert.equal(unresolvable.length, 1)
  assert.match(unresolvable[0].expression, /pathFromConfig/)
  // A literal dynamic import is resolvable and must NOT be reported.
  assert.equal(extractSpecifiers(`await import('./ok')`).unresolvable.length, 0)
})

test('comments and prose cannot become dependency edges or dynamic-import refusals', () => {
  const src = [
    `// never runs on import (only when executed directly)`,
    `// import './line-comment'`,
    `/* import thing from './block-comment' */`,
    `/* await import(blockExpression) */`,
    `const prose = "resolved on import (see below)"`,
    `const quoted = 'require(\"./quoted\")'`,
    `const escaped = "text \\\" import('./escaped') \\\" text"`,
    `const pattern = /import\\(notCode\\)/g`,
    `const classPattern = /[)]import(fake)/`,
  ].join('\n')
  const result = extractSpecifiers(src)
  assert.deepEqual(result, { specifiers: [], unresolvable: [] })
})

test('template prose is ignored but executable interpolation is analyzed', () => {
  const src = [
    'const prose = `',
    "import fake from './template-prose'",
    'await import(templateProse)',
    '`',
    "const real = `value: ${await import('./inside-expression')}`",
    'const blocked = `value: ${await import(chosenAtRuntime)}`',
  ].join('\n')
  const result = extractSpecifiers(src)
  assert.deepEqual(result.specifiers, [{ spec: './inside-expression', kind: 'dynamic' }])
  assert.equal(result.unresolvable.length, 1)
  assert.equal(result.unresolvable[0].expression, 'chosenAtRuntime')
})

test('comments adjacent to genuine imports do not hide executable dependencies', () => {
  const src = [
    `/* import './fake-before' */ import real from './real'`,
    `const dynamic = await import('./dynamic') // import(commentOnly)`,
    `const required = require('./required') /* require('./fake-after') */`,
  ].join('\n')
  const result = extractSpecifiers(src)
  assert.deepEqual(result.unresolvable, [])
  assert.deepEqual(result.specifiers.map((s) => s.spec).sort(), ['./dynamic', './real', './required'])
})

// ── Resolution ───────────────────────────────────────────────────────────────

test('normalizePath collapses . and .. and refuses to climb out of the repo', () => {
  assert.equal(normalizePath('app/lib/./x.ts'), 'app/lib/x.ts')
  assert.equal(normalizePath('app/lib/../quote/page.tsx'), 'app/quote/page.tsx')
  assert.equal(normalizePath('../escape.ts'), '')
})

test('relative specifiers resolve with extension and index precedence', () => {
  const c = resolveCandidates('app/lib/record-payment.ts', './intake-workflow')!
  assert.equal(c[0], 'app/lib/intake-workflow')
  assert.ok(c.indexOf('app/lib/intake-workflow.ts') < c.indexOf('app/lib/intake-workflow.tsx'))
  assert.ok(c.includes('app/lib/intake-workflow/index.ts'))
  // Parent traversal, the app/quote/page.tsx shape.
  assert.ok(resolveCandidates('app/quote/page.tsx', '../lib/pack-services')!.includes('app/lib/pack-services.ts'))
})

test('aliases resolve, longest prefix wins, and bare packages are ignored', () => {
  // tsconfig maps "@/*" → "./*" from the repo ROOT, so the real in-repo form is
  // `@/app/lib/comms` (see app/lib/comms/index.ts) — not `@/lib/…`.
  assert.ok(resolveCandidates('app/x.ts', '@/app/lib/comms')!.includes('app/lib/comms/index.ts'))
  assert.ok(resolveCandidates('app/x.ts', '@/app/components/ui/tokens')!.includes('app/components/ui/tokens.ts'))
  // A bare package is never a manifest concern.
  assert.equal(resolveCandidates('app/x.ts', 'react'), null)
  assert.equal(resolveCandidates('app/x.ts', 'next/server'), null)
  assert.equal(resolveCandidates('app/x.ts', '@vercel/blob'), null)
  // Longest matching alias prefix wins when a target configures more than one.
  const many = resolveCandidates('app/x.ts', '@lib/y', { '@/': '', '@lib/': 'app/lib/' })!
  assert.ok(many.includes('app/lib/y.ts'), 'the longer matching prefix must win')
})

test('a specifier that escapes the repository root resolves to nothing', () => {
  assert.deepEqual(resolveCandidates('app/x.ts', '../../../etc/passwd'), [])
})

// ── Traversal ────────────────────────────────────────────────────────────────

const src = (imports: string[]) => imports.map(i => `import x from '${i}'`).join('\n')

test('a manifest whose imports all resolve on the target passes', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/quote/page.tsx'],
    targetPaths: ['app/lib/dep.ts'],
    sourceOf: () => src(['../lib/dep', 'react']),
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.scannedPaths, ['app/quote/page.tsx'])
  assert.deepEqual(r.resolvedOnTarget, ['app/lib/dep.ts'])
})

test('a dependency satisfied by the manifest itself passes and is traversed', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts', 'app/b.ts'],
    targetPaths: ['app/lib/c.ts'],
    sourceOf: (p) => p === 'app/a.ts' ? src(['./b']) : src(['./lib/c']),
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.scannedPaths, ['app/a.ts', 'app/b.ts'], 'the manifest file pulled in must itself be scanned')
})

test('a missing dependency blocks and names the importer, specifier and chain', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts', 'app/b.ts'],
    targetPaths: [],
    sourceOf: (p) => p === 'app/a.ts' ? src(['./b']) : src(['./lib/gone']),
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  const miss = r.problems.find(p => p.kind === 'missing_dependency')
  assert.ok(miss && miss.kind === 'missing_dependency')
  assert.equal(miss.path, 'app/lib/gone.ts')
  assert.equal(miss.importer, 'app/b.ts')
  assert.equal(miss.specifier, './lib/gone')
  // Every manifest code file is a traversal root, so the shortest chain to the missing
  // module is [importer, missing]. The chain lengthens only when traversal passes
  // through a non-root module, which Phase A never does by design.
  assert.deepEqual(miss.chain, ['app/b.ts', 'app/lib/gone.ts'])
})

test('an import cycle terminates and is not an error', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts', 'app/b.ts'],
    targetPaths: [],
    sourceOf: (p) => p === 'app/a.ts' ? src(['./b']) : src(['./a']),
  })
  assert.equal(r.ok, true, 'a → b → a must resolve, not loop')
})

test('a barrel re-export is an edge like any other', () => {
  const blocked = analyzeClosure({
    manifestPaths: ['app/lib/index.ts'],
    targetPaths: [],
    sourceOf: () => `export * from './missing-member'\n`,
  })
  assert.equal(blocked.ok, false)
  const ok = analyzeClosure({
    manifestPaths: ['app/lib/index.ts'],
    targetPaths: ['app/lib/missing-member.ts'],
    sourceOf: () => `export * from './missing-member'\n`,
  })
  assert.equal(ok.ok, true)
})

test('a type-only import is required exactly like a value import', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts'],
    targetPaths: [],
    sourceOf: () => `import type { T } from './types'\n`,
  })
  assert.equal(r.ok, false, 'type imports are erased at runtime but tsc still needs them — tsc is the gate that failed')
})

test('an index-file dependency resolves through the directory form', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts'],
    targetPaths: ['app/lib/comms/index.ts'],
    sourceOf: () => src(['./lib/comms']),
  })
  assert.equal(r.ok, true)
})

test('a dependency the owner excluded for this target is a specific, distinct error', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts'],
    excludedPaths: ['app/lib/branded.ts'],
    targetPaths: [],
    sourceOf: () => src(['./lib/branded']),
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  const p = r.problems[0]
  assert.equal(p.kind, 'excluded_dependency')
  assert.match(describeClosureProblems(r.problems), /excluded for this target but required by app\/a\.ts/)
})

test('a malformed path that escapes the repository is refused', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts'],
    targetPaths: [],
    sourceOf: () => src(['../../../../etc/passwd']),
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.problems[0].kind, 'unsafe_dependency_path')
})

test('a non-literal dynamic import blocks the transfer', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/a.ts'],
    targetPaths: [],
    sourceOf: () => `const m = await import(chosenAtRuntime)\n`,
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.problems[0].kind, 'unresolvable_dynamic')
  assert.match(describeClosureProblems(r.problems), /non-literal dynamic import/)
})

test('non-code manifest entries transfer but are never traversed', () => {
  const r = analyzeClosure({
    manifestPaths: ['docs/guide.md', 'app/styles.css', 'app/a.ts'],
    targetPaths: [],
    sourceOf: (p) => p === 'app/a.ts' ? `` : `import x from './nowhere'`,
  })
  assert.equal(r.ok, true, 'markdown and css cannot import modules')
  if (!r.ok) return
  assert.deepEqual(r.scannedPaths, ['app/a.ts'])
  assert.equal(isCodePath('docs/guide.md'), false)
  assert.equal(isCodePath('app/a.tsx'), true)
})

test('traversal limits fail closed rather than truncating silently', () => {
  const chain = Array.from({ length: 30 }, (_, i) => `app/f${i}.ts`)
  const walk = { manifestPaths: chain, targetPaths: [], sourceOf: (p: string) => {
    const i = Number(p.match(/f(\d+)/)![1])
    return i < chain.length - 1 ? src([`./f${i + 1}`]) : ''
  } }
  // The module cap is the one that bites in Phase A (traversal is bounded by the
  // manifest), and it refuses rather than analysing a truncated subset.
  const modules = analyzeClosure({ ...walk, limits: { maxHops: 100, maxModules: 5 } })
  assert.equal(modules.ok, false)
  if (modules.ok) return
  assert.ok(modules.problems.some(p => p.kind === 'limit_exceeded' && p.limit === 'modules'))
  assert.match(describeClosureProblems(modules.problems), /split this update/)

  // The hop cap bounds the traversal loop itself.
  const hops = analyzeClosure({ ...walk, limits: { maxHops: 0, maxModules: 500 } })
  assert.equal(hops.ok, false)
  if (hops.ok) return
  assert.ok(hops.problems.some(p => p.kind === 'limit_exceeded' && p.limit === 'hops'))

  // Neither cap fires on a normal update.
  assert.equal(analyzeClosure(walk).ok, true)
  assert.equal(DEFAULT_CLOSURE_LIMITS.maxHops, 10)
  assert.equal(DEFAULT_CLOSURE_LIMITS.maxModules, 200)
})

// ── The incident ─────────────────────────────────────────────────────────────

test('UPD-1004: the two real missing modules are found, with no false positives', () => {
  // The shape measured from the real artefacts: source commit e42af39 (41 files),
  // target tree c619920. Only these two specifiers failed to resolve across the 36
  // code files in that manifest.
  const manifestPaths = [
    'app/lib/record-payment.ts', 'app/quote/page.tsx',
    'app/lib/ai/telemetry.ts', 'app/lib/businesses.ts', 'app/lib/job-learning.ts', 'app/lib/payment-proof.ts',
    'app/lib/platform/tenancy/blob-keys.ts', 'app/lib/platform/tenancy/tenant-resolve.ts',
    'app/api/book/route.ts',
  ]
  const targetPaths = [
    'app/lib/redis.ts', 'app/lib/company.ts', 'app/lib/bookings.ts', 'app/lib/stripe.ts',
    'app/lib/booking-notify.ts', 'app/api/admin/_lib/session.ts',
  ]
  const sources: Record<string, string> = {
    'app/lib/record-payment.ts': `import { onPaymentRecorded } from './intake-workflow'\nimport { redis } from './redis'\n`,
    'app/quote/page.tsx': `import { PACKS } from '../lib/pack-services'\nimport { COMPANY } from '../lib/company'\n`,
    'app/lib/ai/telemetry.ts': `import { redis } from '../redis'\n`,
    'app/lib/businesses.ts': `import { redis } from './redis'\n`,
    'app/lib/job-learning.ts': `import type { Booking } from './bookings'\n`,
    'app/lib/payment-proof.ts': `import { redis } from './redis'\n`,
    'app/lib/platform/tenancy/blob-keys.ts': ``,
    'app/lib/platform/tenancy/tenant-resolve.ts': `import { redis } from '../../redis'\n`,
    'app/api/book/route.ts': `import { NextRequest } from 'next/server'\nimport { saveBooking } from '../../lib/bookings'\nimport { getStripe } from '../../lib/stripe'\nimport { notify } from '../../lib/booking-notify'\n`,
  }
  const r = analyzeClosure({ manifestPaths, targetPaths, sourceOf: (p) => sources[p] })
  assert.equal(r.ok, false, 'UPD-1004 must be refused')
  if (r.ok) return

  const missing = r.problems.filter(p => p.kind === 'missing_dependency')
  assert.equal(missing.length, 2, 'exactly two missing modules, no false positives')
  assert.deepEqual(
    missing.map(p => p.kind === 'missing_dependency' ? [p.path, p.importer] : []).sort(),
    [['app/lib/intake-workflow.ts', 'app/lib/record-payment.ts'], ['app/lib/pack-services.ts', 'app/quote/page.tsx']],
  )
  const report = describeClosureProblems(r.problems)
  assert.match(report, /app\/lib\/intake-workflow\.ts \(imported by app\/lib\/record-payment\.ts as "\.\/intake-workflow"\)/)
  assert.match(report, /app\/lib\/pack-services\.ts \(imported by app\/quote\/page\.tsx as "\.\.\/lib\/pack-services"\)/)
})

test('UPD-1004 passes once the target already has the two modules', () => {
  const r = analyzeClosure({
    manifestPaths: ['app/lib/record-payment.ts', 'app/quote/page.tsx'],
    targetPaths: ['app/lib/intake-workflow.ts', 'app/lib/pack-services.ts', 'app/lib/redis.ts', 'app/lib/company.ts'],
    sourceOf: (p) => p === 'app/lib/record-payment.ts'
      ? `import { onPaymentRecorded } from './intake-workflow'\nimport { redis } from './redis'\n`
      : `import { PACKS } from '../lib/pack-services'\nimport { COMPANY } from '../lib/company'\n`,
  })
  assert.equal(r.ok, true, 'the prerequisite update having landed is exactly what unblocks this one')
})

test('a dependency that exists on the target with different content is NOT a closure problem', () => {
  // 54 of UPD-1004's resolved dependencies are content-divergent on Supercharged —
  // app/lib/company.ts differs because Supercharged is branded differently. Closure
  // checks existence; content is the drift gate's business, and only for files the
  // manifest actually transfers.
  const r = analyzeClosure({
    manifestPaths: ['app/quote/page.tsx'],
    targetPaths: ['app/lib/company.ts'],
    sourceOf: () => `import { COMPANY } from '../lib/company'\n`,
  })
  assert.equal(r.ok, true)
})
