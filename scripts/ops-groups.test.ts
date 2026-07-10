// Operations grouped by business — pure aggregation. No Redis.
import assert from 'node:assert/strict'
import test from 'node:test'
import { groupOpsByBusiness, needsAttention, opsBizKey, type OpsRoute } from '../app/lib/ops-groups'

const T = '2026-07-09'
const routes: OpsRoute[] = [
  // Acme: an upcoming confirmed (today = active), a pending future, a completed, a declined (attention).
  { token: 't1', routeNumber: 'R1', status: 'confirmed', businessName: 'Acme', routeDate: '2026-07-09', reportTime: '7:00 AM', assignees: [{ name: 'Marcus' }], financials: { businessPriceCents: 20000 } },
  { token: 't2', routeNumber: 'R2', status: 'text_sent', businessName: 'Acme', routeDate: '2026-07-11', reportTime: '8:00 AM', assignees: [{ name: 'Dee' }], financials: { businessPriceCents: 25000 } },
  { token: 't3', routeNumber: 'R3', status: 'completed', businessName: 'Acme', routeDate: '2026-07-01', reportTime: '7:00 AM', financials: { businessPriceCents: 20000 } },
  { token: 't4', routeNumber: 'R4', status: 'declined', businessName: 'Acme', routeDate: '2026-07-12', reportTime: '9:00 AM', financials: { businessPriceCents: 20000 } },
  // Beta: single route = one-time customer.
  { token: 't5', routeNumber: 'R5', status: 'confirmed', businessName: 'Beta', routeDate: '2026-07-15', reportTime: '10:00 AM', assignees: [{ name: 'Rashad' }], financials: { businessPriceCents: 40000 } },
]

test('groups routes by business with correct counts, value, crew, next route', () => {
  const groups = groupOpsByBusiness(routes, T)
  const acme = groups.find(g => g.businessName === 'Acme')!
  assert.equal(acme.bizKey, opsBizKey('Acme'))
  assert.equal(acme.total, 4)
  assert.equal(acme.counts.completed, 1)
  assert.equal(acme.counts.active, 1, 'today confirmed = active')
  assert.equal(acme.counts.pending, 1, 'future text_sent = pending')
  assert.equal(acme.counts.attention, 1, 'the declined route')
  // Upcoming = confirmed(today) + text_sent(future) + declined(future, still live) = 3
  assert.equal(acme.counts.upcoming, 3)
  assert.equal(acme.upcomingValueCents, 20000 + 25000 + 20000, 'sum of upcoming route prices')
  assert.deepEqual(acme.crew, ['Dee', 'Marcus'], 'distinct upcoming crew, sorted')
  assert.equal(acme.nextRoute?.token, 't1', 'soonest upcoming is today')
  assert.equal(acme.isOneTime, false)

  const beta = groups.find(g => g.businessName === 'Beta')!
  assert.equal(beta.isOneTime, true, 'single route = one-time customer')
})

test('attention sorts first', () => {
  const groups = groupOpsByBusiness(routes, T)
  assert.equal(groups[0].businessName, 'Acme', 'Acme has an attention route → first')
})

test('needsAttention flags declined and an unconfirmed past-date route', () => {
  assert.equal(needsAttention({ token: 'x', routeNumber: 'x', status: 'declined', businessName: 'B', routeDate: '2026-07-20', reportTime: '7:00 AM' }, T), true)
  assert.equal(needsAttention({ token: 'x', routeNumber: 'x', status: 'assigned', businessName: 'B', routeDate: '2026-07-01', reportTime: '7:00 AM' }, T), true)
  assert.equal(needsAttention({ token: 'x', routeNumber: 'x', status: 'completed', businessName: 'B', routeDate: '2026-07-01', reportTime: '7:00 AM' }, T), false)
})
