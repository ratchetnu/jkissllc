// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT SYNCHRONIZATION PLATFORM — Classification (Phase 3)
//
// Automatically classify an update into one of six classes from (a) the manifest and
// (b) the per-update discovery signals the discovery engine produced. Pure + testable.
// The engine calls this to set manifest.classification; a 'manual-review' outcome is
// the safe default whenever the signals are ambiguous or conflicting.
// ─────────────────────────────────────────────────────────────────────────────

import type { Classification, UpdateManifest } from './manifest/schema'

// Per-update signals the discovery engine computes by comparing upstream ↔ downstream.
export type DiscoverySignals = {
  // fraction of the update's source files that already exist downstream (0..1)
  filesPresentRatio: number
  // fraction of those present files whose content already matches upstream (0..1)
  filesMatchingRatio: number
  brandingCoupled: boolean       // touches branding/copy/theme that differs downstream
  dependencyDrift: boolean       // needs an upstream dependency the downstream lacks
  migrationRequired: boolean     // carries a DB migration
  apiSurfaceDivergent: boolean   // downstream API shape differs where this update lands
  excludedByPolicy: boolean      // matches an exclusion rule (e.g. Release Center)
}

export const DEFAULT_SIGNALS: DiscoverySignals = {
  filesPresentRatio: 0, filesMatchingRatio: 0, brandingCoupled: false,
  dependencyDrift: false, migrationRequired: false, apiSurfaceDivergent: false,
  excludedByPolicy: false,
}

// Exclusion rules: subsystems that must NEVER be ported downstream. Matched against
// the manifest id/title/surface. Release Center is the canonical example — it is
// upstream-only release orchestration and has no meaning in a downstream product.
export const EXCLUSION_RULES: { name: string; test: (m: UpdateManifest) => boolean }[] = [
  { name: 'release-center', test: (m) => /release center|release-center|operion release|publish review|approval gate|rollback/i.test(`${m.title} ${m.description}`) || m.surface.routes.some((r) => /\/admin\/operations\/release/.test(r)) },
  { name: 'sandbox-repair', test: (m) => /sandbox repair|operion-sandbox/i.test(`${m.title} ${m.description}`) },
]

export function matchedExclusion(m: UpdateManifest): string | null {
  return EXCLUSION_RULES.find((r) => r.test(m))?.name ?? null
}

/**
 * Classify an update. Precedence (highest first):
 *   1. explicit policy exclusion            → 'excluded'
 *   2. already fully present + matching      → 'already-present'
 *   3. some present but not all              → 'partially-present'
 *   4. needs branding/dep/migration/API work → 'adaptation-required'
 *   5. clean, self-contained, none present   → 'direct-port'
 *   6. anything ambiguous                    → 'manual-review'
 */
export function classifyUpdate(m: UpdateManifest, signals: DiscoverySignals = DEFAULT_SIGNALS): Classification {
  if (signals.excludedByPolicy || matchedExclusion(m)) return 'excluded'

  const fullyPresent = signals.filesPresentRatio >= 0.999 && signals.filesMatchingRatio >= 0.999
  if (fullyPresent) return 'already-present'

  const needsAdaptation = signals.brandingCoupled || signals.dependencyDrift || signals.migrationRequired || signals.apiSurfaceDivergent

  // Some of the update already exists downstream but not all of it.
  if (signals.filesPresentRatio > 0.001 && signals.filesPresentRatio < 0.999) {
    return needsAdaptation ? 'manual-review' : 'partially-present'
  }

  // None present downstream.
  if (needsAdaptation) return 'adaptation-required'
  if (signals.filesPresentRatio <= 0.001) return 'direct-port'

  return 'manual-review'
}

/** A short, human-readable rationale for the chosen classification (for the drift
 *  report + approval package). Pure. */
export function classificationRationale(c: Classification, signals: DiscoverySignals): string {
  switch (c) {
    case 'excluded': return 'Matches a policy exclusion (upstream-only subsystem).'
    case 'already-present': return 'Downstream already contains an equivalent, matching implementation.'
    case 'partially-present': return `~${Math.round(signals.filesPresentRatio * 100)}% of the surface already exists downstream; the remainder must be ported.`
    case 'adaptation-required': return `Requires ${[signals.brandingCoupled && 'branding', signals.dependencyDrift && 'dependency', signals.migrationRequired && 'migration', signals.apiSurfaceDivergent && 'API'].filter(Boolean).join(' + ')} adaptation.`
    case 'direct-port': return 'Self-contained and absent downstream — applies cleanly.'
    case 'manual-review': return 'Signals are ambiguous or conflicting — a human must decide.'
  }
}
