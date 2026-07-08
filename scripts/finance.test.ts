// Money math for J KISS route pricing/payout. Pure functions only — no Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseMoneyCents, resolveBusinessPrice, resolveCrewPay, computeRouteMoney,
  payExceedsPrice, snapshotCrewPay, snapshotBusinessPrice, snapshotManualPrice,
  isFrozen, computeFinance,
} from '../app/lib/finance'
import { toPublicRouteFor } from '../app/lib/routes'
import type { RouteRecord, Assignee } from '../app/lib/routes'
import type { Business } from '../app/lib/businesses'
import type { Staff } from '../app/lib/staff'

// ── helpers ──────────────────────────────────────────────────────────────────
const assignee = (o: Partial<Assignee> & { staffId: string }): Assignee =>
  ({ name: o.staffId, token: 't_' + o.staffId, ...o }) as Assignee

const route = (o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: 'r1', routeNumber: 'JK-R-1001', status: 'assigned',
  businessName: 'Amazon DSP', reportAddress: '1 Commerce St', reportTime: '7:00 AM',
  routeDate: '2026-07-09', events: [], audit: [], createdAt: 1, updatedAt: 1,
  ...o,
}) as RouteRecord

const biz = (o: Partial<Business> = {}): Business =>
  ({ key: 'amazon dsp', name: 'Amazon DSP', createdAt: 1, updatedAt: 1, ...o }) as Business

const staff = (o: Partial<Staff> & { id: string }): Staff =>
  ({ name: o.id, active: true, createdAt: 1, updatedAt: 1, ...o }) as Staff

// ── parseMoneyCents ──────────────────────────────────────────────────────────
test('parseMoneyCents accepts plain, $-prefixed, and comma-grouped dollars', () => {
  assert.equal(parseMoneyCents('175'), 17500)
  assert.equal(parseMoneyCents('$350'), 35000)
  assert.equal(parseMoneyCents('$1,250.00'), 125000)
  assert.equal(parseMoneyCents('175.5'), 17550)
  assert.equal(parseMoneyCents('0'), 0)
  assert.equal(parseMoneyCents(175), 17500)
})

test('parseMoneyCents rejects negatives, blanks, and free text', () => {
  assert.equal(parseMoneyCents('-5'), null, 'negative string')
  assert.equal(parseMoneyCents(-1), null, 'negative number')
  assert.equal(parseMoneyCents('$-5'), null, 'negative after $')
  assert.equal(parseMoneyCents(''), null, 'blank')
  assert.equal(parseMoneyCents('   '), null, 'whitespace')
  assert.equal(parseMoneyCents(undefined), null)
  assert.equal(parseMoneyCents(null), null)
  assert.equal(parseMoneyCents('abc'), null)
  // The legacy free-text format must NOT silently parse — it would hide a typo.
  assert.equal(parseMoneyCents('175/route'), null, '"175/route" is not a clean amount')
  assert.equal(parseMoneyCents('175.555'), null, 'sub-cent precision')
  assert.equal(parseMoneyCents(Number.NaN), null)
  assert.equal(parseMoneyCents(Infinity), null)
})

// ── resolution ───────────────────────────────────────────────────────────────
test('resolveBusinessPrice honours the active flag', () => {
  assert.equal(resolveBusinessPrice(biz({ contractRateCents: 35000 })), 35000)
  assert.equal(resolveBusinessPrice(biz({ contractRateCents: 35000, pricingActive: true })), 35000)
  assert.equal(resolveBusinessPrice(biz({ contractRateCents: 35000, pricingActive: false })), null, 'inactive pricing yields no price')
  assert.equal(resolveBusinessPrice(biz()), null, 'no rate on file')
  assert.equal(resolveBusinessPrice(null), null)
  assert.equal(resolveBusinessPrice(biz({ contractRateCents: 0 })), 0, 'a $0 contract is a real price, not "unset"')
})

