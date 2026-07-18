// ── Publish Review — deterministic change classification (PURE) ──────────────
//
// Increment 3B.2D. Classifies a set of changed file paths (from a verified GitHub
// compare) into human areas + risk indicators using ONLY exact/prefix/suffix path
// rules. NO AI, NO heuristics, NO speculative risk language. Every indicator carries
// the exact file evidence that produced it — nothing is invented. Pure + fully
// testable: no I/O, no provider access, deterministic on its input.

export type ChangedFile = { filename: string; status?: string; additions?: number; deletions?: number }

export type ChangeArea =
  | 'application' | 'api' | 'database/migrations' | 'authentication/authorization'
  | 'infrastructure' | 'environment/configuration' | 'github workflows'
  | 'vercel configuration' | 'dependencies' | 'tests' | 'documentation'

/** A single high-risk hit: WHY (category) and the exact file that matched. */
export type HighRiskHit = { category: string; file: string }

export type ChangeClassification = {
  changedAreas: ChangeArea[]
  workflowChange: boolean
  migrationChange: boolean
  envConfigChange: boolean
  highRisk: boolean
  highRiskFiles: HighRiskHit[]
}

const lower = (s: string) => s.toLowerCase()
const base = (p: string) => p.split('/').pop() ?? p

// ── Area rules (first match wins per file; a file maps to exactly one area) ────
// Ordered most-specific → least-specific so e.g. a migration file is not mislabelled
// as generic application code.
const AREA_RULES: { area: ChangeArea; test: (p: string, b: string) => boolean }[] = [
  { area: 'github workflows', test: (p) => p.startsWith('.github/workflows/') || p.startsWith('.github/actions/') },
  { area: 'vercel configuration', test: (p, b) => b === 'vercel.json' || b === 'vercel.ts' || b === 'now.json' },
  { area: 'database/migrations', test: (p, b) => /(^|\/)migrations?\//.test(p) || /(^|\/)prisma\//.test(p) || b.endsWith('.sql') || b === 'schema.prisma' || /(^|\/)drizzle\//.test(p) },
  { area: 'dependencies', test: (p, b) => b === 'package-lock.json' || b === 'pnpm-lock.yaml' || b === 'yarn.lock' || b === 'package.json' || b === 'bun.lockb' },
  { area: 'environment/configuration', test: (p, b) => /^\.env(\.|$)/.test(b) || b === '.env' || b.endsWith('.env') || b === 'next.config.js' || b === 'next.config.ts' || b === 'next.config.mjs' || b === 'tsconfig.json' || b === 'middleware.ts' || b === 'middleware.js' },
  { area: 'authentication/authorization', test: (p) => /(^|\/)(auth|authz|session|permission|permissions|rbac|oauth|login|logout|credentials)(\/|\.|-)/.test(lower(p)) || /(^|\/)_lib\/session\./.test(p) },
  { area: 'github workflows', test: (p) => p.startsWith('.github/') },
  { area: 'tests', test: (p, b) => /\.test\.[tj]sx?$/.test(b) || /\.spec\.[tj]sx?$/.test(b) || /(^|\/)__tests__\//.test(p) || p.startsWith('scripts/') && /\.test\./.test(b) },
  { area: 'documentation', test: (p, b) => b.endsWith('.md') || b.endsWith('.mdx') || p.startsWith('docs/') },
  { area: 'api', test: (p, b) => /(^|\/)api\//.test(p) || b === 'route.ts' || b === 'route.js' },
  { area: 'infrastructure', test: (p) => p.startsWith('infra/') || p.startsWith('.docker/') || /(^|\/)dockerfile$/i.test(lower(p)) || p.startsWith('terraform/') || p.startsWith('k8s/') },
  { area: 'application', test: () => true },
]

// ── High-risk rules (a file may match several) ────────────────────────────────
// Only VERIFIED path matches — no content inspection, no probabilistic judgement.
const RISK_RULES: { category: string; test: (p: string, b: string) => boolean }[] = [
  { category: 'database migration', test: (p, b) => /(^|\/)migrations?\//.test(p) || b.endsWith('.sql') || /(^|\/)drizzle\//.test(p) },
  { category: 'schema file', test: (p, b) => b === 'schema.prisma' || b.endsWith('.schema.ts') || /(^|\/)prisma\/schema\./.test(p) },
  { category: 'authentication/authorization', test: (p) => /(^|\/)(auth|authz|session|permission|permissions|rbac|oauth|credentials)(\/|\.|-)/.test(lower(p)) || /(^|\/)_lib\/session\./.test(p) },
  { category: 'middleware', test: (p, b) => b === 'middleware.ts' || b === 'middleware.js' },
  { category: 'environment configuration', test: (p, b) => /^\.env(\.|$)/.test(b) || b.endsWith('.env') || b === '.env' },
  { category: 'deployment configuration', test: (p, b) => b === 'vercel.json' || b === 'vercel.ts' || b === 'now.json' },
  { category: 'github workflow', test: (p) => p.startsWith('.github/workflows/') },
  { category: 'dependency manifest', test: (p, b) => b === 'package-lock.json' || b === 'pnpm-lock.yaml' || b === 'yarn.lock' || b === 'package.json' || b === 'bun.lockb' },
  { category: 'release-engine code', test: (p) => /(^|\/)lib\/platform\/release\//.test(p) || /(^|\/)lib\/platform\/automation\//.test(p) },
  { category: 'production promotion code', test: (p) => /promotion/.test(lower(p)) || /promote/.test(lower(p)) },
]

/**
 * Classify a verified set of changed files. Input paths come from a GitHub compare
 * (already trusted repo data) — this function never fetches or guesses.
 */
export function classifyChangedFiles(files: ChangedFile[]): ChangeClassification {
  const areas = new Set<ChangeArea>()
  const highRiskFiles: HighRiskHit[] = []
  let workflowChange = false
  let migrationChange = false
  let envConfigChange = false

  for (const f of files) {
    const p = f.filename
    if (!p) continue
    const b = base(p)

    for (const rule of AREA_RULES) {
      if (rule.test(p, b)) { areas.add(rule.area); break }
    }

    if (p.startsWith('.github/workflows/')) workflowChange = true
    if (/(^|\/)migrations?\//.test(p) || b.endsWith('.sql') || b === 'schema.prisma' || /(^|\/)prisma\//.test(p) || /(^|\/)drizzle\//.test(p)) migrationChange = true
    if (/^\.env(\.|$)/.test(b) || b.endsWith('.env') || b === '.env' || b === 'vercel.json' || b === 'vercel.ts' || b === 'now.json' || b === 'next.config.js' || b === 'next.config.ts' || b === 'next.config.mjs') envConfigChange = true

    for (const rule of RISK_RULES) {
      if (rule.test(p, b)) highRiskFiles.push({ category: rule.category, file: p })
    }
  }

  // Deterministic ordering: areas sorted alphabetically; risk hits keep file order but
  // de-duplicate identical (category, file) pairs.
  const seen = new Set<string>()
  const dedupRisk = highRiskFiles.filter((h) => { const k = `${h.category}::${h.file}`; if (seen.has(k)) return false; seen.add(k); return true })

  return {
    changedAreas: [...areas].sort(),
    workflowChange,
    migrationChange,
    envConfigChange,
    highRisk: dedupRisk.length > 0,
    highRiskFiles: dedupRisk,
  }
}
