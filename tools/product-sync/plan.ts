// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT SYNCHRONIZATION PLATFORM — Adaptation Planner (Phase 5)
//
// Generate an adaptation PLAN from a manifest BEFORE any code is written. "No
// implementation without a generated plan" is a hard gate — the implementation engine
// refuses to cut a sync branch for a manifest whose plan is missing/empty. Pure +
// testable; the .mjs engine serializes the plan next to the manifest.
// ─────────────────────────────────────────────────────────────────────────────

import type { RiskLevel, UpdateManifest } from './manifest/schema'

export type FileMove = { source: string; destination: string; note?: string }

export type AdaptationPlan = {
  manifestId: string
  generatedFrom: { classification: string; category: string }
  sourceFiles: string[]
  destinationFiles: FileMove[]
  functionsReused: string[]      // used as-is downstream
  functionsAdapted: string[]     // branding/config/API changes needed
  functionsExcluded: string[]    // deliberately dropped
  expectedConflicts: string[]
  riskLevel: RiskLevel
  requiredTests: string[]
  rollback: string[]
  gatesRequired: string[]        // compatibility gates that MUST pass first
  blockers: string[]             // reasons the plan cannot proceed yet
}

// Map an upstream repo path to the downstream path. Downstream products keep the same
// layout by convention (they are branded copies), so the default map is identity; a
// product override map can rename directories where they diverge.
export function mapDestination(sourcePath: string, rename: Record<string, string> = {}): string {
  for (const [from, to] of Object.entries(rename)) {
    if (sourcePath.startsWith(from)) return to + sourcePath.slice(from.length)
  }
  return sourcePath
}

/** Build the adaptation plan for a manifest. Deterministic — the same manifest always
 *  yields the same plan, so plans are diffable in review. */
export function buildAdaptationPlan(m: UpdateManifest, rename: Record<string, string> = {}): AdaptationPlan {
  const sourceFiles = dedupe([
    ...m.surface.sharedUtilities, ...m.surface.sharedComponents,
    ...m.surface.routes, ...m.surface.apis, ...m.surface.ui,
    ...m.surface.tests, ...m.surface.sharedFiles,
  ])
  const destinationFiles: FileMove[] = sourceFiles.map((s) => ({ source: s, destination: mapDestination(s, rename) }))

  // Branding-coupled surfaces (UI + shared components) are ADAPTED; pure logic/utils
  // are REUSED as-is; excluded surfaces are dropped.
  const brandingSurfaces = new Set([...m.surface.ui, ...m.surface.sharedComponents])
  const functionsAdapted = [...brandingSurfaces]
  const functionsReused = dedupe([...m.surface.sharedUtilities, ...m.surface.apis, ...m.surface.routes]).filter((f) => !brandingSurfaces.has(f))
  const functionsExcluded = [...m.exclusions]

  const expectedConflicts = deriveConflicts(m)
  const gatesRequired = deriveGates(m)
  const blockers = deriveBlockers(m)

  return {
    manifestId: m.id,
    generatedFrom: { classification: m.classification, category: m.category },
    sourceFiles,
    destinationFiles,
    functionsReused,
    functionsAdapted,
    functionsExcluded,
    expectedConflicts,
    riskLevel: escalateRisk(m),
    requiredTests: dedupe([...m.surface.tests, 'tsc --noEmit', 'eslint', 'unit', 'regression']),
    rollback: m.rollbackSteps.length ? m.rollbackSteps : defaultRollback(m),
    gatesRequired,
    blockers,
  }
}

function deriveConflicts(m: UpdateManifest): string[] {
  const c: string[] = []
  if (m.surface.sharedUtilities.some((f) => /flags\.ts$/.test(f))) c.push('flags.ts is a high-traffic shared file — expect a merge hunk; add the flag with partial staging')
  if (m.surface.sharedUtilities.some((f) => /package\.json$/.test(f)) || m.surface.sharedFiles.some((f) => /package\.json$/.test(f))) c.push('package.json dependency add — reconcile lockfile downstream')
  if (m.surface.databaseMigrations.length) c.push('database migration — order relative to downstream migrations')
  if (m.surface.ui.length) c.push('UI surface — downstream branding (colors/copy/logo) must be preserved')
  return c
}

function deriveGates(m: UpdateManifest): string[] {
  const g = ['clean-repo', 'clean-tree', 'correct-branch', 'no-conflicting-session', 'feature-flags-off']
  if (m.surface.databaseMigrations.length || m.rollout.requiresMigration) g.push('migration-compatibility')
  if (m.surface.environmentVariables.length || m.rollout.requiresEnvConfig) g.push('environment-compatibility')
  if (m.surface.apis.some((a) => /auth|session|login/i.test(a))) g.push('authentication-compatibility')
  if (m.surface.sharedUtilities.some((u) => /tenan/i.test(u))) g.push('tenancy-compatibility')
  if (m.dependencies.length) g.push('dependency-compatibility')
  return g
}

function deriveBlockers(m: UpdateManifest): string[] {
  const b: string[] = []
  if (m.classification === 'excluded') b.push('classified EXCLUDED — do not port')
  if (m.classification === 'manual-review') b.push('classified MANUAL-REVIEW — a human must resolve before planning implementation')
  if (m.classification === 'already-present') b.push('already present downstream — nothing to port')
  if (m.dependencies.length) b.push(`depends on unmet manifests: ${m.dependencies.join(', ')}`)
  return b
}

function escalateRisk(m: UpdateManifest): RiskLevel {
  if (m.surface.databaseMigrations.length || m.surface.apis.some((a) => /auth|payment|stripe/i.test(a))) return 'high'
  if (m.riskLevel === 'high') return 'high'
  if (m.surface.ui.length || m.surface.apis.length) return m.riskLevel === 'low' ? 'medium' : m.riskLevel
  return m.riskLevel
}

function defaultRollback(m: UpdateManifest): string[] {
  const steps = ['Revert the downstream sync PR commit(s).']
  if (m.surface.featureFlags.length) steps.unshift(`Set ${m.surface.featureFlags.join(', ')} = OFF (instant, no redeploy).`)
  if (m.surface.databaseMigrations.length) steps.push('Run the down-migration(s); confirm no data written while the flag was on.')
  return steps
}

const dedupe = (a: string[]): string[] => Array.from(new Set(a.filter(Boolean)))

/** Hard gate used by the implementation engine: is this plan safe to implement? */
export function planIsImplementable(p: AdaptationPlan): boolean {
  return p.blockers.length === 0 && p.sourceFiles.length > 0
}
