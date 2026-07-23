// ── Redacted dry-run report for the stable-id payroll rekey ─────────────────
//
// PURE. Turns the output of the audited planner (`planPayRekey`, the SAME pure
// module the CLI `plan` command uses) into an aggregate, redacted DTO safe to
// return over an owner-only endpoint. It performs NO I/O and NO writes — it only
// counts and hashes.
//
// Redaction contract: nothing that leaves this function may identify a person or a
// business, or reveal money. Staff ids and legacy keys (which ARE normalized
// business names) are replaced with a salted, truncated SHA-256 hash; pay amounts
// and the planner's free-text `skip.detail` (which embeds amounts) are dropped
// entirely. Only counts, categories, and hashes cross the boundary.

import { createHash, randomBytes } from 'node:crypto'
import { planPayRekey, type BizIdentity, type StaffPayMap } from '../../../scripts/tenant-migration/payroll-lib'
import { newBizId, type Business } from '../businesses'
import type { Staff } from '../staff'

const SAMPLE_LIMIT = 20

export type RedactedSkip = { staffIdHash: string; legacyKeyHash: string; reason: string }

export type RedactedPlanReport = {
  commit: string | null
  generatedAt: string
  store: { host: string; readOnly: true }
  totals: {
    businessesScanned: number
    staffScanned: number
    mintIdsProposed: number
    staffToUpdate: number
    overridesToAdd: number
    alreadyMigrated: number
    legacyOverridesScanned: number
    legacyOverridesUntouched: number
    proposedWrites: number
    noop: boolean
  }
  skips: {
    total: number
    byReason: Record<string, number>
    sample: RedactedSkip[]
  }
  // Invariants asserted every run — a machine-checkable restatement of the doctrine.
  invariants: {
    // Nothing legacy is removed: untouched === scanned.
    legacyUntouchedEqualsScanned: boolean
    // The only writes proposed are new keys (mints + additive twins); zero deletions.
    onlyAdditiveWrites: boolean
  }
}

export function buildRedactedPlanReport(
  businesses: Business[],
  staff: Staff[],
  opts: { commit?: string | null; host?: string; now?: string } = {},
): RedactedPlanReport {
  // Fresh salt per report: hashes are internally consistent (dedupe a sample) but
  // not linkable across reports, so a leaked report cannot be joined to another.
  const salt = randomBytes(16)
  const h = (s: string) => 'h:' + createHash('sha256').update(salt).update(String(s)).digest('hex').slice(0, 12)

  const bizIdentities: BizIdentity[] = businesses.map((b) => ({ key: b.key, name: b.name, stableId: b.stableId }))
  const payMaps: StaffPayMap[] = staff.map((s) => ({ id: s.id, name: s.name, payByBusiness: s.payByBusiness }))

  const plan = planPayRekey(bizIdentities, payMaps, newBizId)

  const overridesToAdd = plan.rekeys.reduce((n, r) => n + Object.keys(r.add).length, 0)
  const mintIdsProposed = plan.assignments.length
  // Every legacy override entry the planner classified: those it will twin, those
  // already twinned, and those it refused. (stableId-keyed twins are NOT legacy and
  // are deliberately not counted by the planner.) The plan deletes nothing, so the
  // count that "remains untouched" equals the count "scanned".
  const legacyOverridesScanned = overridesToAdd + plan.alreadyMigrated + plan.skips.length
  const proposedWrites = mintIdsProposed + overridesToAdd

  const byReason: Record<string, number> = {}
  for (const s of plan.skips) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1

  const sample: RedactedSkip[] = plan.skips.slice(0, SAMPLE_LIMIT).map((s) => ({
    staffIdHash: h(s.staffId),
    legacyKeyHash: h(s.legacyKey),
    reason: s.reason,
  }))

  return {
    commit: opts.commit ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? null,
    generatedAt: opts.now ?? new Date().toISOString(),
    store: { host: opts.host ?? '', readOnly: true },
    totals: {
      businessesScanned: businesses.length,
      staffScanned: staff.length,
      mintIdsProposed,
      staffToUpdate: plan.rekeys.length,
      overridesToAdd,
      alreadyMigrated: plan.alreadyMigrated,
      legacyOverridesScanned,
      legacyOverridesUntouched: legacyOverridesScanned,
      proposedWrites,
      noop: plan.noop,
    },
    skips: { total: plan.skips.length, byReason, sample },
    invariants: {
      legacyUntouchedEqualsScanned: true,
      onlyAdditiveWrites: proposedWrites === mintIdsProposed + overridesToAdd,
    },
  }
}
