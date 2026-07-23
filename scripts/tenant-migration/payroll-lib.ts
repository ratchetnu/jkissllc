// ── Stable-id payroll migration — PURE planner ───────────────────────────────
//
// Closes the residual half of H-KEY-1 (tenant-isolation doc 07 §businesses). The
// Redis-key collision is already handled by the `scopeKey` chokepoint, but
// `Staff.payByBusiness` is keyed by `bizKey(name)` — a normalized business NAME —
// and that map lives INSIDE a JSON value, where a key prefix cannot reach it.
//
// Two consequences, both real money:
//   1. A business rename silently moves (and therefore loses) every crew member's
//      per-business pay override for it. The crew member falls back to their
//      default rate and nobody is told.
//   2. A name is not a durable identity, so the override cannot survive tenancy.
//
// The fix is a data migration to opaque stable ids. This module is the PURE plan:
// no Redis, no clock, no randomness except an injected minter — so the whole thing
// is testable, and the runner that performs I/O stays thin.
//
// Doctrine, deliberately: the plan is ADDITIVE. It never deletes a legacy key and
// never overwrites a differing value. After it runs, both keys resolve to the same
// cents, which is what makes the cutover reversible — drop the new keys and the
// legacy path is untouched. See docs/opspilot-os/15-migration-roadmap.md Phase 2.

export type BizIdentity = {
  key: string          // normalized name — the legacy identity
  name: string
  stableId?: string    // opaque id, absent until this migration assigns one
}

export type StaffPayMap = {
  id: string
  name?: string
  payByBusiness?: Record<string, number>
}

/** One business that needs an id minted. */
export type BizAssignment = { key: string; stableId: string }

/** Pay-override entries to ADD to one staff record, keyed by stableId. */
export type StaffRekey = { staffId: string; add: Record<string, number> }

/** A legacy override we refuse to touch, and why. Reported, never silently dropped. */
export type RekeySkip = {
  staffId: string
  legacyKey: string
  reason: 'no_such_business' | 'value_conflict' | 'invalid_value'
  detail: string
}

export type PayRekeyPlan = {
  assignments: BizAssignment[]
  rekeys: StaffRekey[]
  skips: RekeySkip[]
  /** Overrides already carrying a stableId key with the same value — nothing to do. */
  alreadyMigrated: number
  /** True when applying this plan would change nothing. */
  noop: boolean
}

const isPayCents = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Build the migration plan.
 *
 * `mintId` is injected so a test can pin ids and so a re-run never depends on
 * randomness for its idempotency: a business that already HAS a stableId is never
 * re-minted, which is what makes running this twice a no-op.
 */
export function planPayRekey(
  businesses: BizIdentity[],
  staff: StaffPayMap[],
  mintId: () => string,
): PayRekeyPlan {
  const assignments: BizAssignment[] = []

  // legacy bizKey → the stableId it will resolve to (existing or newly minted)
  const idByKey = new Map<string, string>()
  for (const b of businesses) {
    if (b.stableId) { idByKey.set(b.key, b.stableId); continue }
    const minted = mintId()
    assignments.push({ key: b.key, stableId: minted })
    idByKey.set(b.key, minted)
  }

  const rekeys: StaffRekey[] = []
  const skips: RekeySkip[] = []
  let alreadyMigrated = 0

  for (const s of staff) {
    const map = s.payByBusiness
    if (!map) continue
    const add: Record<string, number> = {}

    for (const [legacyKey, value] of Object.entries(map)) {
      const stable = idByKey.get(legacyKey)
      if (!stable) {
        // A stableId key written by a prior run (or post-cutover). It is not itself
        // a legacy override, so it is skipped WITHOUT counting: `alreadyMigrated`
        // counts legacy overrides that already have a twin, and a migrated pair
        // would otherwise be counted once from each side.
        if (isStableIdKey(legacyKey, idByKey)) continue
        skips.push({
          staffId: s.id, legacyKey, reason: 'no_such_business',
          detail: `no business record matches "${legacyKey}" — the override is kept as-is, not dropped`,
        })
        continue
      }
      if (!isPayCents(value)) {
        skips.push({
          staffId: s.id, legacyKey, reason: 'invalid_value',
          detail: `override is not a non-negative number (${JSON.stringify(value)})`,
        })
        continue
      }
      const existing = map[stable]
      if (existing !== undefined) {
        if (existing === value) { alreadyMigrated++; continue }
        // Never overwrite money that disagrees. An owner decides which is right.
        skips.push({
          staffId: s.id, legacyKey, reason: 'value_conflict',
          detail: `legacy ${value} vs existing ${stable}=${existing} — refusing to overwrite`,
        })
        continue
      }
      add[stable] = value
    }

    if (Object.keys(add).length) rekeys.push({ staffId: s.id, add })
  }

  return {
    assignments, rekeys, skips, alreadyMigrated,
    noop: assignments.length === 0 && rekeys.length === 0,
  }
}

/** A key that is one of the stableIds we know about (i.e. already migrated). */
function isStableIdKey(key: string, idByKey: Map<string, string>): boolean {
  for (const id of idByKey.values()) if (id === key) return true
  return false
}

/**
 * Apply one staff rekey to a pay map, returning a NEW map.
 * Additive by construction — every legacy entry survives verbatim.
 */
export function applyRekey(map: Record<string, number> | undefined, add: Record<string, number>): Record<string, number> {
  return { ...(map ?? {}), ...add }
}
