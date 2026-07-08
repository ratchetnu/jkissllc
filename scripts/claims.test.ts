// Claims + crew deduction recovery. Pure functions only — no Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocate, setResponsibility, startDeduction, pauseDeduction, waiveBalance, recordPayment,
  adjustBalance, closeClaim, dueDeductions, postScheduledDeduction, skipScheduledDeduction,
  rollupClaimStatus, snapshotFromRoute, snapshotFromBusiness,
  remainingCents, recoveredCents, creditedCents, claimRemainingCents, claimRecoveredCents,
  claimWaivedCents, assignedCents, unassignedCents,
  type ClaimRecord, type ClaimAssignment,
} from '../app/lib/claims'
import { accrueClaim } from '../app/lib/claim-accrual'
import { deductionLinesFor, sumDeductions, applyDeductions } from '../app/lib/claim-payroll'
import { computeClaimsReport, crewClaimSummary, businessClaimSummary, isOpen } from '../app/lib/claims-report'
import { toPublicRouteFor } from '../app/lib/routes'
import type { RouteRecord, Assignee } from '../app/lib/routes'
import type { Business } from '../app/lib/businesses'
import { mondayOf, addDaysStr } from '../app/lib/dates'

// ── helpers ──────────────────────────────────────────────────────────────────
const claim = (o: Partial<ClaimRecord> = {}): ClaimRecord => ({
  id: 'c1', claimNumber: 'JK-C-1001', status: 'approved', claimType: 'property_damage',
  businessKey: 'amazon dsp', businessName: 'Amazon DSP',
  claimDate: '2026-07-01', reportedDate: '2026-07-02',
  description: 'Backed into a bollard', totalCents: 80000,
  attachments: [], assignments: [], audit: [],
  snapshot: { at: 1, businessKey: 'amazon dsp', businessName: 'Amazon DSP', crew: [] },
  createdAt: 1, updatedAt: 1,
  ...o,
})

const person = (staffId: string, name = staffId) => ({ staffId, name })

/** Give a claim crew via the real mutator, so tests exercise the same path the API does. */
function withCrew(c: ClaimRecord, mode: 'equal' | 'percent' | 'dollar', people: { id: string; value?: number; weekly?: number }[]) {
  const res = setResponsibility(
    c,
    people.map(p => ({ ...person(p.id), weeklyDeductionCents: p.weekly })),
    mode,
    people.map(p => ({ staffId: p.id, value: p.value })),
  )
  assert.equal(res.ok, true, 'setResponsibility should succeed: ' + (!res.ok ? res.error : ''))
  return c
}
const find = (c: ClaimRecord, id: string): ClaimAssignment => c.assignments.find(a => a.staffId === id)!

// ── Allocation ───────────────────────────────────────────────────────────────
test('equal split never loses or invents a cent', () => {
  const r = allocate(10000, 'equal', [person('a'), person('b'), person('c')])
  assert.equal(r.ok, true)
  if (!r.ok) return
  const parts = Object.values(r.cents)
  assert.deepEqual(parts.sort((x, y) => y - x), [3334, 3333, 3333])
  assert.equal(parts.reduce((s, x) => s + x, 0), 10000)
})

test('percent split sums exactly to the claim when it totals 100%', () => {
  const r = allocate(80000, 'percent', [{ staffId: 'd', value: 62.5 }, { staffId: 'h', value: 37.5 }])
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.cents, { d: 50000, h: 30000 })
})

test('under-allocating is allowed — J KISS absorbs the rest', () => {
  const c = withCrew(claim({ totalCents: 80000 }), 'dollar', [{ id: 'd', value: 50000 }])
  assert.equal(assignedCents(c), 50000)
  assert.equal(unassignedCents(c), 30000)
})

