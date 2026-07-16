// Premium pay-statement view model — pure tests (grouping, summary, reconciliation).
import assert from 'node:assert/strict'
import test from 'node:test'
import { groupEarnings, summaryRows, reconcile, DEFAULT_CLASSIFICATION } from '../app/lib/pay-statement-view'
import type { PayStatement } from '../app/lib/pay-statements'

function mk(p: Partial<PayStatement> = {}): PayStatement {
  const lines = p.lines ?? [
    { routeNumber: 'R-1', routeDate: '2026-07-01', businessName: 'Acme', amountCents: 12000 },
    { routeNumber: 'R-2', routeDate: '2026-07-02', businessName: 'Acme', amountCents: 8000 },
    { routeNumber: 'R-3', routeDate: '2026-07-03', businessName: 'Globex', amountCents: 15000 },
  ]
  const gross = lines.reduce((n, l) => n + l.amountCents, 0)
  const deductions = p.deductions ?? []
  const ded = deductions.reduce((n, d) => n + Math.abs(d.amountCents), 0)
  return {
    id: 'ps1', statementNumber: 'JK-PS-1001', staffId: 'c1', staffName: 'Jordan Rivera',
    periodStart: '2026-07-01', periodEnd: '2026-07-07', grossCents: gross, deductionCents: ded, netCents: gross - ded,
    routeCount: lines.length, lines, deductions, status: 'issued', issuedBy: 'owner', issuedAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...p,
  }
}

test('groupEarnings groups by business, preserves order, subtotals', () => {
  const g = groupEarnings(mk().lines)
  assert.deepEqual(g.map(x => x.businessName), ['Acme', 'Globex'])
  assert.equal(g[0].lines.length, 2); assert.equal(g[0].subtotalCents, 20000)
  assert.equal(g[1].subtotalCents, 15000)
})

test('summaryRows: only shows rows with values; Net always emphasized', () => {
  const plain = summaryRows(mk())
  assert.deepEqual(plain.map(r => r.key), ['gross', 'net'])   // no deductions/bonuses → omitted
  assert.equal(plain.at(-1)?.emphasis, true)
  const withDed = summaryRows(mk({ deductions: [{ label: 'Equipment', amountCents: 5000 }] }))
  assert.ok(withDed.some(r => r.key === 'ded' && r.negative))
  const withExtras = summaryRows(mk(), { bonusCents: 2500, reimbursementCents: 1500, adjustmentCents: -1000 })
  assert.ok(withExtras.some(r => r.key === 'bonus') && withExtras.some(r => r.key === 'reimb'))
  assert.ok(withExtras.find(r => r.key === 'adj')?.negative)
})

test('reconcile: passes on a consistent snapshot, flags inconsistencies', () => {
  assert.equal(reconcile(mk()).ok, true)
  assert.equal(reconcile(mk({ deductions: [{ label: 'Claim', amountCents: 3000 }] })).ok, true)
  const bad = mk(); bad.netCents = bad.netCents + 100
  const r = reconcile(bad); assert.equal(r.ok, false); assert.match(r.issues.join(), /net/)
  const badGross = mk(); badGross.grossCents = 999
  assert.equal(reconcile(badGross).ok, false)
})

test('never fabricates: default classification is a 1099 contractor (not employee)', () => {
  assert.match(DEFAULT_CLASSIFICATION, /Contractor/)
  assert.doesNotMatch(DEFAULT_CLASSIFICATION, /[Ee]mployee/)
})
