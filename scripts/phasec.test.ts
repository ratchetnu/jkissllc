// Phase C pure-logic tests: 1099 readiness + statement email render. No Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeTaxReadiness, THRESHOLD_1099_CENTS } from '../app/lib/tax-readiness'
import { renderStatementEmail } from '../app/lib/statement-render'
import type { PayStatement } from '../app/lib/pay-statements'

// ── 1099 readiness ───────────────────────────────────────────────────────────
test('under the $600 threshold → no 1099 needed, ready regardless of W-9', () => {
  const r = computeTaxReadiness(undefined, 50000) // $500
  assert.equal(r.reachesThreshold, false)
  assert.equal(r.estimated1099Cents, 0)
  assert.equal(r.ready, true)
})

test('over threshold with no W-9 → not ready, lists missing info', () => {
  const r = computeTaxReadiness(undefined, THRESHOLD_1099_CENTS + 100_00)
  assert.equal(r.reachesThreshold, true)
  assert.equal(r.estimated1099Cents, THRESHOLD_1099_CENTS + 100_00)
  assert.equal(r.ready, false)
  assert.ok(r.missing.includes('W-9 not collected'))
  assert.ok(r.missing.includes('TIN not on file'))
  assert.ok(r.missing.includes('Address incomplete'))
})

test('over threshold with complete W-9 → ready, no missing', () => {
  const r = computeTaxReadiness({ status: 'verified', addressComplete: true, tinLast4: '1234' }, 200000)
  assert.equal(r.ready, true)
  assert.deepEqual(r.missing, [])
})

test('partial W-9 (status on_file, no address) → not ready', () => {
  const r = computeTaxReadiness({ status: 'on_file', tinLast4: '9999' }, 200000)
  assert.equal(r.ready, false)
  assert.deepEqual(r.missing, ['Address incomplete'])
})

// ── statement email render ───────────────────────────────────────────────────
const stmt: PayStatement = {
  id: 'ps_1', statementNumber: 'JK-PS-1001', staffId: 's1', staffName: 'Jordan Rivers',
  periodStart: '2026-07-01', periodEnd: '2026-07-07',
  grossCents: 52500, deductionCents: 5000, netCents: 47500, routeCount: 3,
  lines: [
    { routeNumber: 'JK-R-1001', routeDate: '2026-07-02', businessName: 'Amazon DSP', amountCents: 17500 },
    { routeNumber: 'JK-R-1002', routeDate: '2026-07-04', businessName: 'Amazon DSP', amountCents: 17500 },
    { routeNumber: 'JK-R-1003', routeDate: '2026-07-06', businessName: 'FedEx', amountCents: 17500 },
  ],
  deductions: [{ label: 'Damage recovery (JK-C-1002)', amountCents: 5000 }],
  status: 'issued', issuedBy: 'Owner', issuedAt: 1_780_000_000_000, updatedAt: 1_780_000_000_000,
}

test('statement email renders numbers and escapes safely', () => {
  const html = renderStatementEmail(stmt)
  assert.ok(html.includes('JK-PS-1001'))
  assert.ok(html.includes('Jordan Rivers'))
  assert.ok(html.includes('$475.00')) // net
  assert.ok(html.includes('$525.00')) // gross
  assert.ok(html.includes('-$50.00')) // deduction
})

test('statement email escapes HTML in names', () => {
  const evil = { ...stmt, staffName: '<script>x</script>' }
  const html = renderStatementEmail(evil)
  assert.ok(!html.includes('<script>x</script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})