test('assigned responsibility can never exceed the claim', () => {
  const over = allocate(80000, 'dollar', [{ staffId: 'd', value: 50000 }, { staffId: 'h', value: 40000 }])
  assert.equal(over.ok, false)
  assert.match(!over.ok ? over.error : '', /more than the claim/)

  const pct = allocate(80000, 'percent', [{ staffId: 'd', value: 70 }, { staffId: 'h', value: 40 }])
  assert.equal(pct.ok, false)
  assert.match(!pct.ok ? pct.error : '', /can't exceed 100%/)
})

test('the same person cannot be listed twice', () => {
  assert.equal(allocate(100, 'equal', [person('a'), person('a')]).ok, false)
})

// ── Snapshots ────────────────────────────────────────────────────────────────
const route = (o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: 'r1', routeNumber: 'JK-R-1001', status: 'completed',
  businessName: 'Amazon DSP', reportAddress: '1 Commerce St', reportTime: '7:00 AM',
  routeDate: '2026-07-01', events: [], audit: [], createdAt: 1, updatedAt: 1,
  financials: { businessPriceCents: 45000, priceSource: 'contract', snapshotAt: 1 },
  assignees: [
    { staffId: 'd', name: 'Marcus', role: 'Driver', token: 'td', payCents: 17500 },
    { staffId: 'h', name: 'Dee', role: 'Helper', token: 'th', payCents: 15000 },
  ] as Assignee[],
  ...o,
}) as RouteRecord

const biz = (o: Partial<Business> = {}): Business =>
  ({ key: 'amazon dsp', name: 'Amazon DSP', contractRateCents: 45000, createdAt: 1, updatedAt: 1, ...o }) as Business

test('a claim snapshots the route money and crew as they were', () => {
  const r = route()
  const snap = snapshotFromRoute(r, biz())
  assert.equal(snap.businessPriceCents, 45000)
  assert.equal(snap.routePayoutCents, 32500)
  assert.equal(snap.routeProfitCents, 12500)
  assert.deepEqual(snap.crew.map(c => c.staffId), ['d', 'h'])
  assert.equal(snap.routeNumber, 'JK-R-1001')
})

// The whole reason snapshots exist: history must not rewrite itself.
test('re-pricing the route or re-crewing it later never rewrites the claim snapshot', () => {
  const r = route()
  const snap = snapshotFromRoute(r, biz())

  r.financials = { businessPriceCents: 99900, priceSource: 'manual', snapshotAt: 2 }
  r.assignees = [{ staffId: 'x', name: 'Someone Else', token: 'tx', payCents: 1 } as Assignee]
  r.businessName = 'Renamed Client'

  assert.equal(snap.businessPriceCents, 45000, 'price is frozen')
  assert.equal(snap.routePayoutCents, 32500, 'payout is frozen')
  assert.deepEqual(snap.crew.map(c => c.staffId), ['d', 'h'], 'crew is frozen')
  assert.equal(snap.businessName, 'Amazon DSP', 'business name is frozen')
})

test('a claim opened straight from a business carries no route money', () => {
  const snap = snapshotFromBusiness('Amazon DSP', biz())
  assert.equal(snap.routeToken, undefined)
  assert.equal(snap.routePayoutCents, undefined)
  assert.deepEqual(snap.crew, [])
})

// ── Deduction scheduling ─────────────────────────────────────────────────────
const MON = '2026-07-06'   // a Monday

test('starting a deduction snaps to the Monday of the pay week', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  assert.equal(startDeduction(c, 'd', { weeklyCents: 5000, startDate: '2026-07-09' }).ok, true)  // a Thursday
  assert.equal(find(c, 'd').startDate, MON)
  assert.equal(find(c, 'd').nextDeductionOn, MON)
  assert.equal(c.status, 'deduction_active')
})

test('a deduction cannot start without a weekly amount', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  const r = startDeduction(c, 'd', {})
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : '', /weekly deduction amount/)
})

test('weekly deductions draw the balance down and stop exactly at zero', () => {
  const c = withCrew(claim({ totalCents: 12000 }), 'dollar', [{ id: 'd', value: 12000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })

  for (const wk of [0, 1, 2]) {
    const period = addDaysStr(MON, wk * 7)
    const due = dueDeductions(c, period)
    assert.equal(due.length, 1, `week ${wk} has one due deduction`)
    postScheduledDeduction(c, 'd', period, due[0].amountCents)
  }

  const a = find(c, 'd')
  assert.equal(recoveredCents(a), 12000)
  assert.equal(remainingCents(a), 0)
  assert.equal(a.status, 'completed', 'the plan closes itself')
  // The final week takes 2000, not the full 5000 — never over-collect.
  assert.deepEqual(a.ledger.map(e => e.amountCents), [5000, 5000, 2000])
  assert.equal(c.status, 'paid')
})

test('posting the same week twice is refused (idempotent cron)', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  assert.equal(postScheduledDeduction(c, 'd', MON, 5000).ok, true)
  const again = postScheduledDeduction(c, 'd', MON, 5000)
  assert.equal(again.ok, false)
  assert.match(!again.ok ? again.error : '', /already taken/)
  assert.equal(recoveredCents(find(c, 'd')), 5000)
})

