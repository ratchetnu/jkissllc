import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { validateHistoricalPay } from '../app/lib/historical-pay'
import { renderStatementEmail } from '../app/lib/statement-render'
import PayStatementDoc from '../app/components/PayStatementDoc'
import HistoricalPayForm from '../app/admin/operations/pay-statements/HistoricalPayForm'
import { crewPayStatement, type PayStatement } from '../app/lib/pay-statements'
import { compensationBasis } from '../app/lib/pay-statement-view'
import { payAvailableThrough } from '../app/lib/pay-schedule'

const base = {
  periodStart: '2026-01-01', periodEnd: '2026-01-31', periodUnit: 'month',
  paymentDate: '2026-02-02', paymentMethod: 'check', paymentReference: '1042',
  lines: [
    { kind: 'hourly', description: 'Regular hours', quantity: '40.5', rate: '20.00' },
    { kind: 'daily', description: 'Two day jobs', quantity: 2, rate: '$150' },
    { kind: 'fixed', description: 'Bonus', amount: '75.25' },
  ],
  deductions: [{ label: 'Advance repayment', amount: '25.25' }],
}

test('historical pay calculates hourly, daily, fixed, deductions, and net in integer cents', () => {
  const result = validateHistoricalPay(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.lines.map(line => line.amountCents), [81000, 30000, 7525])
  assert.equal(result.value.grossCents, 118525)
  assert.equal(result.value.deductionCents, 2525)
  assert.equal(result.value.netCents, 116000)
  assert.equal(result.value.lines[0].source, 'historical')
  assert.equal(result.value.lines[0].quantity, 40.5)
  assert.equal(result.value.lines[0].rateCents, 2000)
})

test('historical pay rounds exact half-cents from integer hundredths and rejects numeric over-precision', () => {
  const halfCent = validateHistoricalPay({
    ...base,
    lines: [{ kind: 'hourly', quantity: 1.13, rate: 17.50 }],
    deductions: [],
  })
  assert.equal(halfCent.ok, true)
  if (halfCent.ok) assert.equal(halfCent.value.grossCents, 1978)

  assert.equal(validateHistoricalPay({ ...base, lines: [{ kind: 'fixed', amount: 123.4567 }] }).ok, false)
  assert.equal(validateHistoricalPay({ ...base, lines: [{ kind: 'hourly', quantity: 1, rate: 20.005 }] }).ok, false)
})

