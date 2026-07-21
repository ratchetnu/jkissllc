// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT SYNCHRONIZATION PLATFORM — Update Manifest (Phase 1)
//
// A Manifest is the machine-readable description of ONE logical Update (a feature or
// fix) as it moves from an UPSTREAM product (the canonical engineering source) into a
// DOWNSTREAM product. It is the single source of truth the whole pipeline reads and
// writes — discovery seeds it, classification tags it, the planner expands it, the
// implementation engine advances its status, and verification/approval stamp it.
//
// This module is PURE (no I/O, no Node built-ins) so it typechecks under the app's
// tsconfig and is trivially unit-testable. All file/git/HTTP work lives in the .mjs
// engine scripts under ../engine.
//
// Versioned: bump SCHEMA_VERSION on a breaking field change and add a migration note.
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1

// ── Products & relationships ─────────────────────────────────────────────────
// Product-agnostic by construction: upstream/downstream are just product ids. The
// concrete repo paths live in products.json (engine config), never hard-coded here.
export type ProductId = 'operion' | 'supercharged' | 'claimguard' | (string & {})

// ── Lifecycle status (Phase 1) ───────────────────────────────────────────────
export const STATUSES = [
  'discovered',    // discovery engine found upstream work not present downstream
  'planned',       // an adaptation plan has been generated
  'approved',      // an approver signed off on the plan
  'adapting',      // implementation in progress on the sync branch
  'implemented',   // code complete on the sync branch
  'verified',      // the verification gauntlet passed
  'preview-ready', // validated on a Preview deployment
  'merged',        // downstream PR merged
  'released',      // shipped to the downstream product's users
  'blocked',       // cannot proceed (a gate failed / a dependency is unmet)
  'rejected',      // intentionally will not be ported
] as const
export type Status = (typeof STATUSES)[number]

// Allowed forward transitions (+ the two terminals reachable from anywhere). The
// implementation engine MUST route status changes through canTransition so the
// manifest history can never record an impossible jump.
const FORWARD: Record<Status, Status[]> = {
  discovered: ['planned', 'blocked', 'rejected'],
  planned: ['approved', 'blocked', 'rejected'],
  approved: ['adapting', 'blocked', 'rejected'],
  adapting: ['implemented', 'blocked'],
  implemented: ['verified', 'blocked'],
  verified: ['preview-ready', 'blocked'],
  'preview-ready': ['merged', 'blocked'],
  merged: ['released', 'blocked'],
  released: [],
  blocked: ['discovered', 'planned', 'approved', 'adapting', 'implemented', 'verified', 'preview-ready', 'rejected'],
  rejected: ['discovered'], // a rejection can be reopened if upstream changes the calculus
}

export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true
  return (FORWARD[from] ?? []).includes(to)
}

export const TERMINAL_STATUSES: Status[] = ['released', 'rejected']
export function isTerminal(s: Status): boolean { return TERMINAL_STATUSES.includes(s) }

// ── Classification (Phase 3) ─────────────────────────────────────────────────
export const CLASSIFICATIONS = [
  'direct-port',         // applies cleanly with no product-specific changes
  'adaptation-required', // needs branding / config / API-surface adaptation
  'already-present',     // downstream already has an equivalent
  'partially-present',   // downstream has some of it; the remainder must be ported
  'excluded',            // deliberately never ported (e.g. Release Center)
  'manual-review',       // ambiguous — a human must decide
] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

// ── Category (engineering taxonomy of an update) ─────────────────────────────
export const CATEGORIES = [
  'feature', 'fix', 'observability', 'performance', 'security',
  'infrastructure', 'ui', 'docs', 'refactor', 'data-migration',
] as const
export type Category = (typeof CATEGORIES)[number]

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

// ── Sub-shapes ───────────────────────────────────────────────────────────────
export type SourceRef = {
  upstreamRepo: string        // e.g. 'ratchetnu/jkissllc'
  downstreamRepo: string      // e.g. 'ratchetnu/supercharged'
  sourceBranch?: string
  sourceCommit?: string       // the upstream commit the update was captured from
  sourcePR?: number | string
}

// Surface area the update touches — drives the planner, the compatibility gates,
// and the drift report. Every list defaults to empty (the update touches nothing
// of that kind) so partial manifests are valid.
export type SurfaceArea = {
  featureFlags: string[]           // flags the update introduces (must default OFF)
  environmentVariables: string[]   // env vars the update reads
  databaseMigrations: string[]     // migration ids / files
  sharedComponents: string[]       // shared UI components touched
  sharedUtilities: string[]        // shared libs/utilities touched
  routes: string[]                 // app routes added/changed
  apis: string[]                   // API endpoints added/changed
  ui: string[]                     // customer/admin UI surfaces
  tests: string[]                  // test files that cover it
  sharedFiles: string[]            // any other files that must move together
}

export type RolloutRequirement = {
  featureFlagsOffByDefault: boolean   // MUST be true — sync never flips behavior on
  previewValidationRequired: boolean
  requiresMigration: boolean
  requiresEnvConfig: boolean
  notes?: string
}

export type VerificationRecord = {
  typescript?: boolean
  eslint?: boolean
  unit?: boolean
  integration?: boolean
  regression?: boolean
  previewBuild?: boolean
  featureOffVerified?: boolean
  rollbackVerified?: boolean
  ranAt?: string          // ISO timestamp (stamped by the engine, not the schema)
  summary?: string
}

export type ApprovalRecord = {
  approver?: string
  approvedAt?: string     // ISO
  packagePath?: string    // where the generated approval package lives
  knownDifferences?: string[]
}

export type ManifestHistoryEntry = {
  at: string              // ISO
  from?: Status
  to: Status
  actor: string
  note?: string
}