test('dueDeductions catches up missed weeks without over-deducting the balance', () => {
  const c = withCrew(claim({ totalCents: 12000 }), 'dollar', [{ id: 'd', value: 12000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  // Cron was down for a month.
  const due = dueDeductions(c, addDaysStr(MON, 28))
  assert.equal(due.length, 3, 'three weeks of catch-up, not five')
  assert.equal(due.reduce((s, d) => s + d.amountCents, 0), 12000, 'never more than owed')
})

test('a paused deduction is not due, and resuming keeps the balance', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)

  assert.equal(pauseDeduction(c, 'd', 'sick').ok, true)
  assert.equal(dueDeductions(c, addDaysStr(MON, 21)).length, 0, 'paused = nothing due')
  assert.equal(find(c, 'd').status, 'paused')

  assert.equal(startDeduction(c, 'd', {}).ok, true, 'resume')
  assert.equal(find(c, 'd').status, 'active')
  assert.equal(remainingCents(find(c, 'd')), 45000, 'balance survived the pause')
})

test('skipping a week advances the schedule without touching the balance', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  assert.equal(skipScheduledDeduction(c, 'd', MON, 'no pay that week').ok, true)

  const a = find(c, 'd')
  assert.equal(remainingCents(a), 50000, 'nothing forgiven')
  assert.equal(recoveredCents(a), 0, 'nothing collected')
  assert.equal(a.nextDeductionOn, addDaysStr(MON, 7))
  assert.match(c.audit.at(-1)!.action, /Skipped/)
})

// ── Accrual: the earnings cap ────────────────────────────────────────────────
const grossOf = (m: Record<string, number>) => async () => new Map(Object.entries(m))

test('accrual waits until the pay week has actually ended', async () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })

  // Wednesday of the same week — the contractor is still earning it.
  const r = await accrueClaim(c, addDaysStr(MON, 2), grossOf({ d: 100000 }), new Map())
  assert.deepEqual(r.posted, [])
  assert.equal(recoveredCents(find(c, 'd')), 0)
})

test('a deduction never exceeds what the contractor earned that week', async () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })

  // They earned only $30 that week; the schedule wanted $50.
  const r = await accrueClaim(c, addDaysStr(MON, 8), grossOf({ d: 3000 }), new Map())
  assert.equal(r.posted.length, 1)
  assert.equal(r.posted[0].amountCents, 3000, 'capped at earnings')
  assert.equal(remainingCents(find(c, 'd')), 47000, 'the rest stays owed')
  assert.match(r.skipped[0]?.reason ?? '', /available/)
})

// This is the bug that silently forgives money: crediting a balance for a
// deduction that was never actually withheld from a paycheck.
test('a week with no pay collects nothing and forgives nothing', async () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })

  const r = await accrueClaim(c, addDaysStr(MON, 8), grossOf({}), new Map())
  assert.deepEqual(r.posted, [])
  assert.equal(r.skipped.length, 1)
  assert.equal(remainingCents(find(c, 'd')), 50000, 'balance untouched')
  assert.equal(recoveredCents(find(c, 'd')), 0, 'nothing recorded as collected')
})

test('two claims cannot both consume the same paycheck', async () => {
  const c1 = withCrew(claim({ id: 'c1', claimNumber: 'JK-C-1001' }), 'dollar', [{ id: 'd', value: 50000 }])
  const c2 = withCrew(claim({ id: 'c2', claimNumber: 'JK-C-1002' }), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c1, 'd', { weeklyCents: 5000, startDate: MON })
  startDeduction(c2, 'd', { weeklyCents: 5000, startDate: MON })

  const spend = new Map<string, number>()
  const gross = grossOf({ d: 7000 })            // only $70 earned; two × $50 scheduled
  const today = addDaysStr(MON, 8)
  const r1 = await accrueClaim(c1, today, gross, spend)
  const r2 = await accrueClaim(c2, today, gross, spend)

  assert.equal(r1.posted[0].amountCents, 5000)
  assert.equal(r2.posted[0].amountCents, 2000, 'second claim only gets what is left')
  const totalTaken = recoveredCents(find(c1, 'd')) + recoveredCents(find(c2, 'd'))
  assert.equal(totalTaken, 7000, 'never withhold more than the paycheck')
})

