// Claim deductions → pay run — the money-critical math. These guard two defects
// found in the July 2026 OpsPilot audit:
//   #2  a net-negative period (a reversal owed BACK to the contractor) must be paid
//       out in full, not clamped to zero.
//   #4  an adjustment CREDIT consumes paycheck room, so the accrual seed must count
//       it — otherwise the cron over-posts and silently forgives the balance.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyDeductions, deductionLinesFor, sumDeductions } from '../app/lib/claim-payroll'
import { seedSpendFromLedger } from '../app/lib/claim-accrual'
import { mondayOf } from '../app/lib/dates'
import type { ClaimRecord, LedgerEntry, LedgerKind } from '../app/lib/claims'

// ── fixtures ─────────────────────────────────────────────────────────────────
let seq = 0
function led(kind: LedgerKind, direction: 'credit' | 'debit', amountCents: number, periodDate: string): LedgerEntry {
  return { id: `e${seq++}`, at: 0, kind, direction, amountCents, periodDate, actor: 'test' }
}
function claimWith(staffId: string, ledger: LedgerEntry[]): ClaimRecord {
  return {
    id: 'c1', claimNumber: 'JK-C-1001', businessName: 'Acme', routeNumber: 'JK-R-1001',
    assignments: [{ staffId, name: 'Dee', responsibilityCents: 100000, status: 'active', ledger }],
  } as unknown as ClaimRecord
}

const WEEK = '2026-06-01'                 // a Monday
const KEY = (staffId: string) => `${staffId}|${mondayOf(WEEK)}`

// ── applyDeductions ──────────────────────────────────────────────────────────
test('applyDeductions withholds a deduction within gross', () => {
  const r = applyDeductions(50000, 20000)
  assert.deepEqual(r, { appliedCents: 20000, netCents: 30000, shortfallCents: 0 })
})

test('applyDeductions caps at gross and carries the remainder as shortfall', () => {
  const r = applyDeductions(20000, 50000)
  assert.deepEqual(r, { appliedCents: 20000, netCents: 0, shortfallCents: 30000 })
})

test('#2: a net-negative deduction (reversal) is paid back in full, not swallowed', () => {
  // A $200 reversal owed back, no offsetting deduction this week.
  const r = applyDeductions(20000, -20000)
  assert.equal(r.appliedCents, -20000, 'applied goes negative = money handed back')
  assert.equal(r.netCents, 40000, 'net pay exceeds gross by the reversal')
  assert.equal(r.shortfallCents, 0)
  assert.ok(r.netCents > 20000, 'the giveback reached the paycheck')
})

test('#2: a reversal is paid back even with no routes earned that week', () => {
  const r = applyDeductions(0, -20000)
  assert.deepEqual(r, { appliedCents: -20000, netCents: 20000, shortfallCents: 0 })
})

test('#2 end-to-end: a lone adjustment debit in the period increases net pay', () => {
  const claim = claimWith('s1', [led('adjustment', 'debit', 20000, WEEK)])
  const lines = deductionLinesFor([claim], '2026-06-01', '2026-06-07').get('s1') ?? []
  const deduction = sumDeductions(lines)
  assert.equal(deduction, -20000, 'a debit signs negative = handed back')
  const r = applyDeductions(30000, deduction)
  assert.equal(r.netCents, 50000, 'contractor receives their pay plus the reversal')
})

// ── seedSpendFromLedger ──────────────────────────────────────────────────────
test('#4: seed counts scheduled AND adjustment credits as committed paycheck room', () => {
  const claim = claimWith('s1', [
    led('scheduled', 'credit', 10000, WEEK),
    led('adjustment', 'credit', 5000, WEEK),
  ])
  const spend = seedSpendFromLedger([claim])
  assert.equal(spend.get(KEY('s1')), 15000, 'adjustment credit must be included, or the cron over-posts')
})

test('#4: seed ignores debits, waivers and cash payments', () => {
  const claim = claimWith('s1', [
    led('scheduled', 'credit', 10000, WEEK),
    led('adjustment', 'debit', 2000, WEEK),   // giveback — does not free room
    led('waiver', 'credit', 3000, WEEK),      // forgiven — never withheld
    led('payment', 'credit', 4000, WEEK),     // cash outside payroll
  ])
  const spend = seedSpendFromLedger([claim])
  assert.equal(spend.get(KEY('s1')), 10000, 'only scheduled + adjustment credits consume the paycheck')
})

test('seed groups by (staff, pay-week Monday)', () => {
  const claim = claimWith('s1', [
    led('scheduled', 'credit', 10000, '2026-06-03'),   // Wed of the same week
    led('scheduled', 'credit', 5000, '2026-06-01'),
  ])
  const spend = seedSpendFromLedger([claim])
  assert.equal(spend.get(KEY('s1')), 15000, 'both entries land in the same Monday bucket')
})
