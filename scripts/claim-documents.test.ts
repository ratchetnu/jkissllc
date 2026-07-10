// Native claim documents — pure template fill.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLAIM_DOC_TEMPLATES, templatesForScope, buildClaimDocValues, populateClaimDoc,
  type DocClaim, type DocAssignment,
} from '../app/lib/claim-documents'

const CLAIM: DocClaim = {
  claimNumber: 'JK-C-1042',
  claimTypeLabel: 'Property Damage',
  claimDate: 'July 3, 2026',
  businessName: 'Acme Freight',
  totalCents: 45000,
  description: 'Dented a garage door backing in.',
  routeNumber: 'JK-R-5001',
}
const COMPANY = { legalName: 'J Kiss LLC', phone: '(817) 909-4312', email: 'info@jkissllc.com' }
const ASSIGNMENT: DocAssignment = {
  name: 'Marcus Lee', responsibilityCents: 30000, responsibilityPct: 66, weeklyDeductionCents: 5000, startDate: 'July 15, 2026',
}

test('inbound claims get native templates; outbound get none', () => {
  assert.ok(templatesForScope('inbound').length >= 2, 'inbound has templates')
  assert.equal(templatesForScope('outbound').length, 0, 'outbound routes out to ClaimGuard, no native docs')
})

test('the acknowledgment fills crew, split, amount and deduction plan', () => {
  const tpl = CLAIM_DOC_TEMPLATES.find(t => t.id === 'crew-responsibility-acknowledgment')!
  const out = populateClaimDoc(tpl, buildClaimDocValues(CLAIM, COMPANY, 'July 9, 2026', ASSIGNMENT))
  assert.match(out, /Marcus Lee/)
  assert.match(out, /\$300\.00/, 'responsibility amount')
  assert.match(out, /66%/, 'responsibility percent')
  assert.match(out, /\$50\.00/, 'weekly deduction')
  assert.match(out, /July 15, 2026/, 'start date')
  assert.match(out, /\$450\.00/, 'total claimed')
  assert.match(out, /JK-C-1042/)
  assert.match(out, /Acme Freight/)
  assert.match(out, /JK-R-5001/)
  assert.ok(!/{{|}}/.test(out), 'no unfilled placeholders remain')
})

test('an optional deduction line disappears cleanly when no plan is set', () => {
  const tpl = CLAIM_DOC_TEMPLATES.find(t => t.id === 'crew-responsibility-acknowledgment')!
  const noWeekly: DocAssignment = { name: 'Sam', responsibilityCents: 10000 }
  const out = populateClaimDoc(tpl, buildClaimDocValues(CLAIM, COMPANY, 'July 9, 2026', noWeekly))
  assert.ok(!/weekly payroll deduction/i.test(out), 'no weekly line without a plan')
  assert.ok(!/{{|}}/.test(out), 'no unfilled placeholders')
  assert.ok(!/\n{3,}/.test(out), 'no gaping blank block where the line was')
})

test('the acknowledgment claim-request letter needs no crew and stays clean', () => {
  const tpl = CLAIM_DOC_TEMPLATES.find(t => t.id === 'damage-claim-acknowledgment')!
  const out = populateClaimDoc(tpl, buildClaimDocValues(CLAIM, COMPANY, 'July 9, 2026'))
  assert.match(out, /not an admission of liability/i)
  assert.match(out, /Acme Freight/)
  assert.match(out, /\$450\.00/)
  assert.ok(!/{{|}}/.test(out), 'no unfilled placeholders')
})
