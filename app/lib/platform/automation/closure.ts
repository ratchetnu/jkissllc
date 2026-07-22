// ── Operion dependency closure — PURE analysis (Phase A: detect, never complete) ──
//
// WHY THIS EXISTS. A commit-transfer manifest is a DIFF, and a diff is only
// self-sufficient in the tree it was authored against. UPD-1004 modified
// `app/lib/record-payment.ts` and `app/quote/page.tsx` in J KISS, where
// `app/lib/intake-workflow.ts` and `app/lib/pack-services.ts` already existed.
// Supercharged had never received the commit that created them, so the transfer
// applied cleanly and then failed typecheck in the target's CI — after the run had
// been dispatched, and with no signal at approval time. See issue #48.
//
// This module answers the one question the pipeline never asked:
//
//     does every local module a transferred file imports actually exist,
//     either in this manifest or already on the target?
//
// IT DETECTS. IT DOES NOT COMPLETE. Auto-adding the missing modules was measured
// against the real incident: closing UPD-1004 transitively would have grown the
// transfer from 41 files to 59, pulling in the platform event bus, the approvals
// state machine, and the AI-workers governance layer — three subsystems the owner
// never reviewed. That breaks the provenance guarantee the manifest builder exists
// to hold ("exactly what the update changed and nothing else") and would ship a
// silent three-feature merge under one approval. So an incomplete update is
// REPORTED and REFUSED; the owner splits it into ordered updates.
//
// EXISTENCE ONLY, NEVER CONTENT. 54 dependencies that UPD-1004's files import
// already exist on Supercharged with different bytes — `app/lib/company.ts` differs
// because Supercharged is branded differently, and that is correct. A closure gate
// that compared content would block every Supercharged transfer forever. Content
// divergence on a file being TRANSFERRED is the drift gate's business
// (manifest-builder three-way compare); content divergence on a file merely
// REFERENCED is none of our business.
//
// PURE — no I/O, no provider, no clock. Every input arrives as an argument, so the
// resolver and the traversal are unit-testable without a network.

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** How one module reached another. Kept for the operator-facing report. */
export type EdgeKind = 'import' | 'type-import' | 're-export' | 'dynamic' | 'require' | 'side-effect'

export type Specifier = { spec: string; kind: EdgeKind }

/**
 * A dynamic `import()` whose argument is not a string literal. It cannot be
 * resolved statically, so it is reported rather than ignored — an unanalysable
 * edge is a hole in the guarantee, not an absence of one.
 */
export type UnresolvableExpression = { expression: string; kind: 'dynamic' }

export type ClosureLimits = {
  /** Maximum traversal depth from the manifest's own files. */
  maxHops: number
  /** Maximum modules visited before refusing. Guards a pathological graph. */
  maxModules: number
}

// Measured against the real incident: UPD-1004 needed 5 hops / 18 modules to close
// transitively, and 130 modules are reachable from its 41 files. Phase A only walks
// files that are IN the manifest, so these caps are far above any legitimate update
// and exist to bound a pathological or hostile graph, not to shape normal behaviour.
//
// Note on which cap actually bites in Phase A: every manifest code file is seeded as
// a traversal root, so discovery depth is shallow by construction and `maxModules`
// (bounded by the manifest size) is the operative limit. `maxHops` bounds the loop
// itself and is the forward guard for Phase B, where traversal may follow modules
// that are not already in the transfer.
export const DEFAULT_CLOSURE_LIMITS: ClosureLimits = { maxHops: 10, maxModules: 200 }

/**
 * Path aliases, longest-prefix-wins. Verified identical in both repositories today
 * (`tsconfig.json` → `paths: { "@/*": ["./*"] }`), but passed in rather than
 * hardcoded so a target with a different map is a configuration decision and not a
 * silent mis-resolution.
 */
export type AliasMap = Record<string, string>
export const DEFAULT_ALIASES: AliasMap = { '@/': '' }

/** Extensions tried for an extensionless specifier, in resolution order. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json', '.css']

/** Files whose imports are followed. Everything else transfers but is a leaf. */
const CODE = /\.(ts|tsx|mts|js|jsx|mjs)$/

export const isCodePath = (path: string): boolean => CODE.test(path)

// ── Problems ─────────────────────────────────────────────────────────────────
// Every refusal names the missing module, who imported it, how, and the chain that
// reached it — so the operator can act without opening a CI log.

export type ClosureProblem =
  | { kind: 'missing_dependency'; path: string; importer: string; specifier: string; chain: string[] }
  | { kind: 'excluded_dependency'; path: string; importer: string; specifier: string; chain: string[] }
  | { kind: 'unresolvable_dynamic'; importer: string; expression: string; chain: string[] }
  | { kind: 'unsafe_dependency_path'; path: string; importer: string; specifier: string; chain: string[] }
  | { kind: 'limit_exceeded'; limit: 'hops' | 'modules'; value: number }

