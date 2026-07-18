// ── Pick the update a Business's "Update" targets (internal, PURE) ───────────
//
// The simple "Update" action needs one concrete target for the existing preview
// orchestrator. This chooses the single most-important release-eligible update that
// isn't already present/blocked for the Business — deterministically. It reuses the
// updates domain's own eligibility gate (which already refuses unapproved, failing,
// breaking-without-verification, and migration-without-rollback updates).

import { updateReleaseEligible } from '../updates/policy'
import type { PlatformUpdate, UpdateCompatibility } from '../updates/types'

const PRIORITY: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 }
const SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
// Compatibility states where this update should NOT be offered for a Business.
const SKIP_COMPAT = new Set(['already_present', 'blocked', 'incompatible', 'not_applicable'])

/**
 * The one update to preview for a Business, or null when there's nothing safe to apply.
 * `compatFor(key)` returns that update's compatibility for the target Business (if any).
 */
export function pickTargetUpdate(
  updates: PlatformUpdate[],
  compatFor: (key: string) => UpdateCompatibility | undefined,
): PlatformUpdate | null {
  const candidates = updates.filter(u => {
    if (!updateReleaseEligible(u).eligible) return false
    const c = compatFor(u.key)
    return !(c && SKIP_COMPAT.has(c.status))
  })
  if (!candidates.length) return null
  const rank = (u: PlatformUpdate) => (PRIORITY[u.priority] ?? 2) * 10 + (SEVERITY[u.severity] ?? 2)
  return [...candidates].sort((a, b) => rank(b) - rank(a) || a.createdAt - b.createdAt)[0]
}
