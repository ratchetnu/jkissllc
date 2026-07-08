// Verbal ("I talked to them") confirmation of a crew member. Pure functions — no Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmVerbally, undoVerbalConfirm, rollupStatus } from '../app/lib/routes'
import type { RouteRecord, Assignee } from '../app/lib/routes'

const assignee = (o: Partial<Assignee> & { staffId: string }): Assignee =>
  ({ name: o.staffId, token: 't_' + o.staffId, ...o }) as Assignee

const route = (assignees: Assignee[], o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: 'r1', routeNumber: 'JK-R-1001', status: 'assigned',
  businessName: 'Amazon DSP', reportAddress: '1 Commerce St', reportTime: '7:00 AM',
  routeDate: '2026-07-09', events: [], audit: [], createdAt: 1, updatedAt: 1,
  assignees, ...o,
}) as RouteRecord

test('verbal confirm marks the person confirmed and rolls the route up', () => {
  const r = route([assignee({ staffId: 'marcus', smsSentAt: 100 })])
  const res = confirmVerbally(r, 'marcus', 'called at 6am')
  assert.equal(res.ok, true)

  const a = r.assignees![0]
  assert.ok(a.confirmedAt, 'confirmedAt is stamped')
  assert.equal(a.confirmedVia, 'verbal')
  assert.equal(a.verbalNote, 'called at 6am')
  assert.equal(r.status, 'confirmed', 'single-crew route rolls up to confirmed')
  assert.equal(r.confirmedAt, a.confirmedAt, 'syncLead mirrors the lead assignee')
})

// The whole point of the feature: it must NOT forge the contractor's e-signature.
test('verbal confirm never fabricates the disclaimer signature', () => {
  const r = route([assignee({ staffId: 'marcus' })])
  confirmVerbally(r, 'marcus')
  const a = r.assignees![0]
  assert.equal(a.disclaimerAcceptedAt, undefined, 'no disclaimer acceptance is invented')
  assert.equal(a.confirmIp, undefined, 'no IP is invented')
  assert.match(r.audit.at(-1)!.action, /confirmed verbally/)
})

test('a verbal confirm overrides an earlier decline, and says so in the audit', () => {
  const r = route([assignee({ staffId: 'dee', declinedAt: 500, declineReason: 'car trouble' })])
  assert.equal(rollupStatus(r), 'declined')

  confirmVerbally(r, 'dee', 'got a ride')
  const a = r.assignees![0]
  assert.equal(a.declinedAt, undefined, 'the stale decline is cleared')
  assert.equal(a.declineReason, undefined)
  assert.equal(r.status, 'confirmed')
  assert.match(r.audit.at(-1)!.action, /overrides their earlier decline/)
})

test('one confirmed of two still leaves the route pending on the other', () => {
  const r = route([assignee({ staffId: 'marcus' }), assignee({ staffId: 'dee', smsSentAt: 100 })])
  confirmVerbally(r, 'marcus')
  assert.equal(r.status, 'text_sent', 'still waiting on Dee')
  confirmVerbally(r, 'dee')
  assert.equal(r.status, 'confirmed', 'whole crew in')
})

test('confirming is idempotent and unknown crew is rejected', () => {
  const r = route([assignee({ staffId: 'marcus' })])
  const first = confirmVerbally(r, 'marcus')
  assert.equal(first.ok, true)
  const at = r.assignees![0].confirmedAt

  const second = confirmVerbally(r, 'marcus', 'again')
  assert.deepEqual([second.ok, 'already' in second && second.already], [true, true])
  assert.equal(r.assignees![0].confirmedAt, at, 'the original timestamp is not moved')
  assert.equal(r.assignees![0].verbalNote, undefined, 'the second note does not overwrite')

  const nobody = confirmVerbally(r, 'ghost')
  assert.equal(nobody.ok, false)
})

test('undo removes a verbal confirm but refuses to erase a signed one', () => {
  const r = route([assignee({ staffId: 'marcus', smsSentAt: 100 })])
  confirmVerbally(r, 'marcus', 'said yes')
  assert.equal(undoVerbalConfirm(r, 'marcus').ok, true)

  const a = r.assignees![0]
  assert.equal(a.confirmedAt, undefined)
  assert.equal(a.confirmedVia, undefined)
  assert.equal(a.verbalNote, undefined)
  assert.equal(r.status, 'text_sent', 'falls back to awaiting their reply')

  // Now the contractor confirms through their own link — the owner can't undo that.
  a.confirmedAt = Date.now(); a.confirmedVia = 'link'; a.disclaimerAcceptedAt = Date.now()
  const res = undoVerbalConfirm(r, 'marcus')
  assert.equal(res.ok, false)
  assert.match(!res.ok ? res.error : '', /their own link/)
  assert.ok(a.confirmedAt, 'the signed confirmation survives')
})