export type ClosureResult =
  | { ok: true; scannedPaths: string[]; resolvedOnTarget: string[] }
  | { ok: false; problems: ClosureProblem[] }

// ── Specifier extraction ─────────────────────────────────────────────────────
// Deliberately regex-based rather than a TypeScript program: the builder runs in a
// serverless request, must not depend on the compiler API, and only needs the module
// graph — not types. A small lexical mask below prevents regex matches from starting
// inside comments, strings, template text, or regular-expression literals. This
// keeps prose from becoming a false edge while preserving real code in `${...}`.

const PATTERNS: { re: RegExp; kind: EdgeKind }[] = [
  // import type { T } from './x'   /   import type X from './x'
  { re: /^[ \t]*import\s+type\s+[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/gm, kind: 'type-import' },
  // import X, { y } from './x'
  { re: /^[ \t]*import\s+(?!type\s)[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/gm, kind: 'import' },
  // import './x'   (side effect)
  { re: /^[ \t]*import\s*['"]([^'"]+)['"]/gm, kind: 'side-effect' },
  // export * from './x'   /   export { a } from './x'   /   export type { T } from './x'
  { re: /^[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm, kind: 're-export' },
  // await import('./x')
  { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'dynamic' },
  // require('./x')
  { re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'require' },
]

/** A dynamic import whose argument is not a plain string literal. */
const DYNAMIC_NON_LITERAL = /\bimport\s*\(\s*(?!['"]\s*[^'"]*['"]\s*\))([^)]{0,80})\)/g

/** Characters at which a regex literal may begin rather than a division operator. */
const REGEX_PREFIX = new Set(['(', '[', '{', '=', ':', ',', ';', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>'])
const REGEX_PREFIX_WORDS = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await', 'else', 'do'])

/**
 * Mark positions that are executable code. The mask is intentionally lexical, not
 * syntactic: extraction still owns import grammar, while this pass only prevents a
 * match from beginning inside non-code text. Template interpolation is code and is
 * scanned recursively; template prose is not.
 *
 * Exported so the exported-symbol gate (`exports.ts`) masks text the same way this
 * module does. One lexer, one set of edge cases — a second copy would drift.
 */
export function lexicalView(source: string): { code: string; mask: Uint8Array } {
  const mask = new Uint8Array(source.length)
  const view = [...source]
  type Context = { kind: 'code'; templateExpression: boolean; braces: number } | { kind: 'template' }
  const stack: Context[] = [{ kind: 'code', templateExpression: false, braces: 0 }]
  let i = 0
  let previousToken = ''

  const hide = (start: number, end: number): void => {
    for (let j = start; j < end; j++) if (view[j] !== '\n' && view[j] !== '\r') view[j] = ' '
  }

  const rememberToken = (end: number): void => {
    let j = end - 1
    while (j >= 0 && /\s/.test(source[j])) j--
    if (j < 0) { previousToken = ''; return }
    if (/[A-Za-z0-9_$]/.test(source[j])) {
      let start = j
      while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start--
      previousToken = source.slice(start, j + 1)
    } else previousToken = source[j]
  }

  const skipQuoted = (quote: "'" | '"'): void => {
    i++
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue }
      if (source[i] === quote) { i++; return }
      i++
    }
  }

  const regexCanStart = (): boolean => !previousToken || REGEX_PREFIX.has(previousToken) || REGEX_PREFIX_WORDS.has(previousToken)

  while (i < source.length) {
    const context = stack[stack.length - 1]

    if (context.kind === 'template') {
      if (source[i] === '\\') { hide(i, Math.min(source.length, i + 2)); i += 2; continue }
      if (source[i] === '`') { hide(i, i + 1); i++; stack.pop(); previousToken = 'value'; continue }
      if (source[i] === '$' && source[i + 1] === '{') {
        mask[i] = 1; mask[i + 1] = 1
        i += 2
        stack.push({ kind: 'code', templateExpression: true, braces: 0 })
        previousToken = '{'
        continue
      }
      hide(i, i + 1)
      i++
      continue
    }

    const ch = source[i]
    const next = source[i + 1]
    if (context.templateExpression && ch === '}' && context.braces === 0) {
      mask[i] = 1
      i++
      stack.pop()
      previousToken = 'value'
      continue
    }
    if (ch === '/' && next === '/') {
      const start = i
      i += 2
      while (i < source.length && source[i] !== '\n') i++
      hide(start, i)
      continue
    }
    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(source.length, i + 2)
      hide(start, i)
      continue
    }
    if (ch === "'" || ch === '"') { skipQuoted(ch); previousToken = 'value'; continue }
    if (ch === '`') { hide(i, i + 1); i++; stack.push({ kind: 'template' }); previousToken = 'value'; continue }
    if (ch === '/' && regexCanStart()) {
      const start = i
      i++
      let inClass = false
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) { i++; break }
        i++
      }
      while (i < source.length && /[A-Za-z]/.test(source[i])) i++
      hide(start, i)
      previousToken = 'value'
      continue
    }

    mask[i] = 1
    if (context.templateExpression && ch === '{') context.braces++
    else if (context.templateExpression && ch === '}' && context.braces > 0) context.braces--
    i++
    if (!/\s/.test(ch)) rememberToken(i)
  }
  return { code: view.join(''), mask }
}