test('resolveCrewPay prefers a per-business override over the default', () => {
  const s = staff({ id: 'a', defaultPayCents: 17500, payByBusiness: { 'amazon dsp': 20000 } })
  assert.deepEqual(resolveCrewPay(s, 'Amazon DSP'), { cents: 20000, source: 'crew_business' })
  assert.deepEqual(resolveCrewPay(s, 'AMAZON   DSP'), { cents: 20000, source: 'crew_business' }, 'bizKey normalizes case + spacing')
  assert.deepEqual(resolveCrewPay(s, 'Sysco'), { cents: 17500, source: 'crew_default' }, 'falls back to default')
  assert.equal(resolveCrewPay(staff({ id: 'b' }), 'Sysco'), null, 'no rate anywhere')
  assert.equal(resolveCrewPay(staff({ id: 'c', defaultPayCents: 17500, payActive: false }), 'Sysco'), null, 'inactive pay yields nothing')
})

// ── per-route math ───────────────────────────────────────────────────────────
test('profit = price - crew pay, and a decliner costs nothing', () => {
  const r = route({
    financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 },
    assignees: [
      assignee({ staffId: 'driver', payCents: 17500 }),
      assignee({ staffId: 'helper', payCents: 10000 }),
      assignee({ staffId: 'quitter', payCents: 15000, declinedAt: 2 }),
    ],
  })
  const m = computeRouteMoney(r)
  assert.equal(m.revenueCents, 35000)
  assert.equal(m.payoutCents, 27500, 'declined crew are not paid')
  assert.equal(m.profitCents, 7500)
  assert.equal(m.unpricedCrew, 0)
})

test('unpriced crew are flagged, not counted as $0', () => {
  const r = route({
    financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 },
    assignees: [assignee({ staffId: 'a', payCents: 17500 }), assignee({ staffId: 'b' })],
  })
  const m = computeRouteMoney(r)
  assert.equal(m.unpricedCrew, 1)
  assert.equal(m.payoutCents, 17500)
  assert.equal(m.profitCents, 17500, 'profit is optimistic until the missing rate is filled in')
})

test('a route with no contract price reports unknown revenue, not zero', () => {
  const r = route({ assignees: [assignee({ staffId: 'a', payCents: 17500 })] })
  const m = computeRouteMoney(r)
  assert.equal(m.revenueCents, null)
  assert.equal(m.profitCents, null, 'never claim a -$175 loss just because the price is missing')
  assert.equal(m.payoutCents, 17500)
})

test('payExceedsPrice only warns when the price is actually known', () => {
  assert.equal(payExceedsPrice(35000, 40000), true)
  assert.equal(payExceedsPrice(35000, 35000), false, 'break-even is not a warning')
  assert.equal(payExceedsPrice(null, 40000), false, 'unknown price cannot be exceeded')
})

// ── snapshots ────────────────────────────────────────────────────────────────
test('snapshotCrewPay: manual wins, and keeps the legacy free-text field in sync', () => {
  const s = staff({ id: 'a', defaultPayCents: 17500 })
  const a = assignee({ staffId: 'a' })
  snapshotCrewPay(a, s, 'Amazon DSP', 20000)
  assert.equal(a.payCents, 20000)
  assert.equal(a.paySource, 'manual')
  assert.equal(a.pay, '$200.00', 'route-pay.ts parses this string, so it must stay valid')

  const b = assignee({ staffId: 'a' })
  snapshotCrewPay(b, s, 'Amazon DSP')
  assert.equal(b.payCents, 17500)
  assert.equal(b.paySource, 'crew_default')
})

test('snapshotCrewPay leaves pay unset when no rate exists anywhere', () => {
  const a = assignee({ staffId: 'a' })
  snapshotCrewPay(a, staff({ id: 'a' }), 'Amazon DSP')
  assert.equal(a.payCents, undefined)
  assert.equal(a.pay, undefined)
})

