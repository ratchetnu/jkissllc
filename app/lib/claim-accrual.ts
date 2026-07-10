// Weekly deduction accrual — the ONLY place scheduled deductions get posted.
//
// Two rules make this safe, and both matter:
//
//  1. A pay week must be OVER before we deduct against it. Deducting mid-week
//     would withhold against pay the contractor hasn't finished earning.
//  2. A deduction is capped at what the contractor actually earned that week,
//     across all their claims combined. If they earned nothing, we skip the week
//     (the plan takes one week longer) rather than crediting a balance with money
//     that was never collected — that would silently forgive the claim.
//
// Called from the daily cron. Idempotent: posting is keyed on (staffId, periodDate),
// so re-running the same day is a no-op.
import { addDaysStr, centralToday, mondayOf } from './dates'
import {
  dueDeductions, postScheduledDeduction, skipScheduledDeduction, getClaim, saveClaim, listClaims,
  type ClaimRecord,
} from './claims'
import { withClaimLock } from './claim-mutex'
import { computePay } from './route-pay'

export type AccrualResult = {
  today: string
  claimsScanned: number
  posted: { claimNumber: string; staffId: string; name: string; periodDate: string; amountCents: number }[]
  skipped: { claimNumber: string; staffId: string; name: string; periodDate: string; reason: string }[]
}

/** A pay week is settled once its Sunday has passed. */
const weekIsOver = (periodDate: string, today: string): boolean => addDaysStr(periodDate, 6) < today

/**
 * Gross (pre-deduction) earnings per contractor for the Mon–Sun week starting
 * `weekStart`. Cached per week — several claims can share one contractor.
 */
function grossLoader() {
  const cache = new Map<string, Map<string, number>>()
  return async (weekStart: string): Promise<Map<string, number>> => {
    const hit = cache.get(weekStart)
    if (hit) return hit
    const pay = await computePay(weekStart, addDaysStr(weekStart, 6))
    const m = new Map(pay.contractors.map(c => [c.staffId, c.grossCents]))
    cache.set(weekStart, m)
    return m
  }
}

/**
 * Pure core: decide what to post/skip for one claim, given a way to look up a
 * contractor's remaining un-deducted pay for a week. `spend` is mutated as we go
 * so two claims can't both consume the same dollar of one paycheck.
 */
export async function accrueClaim(
  claim: ClaimRecord,
  today: string,
  grossFor: (weekStart: string) => Promise<Map<string, number>>,
  spend: Map<string, number>,          // `${staffId}|${weekStart}` → cents already committed
): Promise<{ posted: AccrualResult['posted']; skipped: AccrualResult['skipped']; changed: boolean }> {
  const posted: AccrualResult['posted'] = []
  const skipped: AccrualResult['skipped'] = []
  let changed = false

  for (const due of dueDeductions(claim, today)) {
    const period = mondayOf(due.periodDate)
    if (!weekIsOver(period, today)) continue      // the week is still being earned

    const name = claim.assignments.find(a => a.staffId === due.staffId)?.name ?? due.staffId
    const gross = (await grossFor(period)).get(due.staffId) ?? 0
    const key = `${due.staffId}|${period}`
    const committed = spend.get(key) ?? 0
    const available = Math.max(0, gross - committed)

    if (available <= 0) {
      const reason = gross <= 0 ? 'no pay that week' : 'their pay that week was fully committed to other claims'
      if (skipScheduledDeduction(claim, due.staffId, due.periodDate, reason).ok) {
        skipped.push({ claimNumber: claim.claimNumber, staffId: due.staffId, name, periodDate: due.periodDate, reason })
        changed = true
      }
      continue
    }

    const amount = Math.min(due.amountCents, available)
    const res = postScheduledDeduction(claim, due.staffId, due.periodDate, amount, 'cron')
    if (!res.ok) continue

    spend.set(key, committed + amount)
    posted.push({ claimNumber: claim.claimNumber, staffId: due.staffId, name, periodDate: due.periodDate, amountCents: amount })
    changed = true

    // Deducted less than scheduled because the paycheck ran out — say so, don't
    // let a short deduction look like a normal one.
    if (amount < due.amountCents) {
      skipped.push({
        claimNumber: claim.claimNumber, staffId: due.staffId, name, periodDate: due.periodDate,
        reason: `only ${(amount / 100).toFixed(2)} of ${(due.amountCents / 100).toFixed(2)} was available`,
      })
    }
  }

  return { posted, skipped, changed }
}

/**
 * Seed `spend` with deductions ALREADY posted against each pay week, by any claim,
 * on any previous run.
 *
 * Without this, `spend` starts empty every cron run while `grossFor` keeps
 * returning the contractor's full gross — so a deduction posted on Monday is
 * invisible to a deduction posted on Tuesday, and the two together can exceed what
 * the contractor earned that week. Reachable whenever a second claim becomes due
 * for an already-accrued week (`startDate` is admin-supplied and `dueDeductions`
 * catches up missed weeks).
 *
 * The over-collection never reaches a paycheck — applyDeductions caps the statement
 * at gross — but the claim ledger would be credited money that was never collected,
 * silently forgiving the balance. That is exactly the invariant this file exists to
 * protect (see rule 2 at the top).
 */
export function seedSpendFromLedger(claims: ClaimRecord[]): Map<string, number> {
  const spend = new Map<string, number>()
  for (const c of claims) {
    for (const a of c.assignments) {
      for (const e of a.ledger) {
        // Both scheduled deductions AND adjustment credits come off the paycheck
        // (see PAYROLL_KINDS in claim-payroll), so both consume paycheck room and
        // must be seeded — otherwise the cron posts a scheduled deduction on top of
        // an adjustment credit, crediting the ledger more than payroll can withhold
        // and silently forgiving the difference. A debit is a giveback in the other
        // direction; it does NOT free room for a new deduction (the reversal is paid
        // out on the statement, not re-deducted), so only credits are seeded.
        if (e.direction !== 'credit') continue
        if (e.kind !== 'scheduled' && e.kind !== 'adjustment') continue
        const key = `${a.staffId}|${mondayOf(e.periodDate)}`
        spend.set(key, (spend.get(key) ?? 0) + e.amountCents)
      }
    }
  }
  return spend
}

/** Run accrual across every claim. Safe to call daily. */
export async function accrueAllClaims(now: number = Date.now()): Promise<AccrualResult> {
  const today = centralToday(now)
  const claims = await listClaims(1000)
  const grossFor = grossLoader()
  // Carry forward what earlier runs already took out of each paycheck.
  const spend = seedSpendFromLedger(claims)

  const out: AccrualResult = { today, claimsScanned: claims.length, posted: [], skipped: [] }

  for (const claim of claims) {
    try {
      // Accrue + save under the claim lock, re-reading fresh inside, so a scheduled
      // deduction can't clobber a concurrent admin edit (waive/adjust/attach) on the
      // same claim. A ClaimBusyError just skips this claim for today's run — the next
      // cron catches it up. See lib/claim-mutex.
      await withClaimLock(claim.id, async () => {
        const fresh = await getClaim(claim.id)
        if (!fresh) return
        const r = await accrueClaim(fresh, today, grossFor, spend)
        out.posted.push(...r.posted)
        out.skipped.push(...r.skipped)
        if (r.changed) await saveClaim(fresh)
      })
    } catch (e) {
      console.error('[claims/accrual]', claim.claimNumber, e)
    }
  }
  return out
}