/** True when a regex match begins on real code rather than inside masked text. */
export function matchStartsInCode(mask: Uint8Array, match: RegExpExecArray): boolean {
  const keywordOffset = match[0].search(/\b(?:import|export|require)\b/)
  return keywordOffset >= 0 && mask[match.index + keywordOffset] === 1
}

export function extractSpecifiers(source: string): { specifiers: Specifier[]; unresolvable: UnresolvableExpression[] } {
  const { code, mask } = lexicalView(source)
  const seen = new Set<string>()
  const specifiers: Specifier[] = []
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      if (!matchStartsInCode(mask, m)) continue
      const key = `${kind}:${m[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      specifiers.push({ spec: m[1], kind })
    }
  }
  const unresolvable: UnresolvableExpression[] = []
  DYNAMIC_NON_LITERAL.lastIndex = 0
  let d: RegExpExecArray | null
  while ((d = DYNAMIC_NON_LITERAL.exec(code))) {
    if (!matchStartsInCode(mask, d)) continue
    const expression = d[1].trim()
    // `import(` in a type position (`import('x').T`) and bare `import()` noise are
    // not module edges; an empty capture is not an expression.
    if (!expression) continue
    unresolvable.push({ expression: expression.slice(0, 80), kind: 'dynamic' })
  }
  return { specifiers, unresolvable }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Collapse `.` and `..` without touching the filesystem. */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (!out.length) return '' ; out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * Candidate repo-relative paths a specifier could resolve to, most specific first.
 * `null` means the specifier is a bare package (`react`, `next/server`, `@vercel/blob`)
 * — a package dependency is `package.json`'s problem, never a transfer manifest's.
 * `[]` means the specifier is local but escapes the repository root.
 */
export function resolveCandidates(fromFile: string, spec: string, aliases: AliasMap = DEFAULT_ALIASES): string[] | null {
  let base: string | null = null
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    const dir = fromFile.split('/').slice(0, -1).join('/')
    base = normalizePath(`${dir}/${spec}`)
    if (!base) return []                                   // climbed out of the repo
  } else {
    // Longest alias prefix wins, so `@/lib/` beats `@/` when both are configured.
    const prefixes = Object.keys(aliases).sort((a, b) => b.length - a.length)
    for (const p of prefixes) {
      if (spec.startsWith(p)) { base = normalizePath(`${aliases[p]}/${spec.slice(p.length)}`); break }
    }
    if (base === null) return null                          // bare package
    if (!base) return []
  }
  const out = [base]
  for (const e of EXTENSIONS) out.push(base + e)
  for (const e of EXTENSIONS) out.push(`${base}/index${e}`)
  return out
}

// ── Traversal ────────────────────────────────────────────────────────────────

export type ClosureInput = {
  /** Every path in the manifest AFTER exclusions have been removed. */
  manifestPaths: string[]
  /** Paths removed by the target's approved exclusions — resolving to one is an error. */
  excludedPaths?: string[]
  /** Every path in the target repository at the pinned targetBaseCommit. */
  targetPaths: string[]
  /** Source text for manifest code paths. A path absent here is treated as a leaf. */
  sourceOf: (path: string) => string | undefined
  aliases?: AliasMap
  limits?: ClosureLimits
}

/**
 * Walk the manifest's own code files and require every local specifier to resolve to
 * either another manifest file or a file already on the target.
 *
 * SCOPE — and this is what keeps Phase A cheap and bounded: traversal only follows
 * edges INTO the manifest. A dependency that already exists on the target is
 * satisfied and is NOT walked, because the target's own copy of it already compiles
 * there; walking it would re-audit the target's tree, not this transfer. So the
 * traversal set can never exceed the manifest, needs no reads beyond the manifest's
 * own source, and terminates on a visited set even when the graph has cycles.
 */
export function analyzeClosure(input: ClosureInput): ClosureResult {
  const aliases = input.aliases ?? DEFAULT_ALIASES
  const limits = input.limits ?? DEFAULT_CLOSURE_LIMITS
  const manifest = new Set(input.manifestPaths)
  const excluded = new Set(input.excludedPaths ?? [])
  const target = new Set(input.targetPaths)

  const problems: ClosureProblem[] = []
  const resolvedOnTarget = new Set<string>()
  const scanned: string[] = []
  const visited = new Set<string>()
  const chainOf = new Map<string, string[]>()

  // Breadth-first from the manifest's code files so `chain` is the SHORTEST path to
  // each module — the most useful thing to show an operator. In Phase A every scanned
  // file is itself part of the transfer, so a chain is normally [importer, missing];
  // it lengthens once traversal can pass through modules that are not roots.
  let frontier = input.manifestPaths.filter(isCodePath)
  for (const p of frontier) chainOf.set(p, [p])
  let hops = 0

  while (frontier.length) {
    if (hops > limits.maxHops) { problems.push({ kind: 'limit_exceeded', limit: 'hops', value: limits.maxHops }); break }
    const next: string[] = []
    for (const file of frontier) {
      if (visited.has(file)) continue
      visited.add(file)
      if (visited.size > limits.maxModules) {
        problems.push({ kind: 'limit_exceeded', limit: 'modules', value: limits.maxModules })
        return { ok: false, problems }
      }
      const source = input.sourceOf(file)
      if (source === undefined) continue                    // not a code file we hold; leaf
      scanned.push(file)
      const chain = chainOf.get(file) ?? [file]

      const { specifiers, unresolvable } = extractSpecifiers(source)
      for (const u of unresolvable) {
        problems.push({ kind: 'unresolvable_dynamic', importer: file, expression: u.expression, chain })
      }

      for (const { spec } of specifiers) {
        const candidates = resolveCandidates(file, spec, aliases)
        if (candidates === null) continue                   // bare package — not ours
        if (!candidates.length) {
          problems.push({ kind: 'unsafe_dependency_path', path: spec, importer: file, specifier: spec, chain })
          continue
        }

        const hitExcluded = candidates.find((c) => excluded.has(c))
        const hitManifest = candidates.find((c) => manifest.has(c))
        const hitTarget = candidates.find((c) => target.has(c))

        // An approved exclusion that a transferred file still needs is incoherent:
        // the owner asked us not to send a file the update cannot work without.
        if (hitExcluded && !hitManifest && !hitTarget) {
          problems.push({ kind: 'excluded_dependency', path: hitExcluded, importer: file, specifier: spec, chain: [...chain, hitExcluded] })
          continue
        }
        if (hitManifest) {
          if (!visited.has(hitManifest) && isCodePath(hitManifest)) {
            if (!chainOf.has(hitManifest)) chainOf.set(hitManifest, [...chain, hitManifest])
            next.push(hitManifest)
          }
          continue
        }
        if (hitTarget) { resolvedOnTarget.add(hitTarget); continue }

        // Nowhere: not in the transfer, not on the target. This is the UPD-1004 shape.
        problems.push({
          kind: 'missing_dependency',
          path: candidates[1] ?? candidates[0],             // the .ts form reads best
          importer: file,
          specifier: spec,
          chain: [...chain, candidates[1] ?? candidates[0]],
        })
      }
    }
    frontier = next
    hops++
  }

  if (problems.length) return { ok: false, problems }
  return { ok: true, scannedPaths: scanned.sort(), resolvedOnTarget: [...resolvedOnTarget].sort() }
}

// ── Reporting ────────────────────────────────────────────────────────────────
// One line per problem, deterministic order, no file contents — the same discipline
// the assignment audit ledger follows: say what and where, never what was inside.

export function describeClosureProblems(problems: ClosureProblem[]): string {
  const line = (p: ClosureProblem): string => {
    switch (p.kind) {
      case 'missing_dependency':
        return `${p.path} (imported by ${p.importer} as "${p.specifier}"${p.chain.length > 2 ? `; via ${p.chain.slice(0, -1).join(' → ')}` : ''})`
      case 'excluded_dependency':
        return `${p.path} is excluded for this target but required by ${p.importer} (as "${p.specifier}")`
      case 'unresolvable_dynamic':
        return `${p.importer} uses a non-literal dynamic import (${p.expression}) that cannot be verified`
      case 'unsafe_dependency_path':
        return `${p.importer} imports "${p.specifier}", which resolves outside the repository`
      case 'limit_exceeded':
        return `dependency graph exceeded the ${p.limit} limit (${p.value}) — split this update`
    }
  }
  const missing = problems.filter((p) => p.kind === 'missing_dependency')
  const others = problems.filter((p) => p.kind !== 'missing_dependency')
  const parts: string[] = []
  if (missing.length) {
    parts.push(`the target is missing ${missing.length} required module${missing.length === 1 ? '' : 's'}: ${[...new Set(missing.map(line))].sort().join('; ')}`)
  }
  for (const o of [...new Set(others.map(line))].sort()) parts.push(o)
  return parts.join(' | ')
}