test('snapshotBusinessPrice records WHY there is no price', () => {
  const r1 = route(); snapshotBusinessPrice(r1, biz({ contractRateCents: 35000 }))
  assert.equal(r1.financials?.businessPriceCents, 35000)
  assert.equal(r1.financials?.priceSource, 'contract')

  const r2 = route(); snapshotBusinessPrice(r2, null)
  assert.equal(r2.financials?.businessPriceCents, undefined)
  assert.equal(r2.financials?.priceSource, 'none')

  const r3 = route(); snapshotManualPrice(r3, 41000)
  assert.equal(r3.financials?.priceSource, 'manual')
})

test('completed and cancelled routes are frozen; live ones are not', () => {
  assert.equal(isFrozen(route({ status: 'completed' })), true)
  assert.equal(isFrozen(route({ status: 'cancelled' })), true)
  assert.equal(isFrozen(route({ status: 'confirmed' })), false)
  assert.equal(isFrozen(route({ status: 'no_show' })), false, 'a no-show still owes the crew nothing but is not settled history')
})

test('editing a rate does not mutate a route already snapshotted', () => {
  const r = route({ financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 } })
  const before = { ...r.financials }
  // The business record changes...
  const changed = biz({ contractRateCents: 50000 })
  // ...but nothing re-reads it for this route unless snapshotBusinessPrice is called.
  assert.deepEqual({ ...r.financials }, before)
  assert.equal(resolveBusinessPrice(changed), 50000, 'the new rate is what a FUTURE route would snapshot')
})

// ── public projection: the leak test ─────────────────────────────────────────
test('PublicRoute never carries financials, and pay is gated', () => {
  const a = assignee({ staffId: 'a', pay: '$175.00', payCents: 17500 })
  const other = assignee({ staffId: 'b', pay: '$999.00', payCents: 99900 })
  const r = route({
    payRate: '$350.00',   // legacy route-level rate — must not reach the driver
    financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 },
    assignees: [a, other],
  })

  const shown = toPublicRouteFor(r, a, { showPay: true })
  assert.equal(shown.payRate, '$175.00', 'the crew member sees their OWN pay')
  assert.equal('financials' in shown, false, 'the client price must not be projected')
  assert.equal(JSON.stringify(shown).includes('999'), false, "another crew member's pay must not leak")
  assert.equal(JSON.stringify(shown).includes('35000'), false, 'the contract price must not leak')

  const hidden = toPublicRouteFor(r, a, { showPay: false })
  assert.equal(hidden.payRate, undefined, 'pay is omitted when the toggle is off')
  const defaulted = toPublicRouteFor(r, a)
  assert.equal(defaulted.payRate, undefined, 'omitting opts fails closed')
})

// ── dashboard ────────────────────────────────────────────────────────────────
test('computeFinance totals revenue, payouts by bucket, and profit', () => {
  const routes = [
    route({
      token: 'r1', routeNumber: 'JK-R-1', routeDate: '2026-07-01', status: 'completed', businessName: 'Amazon DSP',
      financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 },
      assignees: [assignee({ staffId: 'd1', role: 'Driver', payCents: 17500 }), assignee({ staffId: 'h1', role: 'Helper', payCents: 10000 })],
    }),
    route({
      token: 'r2', routeNumber: 'JK-R-2', routeDate: '2026-07-02', status: 'completed', businessName: 'Sysco',
      financials: { businessPriceCents: 42000, priceSource: 'contract', snapshotAt: 1 },
      assignees: [assignee({ staffId: 'd1', role: 'Driver', payCents: 20000 })],
    }),
    // Cancelled — must be invisible to every total.
    route({
      token: 'r3', routeNumber: 'JK-R-3', routeDate: '2026-07-03', status: 'cancelled', businessName: 'Amazon DSP',
      financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 },
      assignees: [assignee({ staffId: 'd1', role: 'Driver', payCents: 17500 })],
    }),
  ]
  const crew = [staff({ id: 'd1', payKind: 'driver' }), staff({ id: 'h1', payKind: 'helper' })]

  const all = computeFinance(routes, crew)
  assert.equal(all.routeCount, 2, 'cancelled route excluded')
  assert.equal(all.revenueCents, 77000)
  assert.equal(all.payoutCents, 47500)
  assert.equal(all.profitCents, 29500)
  assert.equal(all.driverPayoutCents, 37500)
  assert.equal(all.helperPayoutCents, 10000)
  assert.equal(all.otherPayoutCents, 0)

  const amazon = computeFinance(routes, crew, { business: 'amazon dsp' })
  assert.equal(amazon.routeCount, 1)
  assert.equal(amazon.profitCents, 7500)

  const windowed = computeFinance(routes, crew, { start: '2026-07-02', end: '2026-07-02' })
  assert.equal(windowed.routeCount, 1)
  assert.equal(windowed.revenueCents, 42000)

  const byDriver = computeFinance(routes, crew, { staffId: 'h1' })
  assert.equal(byDriver.routeCount, 1, 'only routes this person is on')

  const crewSheet = all.byCrew.find(g => g.key === 'd1')!
  assert.equal(crewSheet.payoutCents, 37500)
  assert.equal(crewSheet.revenueCents, 0, 'a person owns no share of revenue')
})

