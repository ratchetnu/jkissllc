// ClaimGuard Assist recommendation engine — pure logic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { recommendForClaim, claimGuardUrl, claimGuardHref, CLAIMGUARD_BASE } from '../app/lib/claim-assist'
import { CLAIM_TYPE_LABEL, directionOf, type ClaimType } from '../app/lib/claims'

const ALL_TYPES = Object.keys(CLAIM_TYPE_LABEL) as ClaimType[]

test('every claim type resolves to a complete playbook', () => {
  for (const t of ALL_TYPES) {
    const p = recommendForClaim({ claimType: t })
    assert.ok(p.headline, `${t}: headline`)
    assert.ok(p.nextAction, `${t}: nextAction`)
    assert.ok(p.evidence.length >= 3, `${t}: at least 3 evidence items`)
    assert.ok(p.document, `${t}: document`)
    assert.match(p.claimGuardPath, /^\/[a-z0-9-/]+$/, `${t}: a real relative path`)
    assert.match(p.claimGuardHref, /^https:\/\/claimguardhelp\.com\/[a-z0-9-/]+\?/, `${t}: an absolute context-carrying href`)
    assert.equal(p.direction, directionOf(t), `${t}: direction matches type`)
  }
})

test('claimGuardHref carries OpsPilot context and pre-selects the builder flow', () => {
  const cb = claimGuardHref({ claimType: 'chargeback', refCode: 'JK-C-1042', amountCents: 12345 })
  assert.match(cb, /\/tools\/dispute-builder\?/, 'routes to the builder')
  assert.match(cb, /source=opspilot/, 'attributes the lead')
  assert.match(cb, /ref=JK-C-1042/, 'carries the claim ref')
  assert.match(cb, /dispute=chargeback/, 'pre-selects the chargeback flow')
  assert.match(cb, /amount=123\.45/, 'passes the amount in dollars')

  // A dedicated landing page gets source/ref but no dispute preset (the builder param
  // is meaningless there).
  const np = claimGuardHref({ claimType: 'non_payment', refCode: 'JK-C-1' })
  assert.match(np, /\/non-payment\?/)
  assert.match(np, /source=opspilot/)
  assert.ok(!/dispute=/.test(np), 'no dispute preset on a dedicated page')

  // recommendForClaim exposes exactly the same href.
  assert.equal(
    recommendForClaim({ claimType: 'chargeback', refCode: 'X' }).claimGuardHref,
    claimGuardHref({ claimType: 'chargeback', refCode: 'X' }),
  )
})

test('direction routes the framing: inbound defends, outbound demands', () => {
  // A liability claim is inbound; a dispute is outbound.
  assert.equal(recommendForClaim({ claimType: 'property_damage' }).direction, 'inbound')
  assert.equal(recommendForClaim({ claimType: 'chargeback' }).direction, 'outbound')
  assert.equal(recommendForClaim({ claimType: 'detention' }).direction, 'outbound')
  assert.equal(recommendForClaim({ claimType: 'non_payment' }).direction, 'outbound')
})

test('the recommended documents point at the right ClaimGuard destinations', () => {
  assert.equal(recommendForClaim({ claimType: 'non_payment' }).claimGuardPath, '/non-payment')
  assert.equal(recommendForClaim({ claimType: 'unfair_deduction' }).claimGuardPath, '/deduction-from-pay')
  assert.equal(recommendForClaim({ claimType: 'detention' }).claimGuardPath, '/freight/start')
  // Chargeback has no dedicated page — it routes to the general builder, not a dead link.
  assert.equal(recommendForClaim({ claimType: 'chargeback' }).claimGuardPath, '/tools/dispute-builder')
})

test('claimGuardUrl builds an absolute claimguardhelp.com link', () => {
  assert.equal(claimGuardUrl('/non-payment'), `${CLAIMGUARD_BASE}/non-payment`)
  assert.match(claimGuardUrl('/freight/start'), /^https:\/\/claimguardhelp\.com\/freight\/start$/)
})
