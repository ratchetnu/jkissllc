// ── Operion exported-symbol verification — PURE analysis (issue #48 §9) ──────
//
// WHY THIS EXISTS. `closure.ts` answers "does every local module a transferred file
// imports actually EXIST on the target?" and says so in its own words: "EXISTENCE
// ONLY, NEVER CONTENT." That is the right call for content — Supercharged's
// `company.ts` differs because Supercharged is branded differently, and a
// content-comparing gate would block every transfer forever.
//
// But existence is not sufficiency. Measured against the real repositories:
//
//     scripts/multitenant-phase1.test.ts:66
//       import { isPlatformOwner } from '../app/api/admin/_lib/session'
//
// `app/api/admin/_lib/session.ts` EXISTS on Supercharged, so closure passes. Its copy
// does not EXPORT `isPlatformOwner` (J KISS's does). Commit `e014ad25` therefore clears
// rename, drift and closure, dispatches, burns a workflow run, and dies in the target's
// `npx tsc --noEmit`. This module closes exactly that gap and nothing wider: between
// "the file is there" and "the bytes match" sits "the names this transfer needs are
// exported".
//
// FAIL OPEN, NEVER FAIL CONFUSED. A false positive blocks a legitimate transfer and
// teaches the owner to distrust every gate; a false negative merely restores today's
// behaviour, which the target's own typecheck still catches. So anything this module
// cannot parse with certainty marks the module `unanalyzable` and is SKIPPED. Every
// such form is enumerated in `UNANALYZABLE` below and pinned by test.
//
// NO DOUBLE REPORTING. A module that is absent from the target is closure's failure,
// not ours; a specifier that escapes the repository root is closure's too. This module
// only ever speaks about modules that are present on the target and analysable.
//
// PURE — no I/O, no provider, no clock. The caller fetches target sources between
// `collectTargetModules()` and `analyzeSymbols()`.

import { lexicalView, matchStartsInCode, resolveCandidates, isCodePath, DEFAULT_ALIASES, type AliasMap } from './closure'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** What a target module exports, or why we refuse to guess. */
export type ExportSurface = { names: ReadonlySet<string>; unanalyzable: boolean; reason?: string }

export type SymbolProblem =
  | { kind: 'missing_export'; module: string; importer: string; specifier: string; names: string[] }
  | { kind: 'limit_exceeded'; value: number }

export type SymbolResult =
  | { ok: true; checkedModules: string[]; skippedModules: { module: string; reason: string }[] }
  | { ok: false; problems: SymbolProblem[] }

/**
 * Distinct target modules whose source may be read. Bounded for the same reason
 * `closure.ts` bounds its traversal: to cap a pathological or hostile graph, not to
 * shape normal behaviour. Measured against the real candidates — `106846c0` needs 0
 * reads, `17ac1972` needs ~12.
 */
export const DEFAULT_MAX_TARGET_MODULES = 150

// ── Export-surface extraction ────────────────────────────────────────────────

/**
 * Forms whose presence means the module's export surface is not statically knowable
 * here. Matched against the MASKED view, so the same words inside a comment or string
 * do not disarm the gate.
 */
const UNANALYZABLE: { re: RegExp; reason: string }[] = [
  { re: /^[ \t]*export\s+\*/m, reason: 're-export barrel (export *)' },
  { re: /^[ \t]*export\s+(?:declare\s+)?(?:const|let|var)\s*[{[]/m, reason: 'destructuring export' },
  { re: /^[ \t]*export\s*=/m, reason: 'TypeScript export assignment (export =)' },
  { re: /\bmodule\.exports\b/, reason: 'CommonJS module.exports' },
  { re: /\bexports\.[A-Za-z0-9_$]+\s*=/, reason: 'CommonJS exports.<name>' },
  { re: /^[ \t]*declare\s+module\b/m, reason: 'ambient module declaration' },
]

/** `export [declare] [async] (const|function|class|type|interface|enum|namespace) NAME` */
const EXPORT_DECL = /^[ \t]*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\*?|class|type|interface|enum|namespace)\s+([A-Za-z0-9_$]+)/gm
/** `export { a, b as c, type D }` — with or without a trailing `from '...'`. */
const EXPORT_CLAUSE = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm
const EXPORT_DEFAULT = /^[ \t]*export\s+default\b/gm
/** `export const|let|var` statement head, used for the multi-declarator guard. */
const EXPORT_VAR = /^[ \t]*export\s+(?:declare\s+)?(?:const|let|var)\s+/gm

/**
 * A second declarator after the first initializer — `export const a = 1, b = 2`. Only
 * the first name is captured by `EXPORT_DECL`, so rather than guess at the rest we
 * refuse to analyse the module.
 *
 * The comma must be at bracket depth 0 AND after the statement's first top-level `=`.
 * That is what separates a real second declarator from the commas inside a type
 * annotation (`export const M: Record<string, number> = …`) or an object literal,
 * without needing to parse generics.
 */
function hasSecondDeclarator(code: string, from: number): boolean {
  let depth = 0
  let seenAssign = false
  for (let i = from; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue }
    if (depth < 0) return false
    if (depth > 0) continue
    if (ch === '\n' && seenAssign) return false      // statement ended, no second declarator
    if (ch === ';') return false
    if (ch === '=' && code[i + 1] !== '=' && code[i - 1] !== '=' && code[i - 1] !== '!' && code[i - 1] !== '<' && code[i - 1] !== '>') seenAssign = true
    else if (ch === ',' && seenAssign) return true
  }
  return false
}