// ── The Update Manifest (all Phase-1 fields) ─────────────────────────────────
export type UpdateManifest = {
  schemaVersion: number
  id: string                        // stable manifest id, e.g. 'OBS-001'
  title: string
  description: string
  product: {
    upstream: ProductId
    downstream: ProductId
  }
  source: SourceRef
  category: Category
  classification: Classification
  status: Status
  dependencies: string[]            // other manifest ids that must land first
  surface: SurfaceArea
  rollout: RolloutRequirement
  rollbackSteps: string[]
  exclusions: string[]              // things deliberately NOT ported within this update
  compatibilityNotes: string[]
  riskLevel: RiskLevel
  verification?: VerificationRecord
  approval?: ApprovalRecord
  syncBranch?: string               // sync/<product>/<id> once the engine cuts it
  downstreamPR?: number | string
  history: ManifestHistoryEntry[]
}

// ── Defaults / normalization ─────────────────────────────────────────────────
export function emptySurface(): SurfaceArea {
  return {
    featureFlags: [], environmentVariables: [], databaseMigrations: [],
    sharedComponents: [], sharedUtilities: [], routes: [], apis: [], ui: [],
    tests: [], sharedFiles: [],
  }
}

/** Fill defaults for optional/omitted fields so hand-written registry entries stay
 *  terse. Pure — returns a new object, never mutates the input. */
export function normalizeManifest(m: Partial<UpdateManifest> & Pick<UpdateManifest, 'id' | 'title'>): UpdateManifest {
  return {
    schemaVersion: m.schemaVersion ?? SCHEMA_VERSION,
    id: m.id,
    title: m.title,
    description: m.description ?? '',
    product: { upstream: m.product?.upstream ?? 'operion', downstream: m.product?.downstream ?? 'supercharged' },
    source: {
      upstreamRepo: m.source?.upstreamRepo ?? 'ratchetnu/jkissllc',
      downstreamRepo: m.source?.downstreamRepo ?? '',
      sourceBranch: m.source?.sourceBranch,
      sourceCommit: m.source?.sourceCommit,
      sourcePR: m.source?.sourcePR,
    },
    category: m.category ?? 'feature',
    classification: m.classification ?? 'manual-review',
    status: m.status ?? 'discovered',
    dependencies: m.dependencies ?? [],
    surface: { ...emptySurface(), ...(m.surface ?? {}) },
    rollout: {
      featureFlagsOffByDefault: m.rollout?.featureFlagsOffByDefault ?? true,
      previewValidationRequired: m.rollout?.previewValidationRequired ?? true,
      requiresMigration: m.rollout?.requiresMigration ?? false,
      requiresEnvConfig: m.rollout?.requiresEnvConfig ?? false,
      notes: m.rollout?.notes,
    },
    rollbackSteps: m.rollbackSteps ?? [],
    exclusions: m.exclusions ?? [],
    compatibilityNotes: m.compatibilityNotes ?? [],
    riskLevel: m.riskLevel ?? 'medium',
    verification: m.verification,
    approval: m.approval,
    syncBranch: m.syncBranch,
    downstreamPR: m.downstreamPR,
    history: m.history ?? [],
  }
}

// ── Validation ───────────────────────────────────────────────────────────────
export type ValidationIssue = { field: string; message: string; severity: 'error' | 'warning' }

/** Structural + policy validation. Pure. Returns issues (errors block the pipeline;
 *  warnings are advisory). Enforces the platform's safety invariants — most notably
 *  that every update ships with its flags OFF by default. */
export function validateManifest(m: UpdateManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (field: string, message: string) => issues.push({ field, message, severity: 'error' })
  const warn = (field: string, message: string) => issues.push({ field, message, severity: 'warning' })

  if (!/^[A-Z0-9]+-\d+$/.test(m.id)) err('id', 'id must look like "OBS-001" (UPPER-NNN)')
  if (!m.title.trim()) err('title', 'title is required')
  if (!(STATUSES as readonly string[]).includes(m.status)) err('status', `unknown status "${m.status}"`)
  if (!(CLASSIFICATIONS as readonly string[]).includes(m.classification)) err('classification', `unknown classification "${m.classification}"`)
  if (!(CATEGORIES as readonly string[]).includes(m.category)) err('category', `unknown category "${m.category}"`)
  if (m.product.upstream === m.product.downstream) err('product', 'upstream and downstream must differ')

  // Safety invariant: a synchronized update NEVER turns behavior on by default.
  if (!m.rollout.featureFlagsOffByDefault) err('rollout.featureFlagsOffByDefault', 'sync updates must ship with feature flags OFF by default')
  // An update that touches behavior but declares no flag is a review smell.
  if (m.surface.featureFlags.length === 0 && (m.surface.routes.length > 0 || m.surface.apis.length > 0 || m.surface.ui.length > 0) && m.classification !== 'excluded') {
    warn('surface.featureFlags', 'behavioral surface (routes/apis/ui) with no feature flag — confirm this is intentionally always-on')
  }
  if (m.rollout.requiresMigration && m.surface.databaseMigrations.length === 0) warn('surface.databaseMigrations', 'rollout.requiresMigration is true but no migrations are listed')
  // Advancing past "approved" requires an approver on record.
  const advanced: Status[] = ['adapting', 'implemented', 'verified', 'preview-ready', 'merged', 'released']
  if (advanced.includes(m.status) && !m.approval?.approver) warn('approval', `status "${m.status}" but no approver recorded`)
  if (m.status === 'excluded' as Status) err('status', 'use classification "excluded" + status "rejected", not status "excluded"')
  return issues
}

export function isValid(m: UpdateManifest): boolean {
  return validateManifest(m).every((i) => i.severity !== 'error')
}