test('computeFinance can filter to a single status, including cancelled', () => {
  const routes = [
    route({ token: 'a', status: 'completed', financials: { businessPriceCents: 100, priceSource: 'contract', snapshotAt: 1 } }),
    route({ token: 'b', status: 'confirmed', financials: { businessPriceCents: 200, priceSource: 'contract', snapshotAt: 1 } }),
    route({ token: 'c', status: 'cancelled', financials: { businessPriceCents: 400, priceSource: 'contract', snapshotAt: 1 } }),
  ]
  assert.equal(computeFinance(routes, [], { status: 'completed' }).revenueCents, 100)
  assert.equal(computeFinance(routes, [], { status: 'confirmed' }).revenueCents, 200)
  assert.equal(computeFinance(routes, [], { status: 'cancelled' }).revenueCents, 400, 'explicitly asked for → shown')
  assert.equal(computeFinance(routes, [], {}).revenueCents, 300, 'default excludes cancelled')
})

test('unpriced routes are counted so the dashboard can admit what it does not know', () => {
  const routes = [
    route({ token: 'a', status: 'completed', assignees: [assignee({ staffId: 'x', payCents: 17500 })] }),
    route({ token: 'b', status: 'completed', financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 }, assignees: [assignee({ staffId: 'y' })] }),
  ]
  const s = computeFinance(routes, [])
  assert.equal(s.unpricedRoutes, 1)
  assert.equal(s.unpricedCrewRoutes, 1)
  assert.equal(s.revenueCents, 35000, 'the priced route still contributes')
})

// ── Regression: the assignment SMS is a leak surface too ─────────────────────
test('assignmentSms carries only this crew member\'s pay, and only when enabled', async () => {
  const { assignmentSms } = await import('../app/lib/route-notify')
  const a = assignee({ staffId: 'a', name: 'Marcus', pay: '$175.00', payCents: 17500 })
  const other = assignee({ staffId: 'b', name: 'Dee', pay: '$999.00', payCents: 99900 })
  const r = route({
    payRate: '$350.00',
    financials: { businessPriceCents: 35000, priceSource: 'contract', snapshotAt: 1 },
    assignees: [a, other],
  })

  const on = assignmentSms(r, a, { showPay: true })
  assert.ok(on.includes('Your pay: $175.00'), 'their own pay appears when enabled')
  assert.equal(on.includes('999'), false, "another crew member's pay must not appear")
  assert.equal(on.includes('350'), false, 'the contract price must not appear')

  const off = assignmentSms(r, a, { showPay: false })
  assert.equal(off.includes('175'), false, 'pay omitted when disabled')
  assert.equal(off.includes('Your pay'), false)

  const dflt = assignmentSms(r, a)
  assert.equal(dflt.includes('Your pay'), false, 'omitting opts fails closed')
})