// ── Payments, waivers, adjustments ───────────────────────────────────────────
test('a cash payment settles the balance and cannot overpay', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  const over = recordPayment(c, 'd', 60000)
  assert.equal(over.ok, false)
  assert.match(!over.ok ? over.error : '', /more than/)

  assert.equal(recordPayment(c, 'd', 50000, { note: 'cash' }).ok, true)
  assert.equal(remainingCents(find(c, 'd')), 0)
  assert.equal(find(c, 'd').status, 'completed')
})

test('a waiver forgives the balance but is never counted as money recovered', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)

  assert.equal(waiveBalance(c, 'd', 'first offense').ok, true)
  const a = find(c, 'd')
  assert.equal(remainingCents(a), 0)
  assert.equal(recoveredCents(a), 5000, 'only the real deduction counts as recovered')
  assert.equal(claimWaivedCents(c), 45000)
  assert.equal(a.status, 'waived')
  assert.equal(a.nextDeductionOn, undefined, 'no further deductions')
  assert.equal(dueDeductions(c, addDaysStr(MON, 30)).length, 0)
})

test('an adjustment corrects the balance without erasing history', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)

  // Deducted in error — give it back.
  assert.equal(adjustBalance(c, 'd', 5000, 'debit', 'deducted in error').ok, true)
  const a = find(c, 'd')
  assert.equal(remainingCents(a), 50000, 'balance restored')
  assert.equal(a.ledger.length, 2, 'the original deduction is still on the record')
  assert.equal(creditedCents(a), 0)

  assert.equal(adjustBalance(c, 'd', 1, 'debit', 'again').ok, false, 'cannot debit past zero')
  assert.equal(adjustBalance(c, 'd', 999999, 'credit', 'oops').ok, false, 'cannot credit past the balance')
  assert.equal(adjustBalance(c, 'd', 100, 'credit', '').ok, false, 'a reason is required')
})

test('a debit re-opens a completed balance instead of silently leaving it paid', () => {
  const c = withCrew(claim({ totalCents: 5000 }), 'dollar', [{ id: 'd', value: 5000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)
  assert.equal(find(c, 'd').status, 'completed')

  adjustBalance(c, 'd', 5000, 'debit', 'reversed')
  assert.equal(find(c, 'd').status, 'paused')
  assert.equal(remainingCents(find(c, 'd')), 5000)
})

// ── Re-assigning responsibility ──────────────────────────────────────────────
test('someone who already paid in cannot be dropped or under-charged', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }, { id: 'h', value: 30000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)

  const dropped = setResponsibility(c, [person('h')], 'dollar', [{ staffId: 'h', value: 30000 }])
  assert.equal(dropped.ok, false)
  assert.match(!dropped.ok ? dropped.error : '', /already had .* deducted/)

  const tooLow = setResponsibility(
    c, [person('d'), person('h')], 'dollar',
    [{ staffId: 'd', value: 1000 }, { staffId: 'h', value: 30000 }],
  )
  assert.equal(tooLow.ok, false)
  assert.match(!tooLow.ok ? tooLow.error : '', /can't drop below/)
})

test('changing a share is audited with the old value', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  setResponsibility(c, [person('d')], 'dollar', [{ staffId: 'd', value: 40000 }])
  const entry = c.audit.at(-1)!
  assert.match(entry.action, /responsibility changed to \$400\.00/)
  assert.match(entry.note ?? '', /was \$500\.00/)
})

// ── Status rollup ────────────────────────────────────────────────────────────
test('claim status tracks the recovery, and terminal statuses stick', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  assert.equal(rollupClaimStatus(c), 'approved', 'pending crew do not activate it')

  startDeduction(c, 'd', { weeklyCents: 50000, startDate: MON })
  assert.equal(c.status, 'deduction_active')

  postScheduledDeduction(c, 'd', MON, 50000)
  assert.equal(c.status, 'paid')

  closeClaim(c, 'settled with client')
  assert.equal(rollupClaimStatus(c), 'closed', 'closed is terminal')
  assert.equal(c.closedAt !== undefined, true)
})