/**
 * Names a module exports. Generous where it is certain, and honest where it is not:
 * an unrecognised export style must never read as "exports nothing", so a non-empty
 * module with zero recognised exports is reported unanalyzable rather than empty.
 */
export function extractExports(source: string, path?: string): ExportSurface {
  const empty = new Set<string>()
  if (path && path.endsWith('.d.ts')) return { names: empty, unanalyzable: true, reason: 'declaration file' }

  const { code, mask } = lexicalView(source)
  for (const { re, reason } of UNANALYZABLE) {
    if (re.test(code)) return { names: empty, unanalyzable: true, reason }
  }

  const names = new Set<string>()
  const add = (raw: string): void => {
    // `a as b` exports the OUTWARD name `b`; an inline `type` modifier is not a name.
    const t = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
    if (t && /^[A-Za-z0-9_$]+$/.test(t)) names.add(t)
  }

  for (const re of [EXPORT_DECL, EXPORT_CLAUSE, EXPORT_DEFAULT] as RegExp[]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      if (!matchStartsInCode(mask, m)) continue
      if (re === EXPORT_DEFAULT) { names.add('default'); continue }
      if (re === EXPORT_CLAUSE) { for (const part of m[1].split(',')) add(part); continue }
      add(m[1])
    }
  }

  EXPORT_VAR.lastIndex = 0
  let v: RegExpExecArray | null
  while ((v = EXPORT_VAR.exec(code))) {
    if (!matchStartsInCode(mask, v)) continue
    if (hasSecondDeclarator(code, v.index + v[0].length)) {
      return { names: empty, unanalyzable: true, reason: 'multi-declarator export' }
    }
  }

  // Backstop, and the single most important line in this module: ZERO recognised
  // exports is never evidence that a module exports nothing. It is evidence that we
  // could not read it — an export style we do not know, an empty read, a truncated
  // response. Claiming "exports nothing" here would refuse every transfer whose files
  // import a module we merely failed to parse. Unanalyzable, always.
  if (!names.size) return { names: empty, unanalyzable: true, reason: 'no recognisable export form' }
  return { names, unanalyzable: false }
}

// ── Named-import extraction ──────────────────────────────────────────────────

/** `import … from '…'` (any clause shape). Braced bindings are pulled out below. */
const IMPORT_FROM = /^[ \t]*import\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm
/** `export { a } from '…'` — a re-export reads names out of another module too. */
const REEXPORT_FROM = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm

/**
 * Named bindings a file reads out of each specifier.
 *
 * Deliberately excludes:
 *   • default imports — `export default async function|class|{…}` and re-exported
 *     defaults have too many shapes to assert confidently, and the demonstrated
 *     failure is a named binding. Scope limit, pinned by test.
 *   • namespace imports (`import * as ns`) — no named binding to verify.
 * `import { a as b }` yields `a`: the name the MODULE must export, never the alias.
 */
export function extractNamedImports(source: string): { spec: string; names: string[] }[] {
  const { code, mask } = lexicalView(source)
  const bySpec = new Map<string, Set<string>>()
  const record = (spec: string, clause: string): void => {
    const set = bySpec.get(spec) ?? new Set<string>()
    for (const part of clause.split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
      if (n && /^[A-Za-z0-9_$]+$/.test(n)) set.add(n)
    }
    if (set.size) bySpec.set(spec, set)
  }

  IMPORT_FROM.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_FROM.exec(code))) {
    if (!matchStartsInCode(mask, m)) continue
    const braced = /\{([^}]*)\}/.exec(m[1])
    if (braced) record(m[2], braced[1])
  }
  REEXPORT_FROM.lastIndex = 0
  while ((m = REEXPORT_FROM.exec(code))) {
    if (!matchStartsInCode(mask, m)) continue
    record(m[2], m[1])
  }
  return [...bySpec].map(([spec, names]) => ({ spec, names: [...names].sort() }))
}

// ── Traversal ────────────────────────────────────────────────────────────────

