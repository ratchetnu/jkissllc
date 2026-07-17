// ── AI Command Center — owner display preferences (PURE validation + tiny store) ─
//
// Real, owner-safe, non-secret display preferences for the Command Center. A NEW store
// (settings:ai_prefs) — not a duplicate of any config: budget/flags stay env-driven, this only
// holds view defaults. Validation is pure + exported so it is unit-testable without Redis.

export type AiPrefs = {
  defaultPerformanceRange: '7d' | '30d' | '90d'
  defaultQueueTier: '' | 'needs_intervention' | 'awaiting_review' | 'missing_ground_truth' | 'uncategorized' | 'ready_to_run'
  showInformationalAlerts: boolean
}

export const DEFAULT_AI_PREFS: AiPrefs = {
  defaultPerformanceRange: '30d',
  defaultQueueTier: '',
  showInformationalAlerts: true,
}

const RANGES = ['7d', '30d', '90d'] as const
const TIERS = ['', 'needs_intervention', 'awaiting_review', 'missing_ground_truth', 'uncategorized', 'ready_to_run'] as const

export type PrefsValidation = { ok: true; prefs: AiPrefs } | { ok: false; error: string }

/** Validate an untrusted patch onto the current prefs. Rejects unknown values rather than
 *  silently coercing — an invalid setting is an error the owner should see. */
export function validateAiPrefs(patch: unknown, current: AiPrefs = DEFAULT_AI_PREFS): PrefsValidation {
  const b = (patch ?? {}) as Record<string, unknown>
  const next: AiPrefs = { ...current }
  if ('defaultPerformanceRange' in b) {
    if (!RANGES.includes(b.defaultPerformanceRange as never)) return { ok: false, error: 'defaultPerformanceRange must be 7d, 30d, or 90d.' }
    next.defaultPerformanceRange = b.defaultPerformanceRange as AiPrefs['defaultPerformanceRange']
  }
  if ('defaultQueueTier' in b) {
    if (!TIERS.includes(b.defaultQueueTier as never)) return { ok: false, error: 'defaultQueueTier is not a valid queue tier.' }
    next.defaultQueueTier = b.defaultQueueTier as AiPrefs['defaultQueueTier']
  }
  if ('showInformationalAlerts' in b) {
    if (typeof b.showInformationalAlerts !== 'boolean') return { ok: false, error: 'showInformationalAlerts must be true or false.' }
    next.showInformationalAlerts = b.showInformationalAlerts
  }
  return { ok: true, prefs: next }
}