test('a waived claim never re-activates', () => {
  const c = claim({ status: 'waived' })
  withCrew(c, 'dollar', [{ id: 'd', value: 50000 }])
  assert.equal(rollupClaimStatus(c), 'waived')
  assert.equal(dueDeductions(c, addDaysStr(MON, 30)).length, 0, 'terminal claims never accrue')
})

// ── Audit trail ──────────────────────────────────────────────────────────────
test('every significant action appends an immutable audit event', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  const at = [...c.audit]
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)
  pauseDeduction(c, 'd', 'sick')
  adjustBalance(c, 'd', 1000, 'credit', 'goodwill')
  waiveBalance(c, 'd', 'first offense')
  closeClaim(c, 'done')

  // Earlier entries are untouched, in order, and never rewritten.
  assert.deepEqual(c.audit.slice(0, at.length), at)
  const actions = c.audit.map(e => e.action).join(' | ')
  for (const expected of [/made responsible/, /Started/, /Deducted/, /Paused/, /Credited/, /Waived/, /Claim closed/]) {
    assert.match(actions, expected)
  }
})

// ── Payroll integration ──────────────────────────────────────────────────────
test('payroll reads posted deductions and names the claim behind each one', () => {
  const c = withCrew(claim({ routeNumber: 'JK-R-1001' }), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)

  const lines = deductionLinesFor([c], MON, addDaysStr(MON, 6)).get('d')!
  assert.equal(lines.length, 1)
  assert.equal(lines[0].amountCents, 5000)
  assert.equal(lines[0].claimNumber, 'JK-C-1001')
  assert.equal(lines[0].businessName, 'Amazon DSP')
  assert.equal(lines[0].routeNumber, 'JK-R-1001')
  assert.match(lines[0].reason, /Claim deduction/)
})

test('cash payments and waivers never appear on a pay statement', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  recordPayment(c, 'd', 10000, { date: MON })
  waiveBalance(c, 'd', 'forgiven')
  assert.equal(deductionLinesFor([c], MON, addDaysStr(MON, 6)).size, 0, 'neither touches payroll')
})

test('a reversal shows on the statement as money handed back', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)
  adjustBalance(c, 'd', 5000, 'debit', 'deducted in error')

  const lines = deductionLinesFor([c], MON, addDaysStr(MON, 30)).get('d')!
  assert.equal(lines.length, 2)
  assert.equal(sumDeductions(lines), 0, 'the deduction and its reversal cancel out')
  assert.equal(lines.some(l => l.amountCents < 0), true, 'the reversal is visible, not hidden')
})

test('deductions never push a pay statement negative', () => {
  assert.deepEqual(applyDeductions(20000, 5000), { appliedCents: 5000, netCents: 15000, shortfallCents: 0 })
  // Owed more than earned: withhold only what exists, and report the shortfall.
  assert.deepEqual(applyDeductions(3000, 5000), { appliedCents: 3000, netCents: 0, shortfallCents: 2000 })
  assert.deepEqual(applyDeductions(0, 5000), { appliedCents: 0, netCents: 0, shortfallCents: 5000 })
})

// ── Reporting ────────────────────────────────────────────────────────────────
test('reporting rolls up totals, recovery and outstanding balances', () => {
  const c1 = withCrew(claim({ id: 'c1', claimNumber: 'JK-C-1001', totalCents: 80000 }), 'dollar', [{ id: 'd', value: 50000 }, { id: 'h', value: 30000 }])
  startDeduction(c1, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c1, 'd', MON, 5000)

  const c2 = withCrew(claim({ id: 'c2', claimNumber: 'JK-C-1002', totalCents: 20000, businessKey: 'acme', businessName: 'Acme', claimDate: '2026-06-02' }), 'equal', [{ id: 'd' }])

  const r = computeClaimsReport([c1, c2])
  assert.equal(r.claimCount, 2)
  assert.equal(r.totalCents, 100000)
  assert.equal(r.assignedCents, 100000)
  assert.equal(r.recoveredCents, 5000)
  assert.equal(r.outstandingCents, 95000)
  assert.equal(r.averageCents, 50000)
  assert.equal(r.largest?.claimNumber, 'JK-C-1001')
  assert.equal(r.openCount, 2)

  // A claim split two ways must not be double-counted in the per-crew sheet.
  const byCrew = Object.fromEntries(r.byCrew.map(g => [g.key, g.totalCents]))
  assert.deepEqual(byCrew, { d: 70000, h: 30000 })
  assert.equal(r.byCrew.reduce((s, g) => s + g.totalCents, 0), r.assignedCents)

  assert.equal(r.byBusiness.length, 2)
  assert.deepEqual(r.trend.map(t => t.month), ['2026-06', '2026-07'])
})