export type SymbolInput = {
  /** Every path in the manifest AFTER exclusions, excluding deletes. */
  manifestPaths: string[]
  /** Source text for manifest code paths (the builder already caches these). */
  sourceOf: (path: string) => string | undefined
  /** Every path in the target repository at the pinned targetBaseCommit. */
  targetPaths: string[]
  aliases?: AliasMap
  maxTargetModules?: number
}

/**
 * Which target modules must be read to run the gate — resolved BEFORE any I/O so the
 * builder can fetch them in one pass and this module can stay pure.
 *
 * The set is disjoint from what the drift loop reads (manifest paths on the target),
 * so no file is ever fetched twice.
 */
export function collectTargetModules(input: SymbolInput): { modules: string[]; overflow: boolean } {
  const manifest = new Set(input.manifestPaths)
  const target = new Set(input.targetPaths)
  const aliases = input.aliases ?? DEFAULT_ALIASES
  const max = input.maxTargetModules ?? DEFAULT_MAX_TARGET_MODULES
  const modules = new Set<string>()

  for (const file of input.manifestPaths) {
    if (!isCodePath(file)) continue
    const source = input.sourceOf(file)
    if (source === undefined) continue
    for (const { spec } of extractNamedImports(source)) {
      const candidates = resolveCandidates(file, spec, aliases)
      if (!candidates || !candidates.length) continue          // bare package / escapes root
      if (candidates.some((c) => manifest.has(c))) continue    // the transfer supplies it
      const hit = candidates.find((c) => target.has(c))
      if (!hit || !isCodePath(hit)) continue                   // absent → closure's problem
      modules.add(hit)
    }
  }
  const list = [...modules].sort()
  return { modules: list.slice(0, max), overflow: list.length > max }
}

/**
 * For every named binding a transferred file reads out of a module that ALREADY EXISTS
 * on the target, require the target's copy to export that name.
 *
 * A module whose source was not supplied (not fetched, or over the cap) is treated as
 * unanalyzable and skipped — the caller's read budget can never turn into a refusal.
 */
export function analyzeSymbols(
  input: SymbolInput & { targetSourceOf: (path: string) => string | undefined; overflow?: boolean },
): SymbolResult {
  if (input.overflow) {
    return { ok: false, problems: [{ kind: 'limit_exceeded', value: input.maxTargetModules ?? DEFAULT_MAX_TARGET_MODULES }] }
  }
  const manifest = new Set(input.manifestPaths)
  const target = new Set(input.targetPaths)
  const aliases = input.aliases ?? DEFAULT_ALIASES

  const problems: SymbolProblem[] = []
  const surfaces = new Map<string, ExportSurface>()
  const checked = new Set<string>()
  const skipped = new Map<string, string>()

  for (const file of input.manifestPaths) {
    if (!isCodePath(file)) continue
    const source = input.sourceOf(file)
    if (source === undefined) continue

    for (const { spec, names } of extractNamedImports(source)) {
      const candidates = resolveCandidates(file, spec, aliases)
      if (!candidates || !candidates.length) continue
      if (candidates.some((c) => manifest.has(c))) continue
      const mod = candidates.find((c) => target.has(c))
      if (!mod || !isCodePath(mod)) continue

      let surface = surfaces.get(mod)
      if (!surface) {
        const src = input.targetSourceOf(mod)
        surface = src === undefined
          ? { names: new Set<string>(), unanalyzable: true, reason: 'target source unavailable' }
          : extractExports(src, mod)
        surfaces.set(mod, surface)
      }
      if (surface.unanalyzable) { skipped.set(mod, surface.reason ?? 'unanalyzable'); continue }

      checked.add(mod)
      const missing = names.filter((n) => !surface!.names.has(n))
      if (missing.length) problems.push({ kind: 'missing_export', module: mod, importer: file, specifier: spec, names: missing })
    }
  }

  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    checkedModules: [...checked].sort(),
    skippedModules: [...skipped].map(([module, reason]) => ({ module, reason })).sort((a, b) => a.module.localeCompare(b.module)),
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────
// One line per problem, deterministic order, no file contents — the same discipline
// `describeClosureProblems` follows: say what and where, never what was inside.

export function describeSymbolProblems(problems: SymbolProblem[]): string {
  const missing = problems.filter((p): p is Extract<SymbolProblem, { kind: 'missing_export' }> => p.kind === 'missing_export')
  const parts: string[] = []
  if (missing.length) {
    const lines = [...new Set(missing.map(
      (p) => `${p.module} does not export ${p.names.map((n) => `\`${n}\``).join(', ')} (needed by ${p.importer} via "${p.specifier}")`,
    ))].sort()
    parts.push(`the target is missing ${lines.length === 1 ? 'an export' : 'exports'} this update needs: ${lines.join('; ')}`)
  }
  for (const p of problems) {
    if (p.kind === 'limit_exceeded') parts.push(`dependency surface exceeded the module limit (${p.value}) — split this update`)
  }
  return parts.join(' | ')
}