test('historical pay needs no job, route, booking, punch, or work reference', () => {
  const result = validateHistoricalPay({
    periodStart: '2026-01-06', periodEnd: '2026-01-06', periodUnit: 'day', paymentDate: '2026-01-06',
    lines: [{ kind: 'fixed', amount: '200' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.lines[0].description, 'Prior-period compensation')
  assert.equal(result.value.lines[0].routeNumber, 'Prior-period compensation')
  assert.equal(result.value.grossCents, 20000)
})

test('historical pay rejects malformed periods, quantities, rates, and over-deduction', () => {
  const cases = [
    { ...base, periodStart: '2026-02-01', periodEnd: '2026-01-01' },
    { ...base, periodUnit: 'day', periodEnd: '2026-01-02' },
    { ...base, periodUnit: 'week', periodStart: '2026-01-01', periodEnd: '2026-01-05' },
    { ...base, periodUnit: 'month', periodStart: '2026-01-02' },
    { ...base, paymentDate: '2026-02-31' },
    { ...base, periodStart: '2026-01-01GARBAGE' },
    { ...base, periodStart: '1900-01-01', periodEnd: '1900-01-31' },
    { ...base, periodStart: '3000-01-01', periodEnd: '3000-01-31', paymentDate: '3000-02-01' },
    { ...base, periodUnit: 'custom', periodStart: '2025-01-01', periodEnd: '2026-02-01' },
    { ...base, paymentDate: '2025-12-31' },
    { ...base, lines: [{ kind: 'hourly', quantity: '1.234', rate: '20' }] },
    { ...base, lines: [{ kind: 'daily', quantity: '2', rate: '-1' }] },
    { ...base, lines: [{ kind: 'fixed', amount: '10' }], deductions: [{ label: 'Too much', amount: '11' }] },
  ]
  for (const input of cases) assert.equal(validateHistoricalPay(input).ok, false)
})

test('historical pay caps aggregate gross instead of allowing line caps to multiply', () => {
  const result = validateHistoricalPay({
    ...base,
    lines: [
      { kind: 'fixed', amount: '600000' },
      { kind: 'fixed', amount: '600000' },
    ],
    deductions: [],
  })
  assert.equal(result.ok, false)
})

test('historical pay trims operator text and never accepts a client-computed total', () => {
  const result = validateHistoricalPay({ ...base, note: `  ${'x'.repeat(1200)}  `, grossCents: 1, netCents: 1 } as typeof base & { note: string; grossCents: number; netCents: number })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.note?.length, 1000)
  assert.equal(result.value.grossCents, 118525)
  assert.equal(result.value.netCents, 116000)
})

test('crew email explains compensation professionally with no manual-entry label', () => {
  const result = validateHistoricalPay(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const statement: PayStatement = {
    id: 'ps_history', statementNumber: 'JK-PS-1001', staffId: 'crew-1', staffName: 'Jordan Rivera',
    periodStart: result.value.periodStart, periodEnd: result.value.periodEnd,
    grossCents: result.value.grossCents, deductionCents: result.value.deductionCents, netCents: result.value.netCents,
    routeCount: 0, lines: result.value.lines, deductions: result.value.deductions,
    statementSource: 'historical_manual', paymentDate: result.value.paymentDate, paymentMethod: result.value.paymentMethod,
    status: 'issued', issuedBy: 'Owner', issuedAt: 1, updatedAt: 1,
  }
  const html = renderStatementEmail(statement, undefined, '2901 E Mayfield Rd, #2103, Grand Prairie, TX 75052')
  assert.match(html, /Pay Statement JK-PS-1001/)
  assert.match(html, /Mailing address: 2901 E Mayfield Rd, #2103, Grand Prairie, TX 75052/)
  assert.match(html, /Services compensated for Jan 1, 2026–Jan 31, 2026 · Hourly rate: \$20\.00/)
  assert.match(html, /Paid workdays · Jan 1, 2026–Jan 31, 2026 · Weekly on Fridays · Daily rate: \$150\.00/)
  assert.match(html, /Fixed compensation for Jan 1, 2026–Jan 31, 2026/)
  assert.match(html, /Pay schedule: Weekly on Fridays/)
  assert.doesNotMatch(html, /×/)
  assert.doesNotMatch(html, /historical|manual|manually|entered by an administrator/i)
  assert.doesNotMatch(html, /completed job/)
})

test('crew can print a full-month stub with no manual provenance while admin keeps a non-printing internal note', () => {
  const result = validateHistoricalPay({ ...base, note: 'Internal reconstruction source' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const statement: PayStatement = {
    id: 'ps_history', statementNumber: 'JK-PS-1001', staffId: 'crew-1', staffName: 'Jordan Rivera',
    contractorAddress: { line1: '2901 E Mayfield Rd', line2: '#2103', city: 'Grand Prairie', state: 'TX', postalCode: '75052' },
    periodStart: result.value.periodStart, periodEnd: result.value.periodEnd,
    grossCents: result.value.grossCents, deductionCents: result.value.deductionCents, netCents: result.value.netCents,
    routeCount: 0, lines: result.value.lines, deductions: result.value.deductions,
    statementSource: 'historical_manual', paymentDate: result.value.paymentDate,
    historicalNote: result.value.note, status: 'issued', issuedBy: 'Owner', issuedAt: 1, updatedAt: 1,
  }
  const crewStatement = crewPayStatement(statement)
  const crewPayload = JSON.stringify(crewStatement)
  assert.doesNotMatch(crewPayload, /historical|manual|manually|prior[ -]pay|entered by|administrator/i)
  assert.equal('periodUnit' in crewStatement, false)
  assert.equal('contractorAddress' in crewStatement, false)
  assert.equal('businessName' in crewStatement.lines[0], false)
  const crewHtml = renderToStaticMarkup(createElement(PayStatementDoc, {
    s: crewStatement,
    meta: { contractorAddress: '2901 E Mayfield Rd, #2103, Grand Prairie, TX 75052' },
  }))
  assert.match(crewHtml, /Contractor Pay Statement/)
  assert.match(crewHtml, /Mailing address/)
  assert.match(crewHtml, /2901 E Mayfield Rd, #2103, Grand Prairie, TX 75052/)
  assert.match(crewHtml, /@page \{ size: Letter portrait; margin: 0\.32in; \}/)
  assert.match(crewHtml, /zoom: \.94/)
  assert.match(crewHtml, /Jan 1, 2026 – Jan 31, 2026/)
  assert.match(crewHtml, /Compensation basis/)
  assert.match(crewHtml, /Services compensated for Jan 1, 2026–Jan 31, 2026 · Hourly rate: \$20\.00/)
  assert.match(crewHtml, /Paid workdays · Jan 1, 2026–Jan 31, 2026 · Weekly on Fridays · Daily rate: \$150\.00/)
  assert.match(crewHtml, /Fixed compensation for Jan 1, 2026–Jan 31, 2026/)
  assert.match(crewHtml, /Pay schedule/)
  assert.match(crewHtml, /Weekly on Fridays/)
  assert.doesNotMatch(crewHtml, /×/)
  assert.doesNotMatch(crewHtml, /historical|manual|manually|entered by an administrator/i)
  assert.doesNotMatch(crewHtml, /Internal reconstruction source/)

  const adminHtml = renderToStaticMarkup(createElement(PayStatementDoc, { s: statement, showInternalNote: true }))
  assert.match(adminHtml, /Internal reconstruction source/)
  assert.match(adminHtml, /class="no-print"[^>]*aria-label="Internal pay record note"/)
})

test('weekday daily pay identifies its schedule and covered dates for verification', () => {
  assert.equal(
    compensationBasis(
      { earningKind: 'daily', quantity: 162, rateCents: 17_500 },
      '2026-01-01',
      '2026-08-14',
    ),
    'Monday–Friday schedule · Jan 1, 2026–Aug 14, 2026 · Weekly on Fridays · Daily rate: $175.00',
  )
})

test('current pay becomes available on Friday and not earlier in the week', () => {
  assert.equal(payAvailableThrough('2026-08-19'), '2026-08-14') // Wednesday
  assert.equal(payAvailableThrough('2026-08-20'), '2026-08-14') // Thursday
  assert.equal(payAvailableThrough('2026-08-21'), '2026-08-21') // Friday
  assert.equal(payAvailableThrough('2026-08-23'), '2026-08-21') // Sunday
})

test('historical form associates every rendered label and uses wrapping mobile grids', () => {
  const html = renderToStaticMarkup(createElement(HistoricalPayForm, {
    staff: [{ id: 'crew-1', name: 'Jordan Rivera', active: true }],
    onCreated: () => {},
  }))
  assert.doesNotMatch(html, /<label(?![^>]*\bfor=)/, 'every label must name its control')
  assert.doesNotMatch(html, /minmax\(150px,.8fr\).*minmax\(190px,1.4fr\)/, 'earnings header must not force two columns on phones')
  assert.doesNotMatch(html, /minmax\(180px,1fr\).*minmax\(130px,.5fr\).*auto/, 'deductions must not force three columns on phones')
  assert.match(html, /minmax\(min\(100%,180px\),1fr\)/)
  assert.match(html, />month<\/button>/, 'admin can choose a full calendar month')
  assert.doesNotMatch(readFileSync(new URL('../app/admin/operations/pay-statements/HistoricalPayForm.tsx', import.meta.url), 'utf8'), /window\.confirm/)
  assert.match(html, />Review statement<\/button>/, 'issuance uses an automatable inline review step')
})

test('manual-entry provenance stays in the admin system and never appears on crew surfaces', () => {
  const admin = readFileSync(new URL('../app/admin/operations/pay-statements/[id]/page.tsx', import.meta.url), 'utf8')
  const portalList = readFileSync(new URL('../app/portal/pay/page.tsx', import.meta.url), 'utf8')
  const portalDetail = readFileSync(new URL('../app/portal/pay/statement/[id]/page.tsx', import.meta.url), 'utf8')
  assert.match(admin, /className="no-print os-card"[\s\S]{0,220}entered manually/)
  assert.doesNotMatch(portalList, /historical_manual|historical pay|entered manually/i)
  assert.doesNotMatch(portalDetail, /historical_manual|historical pay|entered manually/i)
  assert.match(portalDetail, /Print \/ Save PDF/, 'crew can print or save the complete monthly statement')
})

test('historical route source authenticates before body parsing and guards the distinct import permission', () => {
  const source = readFileSync(new URL('../app/api/admin/pay-statements/route.ts', import.meta.url), 'utf8')
  assert.ok(source.indexOf('await requirePrincipal(req)') < source.indexOf('await req.json()'))
  assert.match(source, /historical \? 'pay:history:import' : 'pay:generate'/)
})