test('reporting filters by business, crew, status and date', () => {
  const c1 = withCrew(claim({ id: 'c1', claimDate: '2026-07-01' }), 'dollar', [{ id: 'd', value: 50000 }])
  const c2 = claim({ id: 'c2', businessKey: 'acme', businessName: 'Acme', claimDate: '2026-05-01', status: 'closed' })

  assert.equal(computeClaimsReport([c1, c2], { businessKey: 'acme' }).claimCount, 1)
  assert.equal(computeClaimsReport([c1, c2], { staffId: 'd' }).claimCount, 1)
  assert.equal(computeClaimsReport([c1, c2], { status: 'open' }).claimCount, 1)
  assert.equal(computeClaimsReport([c1, c2], { start: '2026-06-01' }).claimCount, 1)
  assert.equal(isOpen(c2), false)
})

test('the crew view shows one person their own balances only', () => {
  const c = withCrew(claim(), 'dollar', [{ id: 'd', value: 50000 }, { id: 'h', value: 30000 }])
  startDeduction(c, 'd', { weeklyCents: 5000, startDate: MON })
  postScheduledDeduction(c, 'd', MON, 5000)

  const s = crewClaimSummary([c], 'd')
  assert.equal(s.lines.length, 1)
  assert.equal(s.responsibilityCents, 50000, "not the claim's $800")
  assert.equal(s.recoveredCents, 5000)
  assert.equal(s.outstandingCents, 45000)
  assert.equal(s.weeklyDeductionCents, 5000)
  assert.equal(crewClaimSummary([c], 'h').outstandingCents, 30000)
  assert.equal(crewClaimSummary([c], 'nobody').lines.length, 0)
})

test('the business view totals that client’s claim history', () => {
  const c1 = withCrew(claim({ id: 'c1', totalCents: 80000 }), 'dollar', [{ id: 'd', value: 50000 }])
  const c2 = claim({ id: 'c2', claimNumber: 'JK-C-1002', totalCents: 20000, status: 'closed' })
  const s = businessClaimSummary([c1, c2], 'amazon dsp')
  assert.equal(s.claimCount, 2)
  assert.equal(s.totalCents, 100000)
  assert.equal(s.averageCents, 50000)
  assert.equal(s.largestCents, 80000)
  assert.equal(s.openCount, 1)
  assert.equal(s.outstandingCents, 50000)
  assert.equal(businessClaimSummary([c1, c2], 'acme').claimCount, 0)
})

// ── Leakage: claims must never reach a contractor's confirm page ─────────────
test('the public route projection exposes no claim, pricing or profit data', () => {
  const r = route()
  const pub = toPublicRouteFor(r, r.assignees![0], { showPay: true })
  const json = JSON.stringify(pub)

  for (const forbidden of ['claim', 'Claim', '45000', 'profit', 'financials', 'businessPrice']) {
    assert.equal(json.includes(forbidden), false, `PublicRoute leaked "${forbidden}"`)
  }
  // Their own pay may show; the other crew member's may not.
  assert.equal(pub.assignedStaffName, 'Marcus')
  assert.equal(json.includes('Dee'), false, "another contractor's identity leaked")
})

test('claim helpers are safe on a claim with no crew', () => {
  const c = claim()
  assert.equal(claimRemainingCents(c), 0)
  assert.equal(claimRecoveredCents(c), 0)
  assert.equal(unassignedCents(c), 80000)
  assert.deepEqual(dueDeductions(c, MON), [])
  assert.equal(rollupClaimStatus(c), 'approved')
})

test('mondayOf is the pay-week anchor payroll already uses', () => {
  assert.equal(mondayOf('2026-07-09'), MON)   // Thursday → Monday
  assert.equal(mondayOf(MON), MON)
  assert.equal(mondayOf('2026-07-12'), MON)   // Sunday → same week's Monday
})
