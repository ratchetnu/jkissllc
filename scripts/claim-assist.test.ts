// ClaimGuard Assist recommendation engine — pure logic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { recommendForClaim, claimGuardUrl, CLAIMGUARD_BASE } from '../app/lib/claim-assist'
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
    assert.equal(p.direction, directionOf(t), `${t}: direction matches type`)
  }
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
