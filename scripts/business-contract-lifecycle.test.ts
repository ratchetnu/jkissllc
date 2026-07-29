import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CONTRACT_ENDABLE_ROUTE_STATUSES,
  DEFAULT_ROUTE_SCAN_LIMIT,
  endBusinessContract,
  isFutureContractRoute,
  reopenBusinessContract,
  routeScanFetchSize,
  type BusinessContractDeps,
  type EndContractInput,
} from '../app/lib/business-contract-lifecycle'
import type { Business } from '../app/lib/businesses'
import type { RouteRecord, RouteStatus } from '../app/lib/routes'
import type { RouteTemplate } from '../app/lib/route-templates'

const NOW = Date.parse('2026-07-29T05:00:00Z')
const TODAY = '2026-07-29'
const actor = { sub: 'owner@example.com', role: 'admin' }

const route = (token: string, status: RouteStatus, date: string, businessName = 'Best Buy Warehouse (Lancaster)'): RouteRecord => ({
  token,
  routeNumber: `JK-R-${token}`,
  status,
  businessName,
  reportAddress: '1 Warehouse Way',
  reportTime: '5:00 AM',
  routeDate: date,
  events: [],
  audit: [],
  createdAt: 1,
  updatedAt: 1,
})

const template = (id: string, active = true, businessName = 'Best Buy Warehouse (Lancaster)'): RouteTemplate => ({
  id,
  label: id,
  businessName,
  reportAddress: '1 Warehouse Way',
  reportTime: '5:00 AM',
  weekdays: [1, 3, 5],
  active,
  createdAt: 1,
  updatedAt: 1,
})

function fixture(options: { failToken?: string; business?: Business | null } = {}) {
  let business = options.business === undefined ? {
    key: 'best buy warehouse (lancaster)',
    name: 'Best Buy Warehouse (Lancaster)',
    contractRateCents: 72500,
    pricingActive: true,
    rateHistory: [{ at: 1, contractRateCents: 72500, active: true }],
    createdAt: 1,
    updatedAt: 1,
  } satisfies Business : options.business
  const routes = [
    route('future-draft', 'draft', TODAY),
    route('future-assigned', 'assigned', '2026-07-30'),
    route('future-confirmed', 'confirmed', '2026-08-01'),
    route('past-assigned', 'assigned', '2026-07-28'),
    route('future-completed', 'completed', '2026-07-30'),
    route('other-business', 'assigned', '2026-07-30', 'JW Logistics'),
  ]
  const templates = [
    template('active'),
    template('already-paused', false),
    template('other', true, 'JW Logistics'),
  ]
  const savedBusinesses: Business[] = []
  const cancelled: string[] = []
  const deps: BusinessContractDeps = {
    getBusiness: async () => business,
    saveBusiness: async b => { business = structuredClone(b); savedBusinesses.push(structuredClone(b)) },
    listRoutes: async () => routes,
    listTemplates: async () => templates,
    saveTemplate: async changed => {
      const found = templates.find(t => t.id === changed.id)!
      Object.assign(found, changed)
    },
    cancelRoute: async token => {
      if (token === options.failToken) throw new Error('busy')
      const found = routes.find(r => r.token === token)!
      if (!isFutureContractRoute(found, 'best buy warehouse (lancaster)', TODAY)) return 'skipped'
      found.status = 'cancelled'
      cancelled.push(token)
      return 'cancelled'
    },
  }
  return { deps, routes, templates, get business() { return business }, savedBusinesses, cancelled }
}

const input = (overrides: Partial<EndContractInput> = {}): EndContractInput => ({
  businessKey: 'best buy warehouse (lancaster)',
  businessName: 'Best Buy Warehouse (Lancaster)',
  reason: 'Contract expired',
  now: NOW,
  today: TODAY,
  actor,
  ...overrides,
})

test('the endable status set includes every live assignment state but no settled state', () => {
  assert.deepEqual([...CONTRACT_ENDABLE_ROUTE_STATUSES].sort(), [
    'assigned', 'confirmed', 'declined', 'draft', 'no_response', 'text_sent',
  ])
  for (const status of ['completed', 'cancelled', 'no_show'] as RouteStatus[]) {
    assert.equal(CONTRACT_ENDABLE_ROUTE_STATUSES.has(status), false)
  }
})

test('ending a contract pauses schedules, cancels only future matching work, and archives without deleting history', async () => {
  const f = fixture()
  const result = await endBusinessContract(input(), f.deps)

  assert.equal(result.ok, true)
  assert.equal(result.cancelledRouteCount, 3)
  assert.equal(result.pausedTemplateCount, 1)
  assert.deepEqual(f.cancelled.sort(), ['future-assigned', 'future-confirmed', 'future-draft'])
  assert.equal(f.routes.find(r => r.token === 'past-assigned')?.status, 'assigned', 'past work is historical and untouched')
  assert.equal(f.routes.find(r => r.token === 'future-completed')?.status, 'completed', 'completed work is immutable history')
  assert.equal(f.routes.find(r => r.token === 'other-business')?.status, 'assigned', 'another client is isolated')
  assert.equal(f.templates.find(t => t.id === 'active')?.active, false)
  assert.equal(f.templates.find(t => t.id === 'other')?.active, true)

  assert.equal(f.business?.contractEndedAt, NOW)
  assert.equal(f.business?.contractEndReason, 'Contract expired')
  assert.equal(f.business?.pricingActive, false)
  assert.equal(f.business?.contractRateCents, 72500, 'the historical contract rate remains recorded')
  assert.equal(f.business?.rateHistory?.at(-1)?.active, false)
  assert.deepEqual(f.business?.contractHistory?.at(-1), {
    at: NOW,
    action: 'ended',
    actorId: actor.sub,
    actorRole: actor.role,
    reason: 'Contract expired',
    cancelledRouteCount: 3,
    pausedTemplateCount: 1,
  })
})

test('a route cancellation failure prevents the client from being hidden and leaves a safe retry path', async () => {
  const f = fixture({ failToken: 'future-assigned' })
  const result = await endBusinessContract(input(), f.deps)

  assert.equal(result.ok, false)
  assert.deepEqual(result.failedRoutes, ['JK-R-future-assigned'])
  assert.equal(f.savedBusinesses.length, 0, 'the client is not falsely presented as fully ended')
  assert.equal(f.templates.find(t => t.id === 'active')?.active, false, 'generation stops before route cancellation begins')
  assert.equal(f.routes.find(r => r.token === 'future-draft')?.status, 'cancelled')
  assert.equal(f.routes.find(r => r.token === 'future-assigned')?.status, 'assigned')
})

test('an incomplete route scan refuses to archive instead of silently claiming all work was cancelled', async () => {
  const f = fixture()
  const result = await endBusinessContract(input({ routeScanLimit: 2 }), f.deps)

  assert.equal(result.ok, false)
  assert.match(result.incompleteReason ?? '', /completeness cannot be proven/)
  assert.equal(f.savedBusinesses.length, 0)
  assert.equal(f.cancelled.length, 0, 'no partial route cancellation begins from an incomplete inventory')
})

test('a recurring-schedule store failure is a structured retryable refusal, not an unhandled error', async () => {
  const f = fixture()
  f.deps.saveTemplate = async changed => {
    if (changed.id === 'active') throw new Error('store unavailable')
  }

  const result = await endBusinessContract(input(), f.deps)
  assert.equal(result.ok, false)
  assert.deepEqual(result.failedTemplates, ['active'])
  assert.equal(f.cancelled.length, 0, 'routes remain untouched until every schedule is safely paused')
  assert.equal(f.savedBusinesses.length, 0)
})

test('a malformed legacy route with no business name cannot crash the sweep', async () => {
  const f = fixture()
  f.routes.push({ ...route('legacy', 'assigned', '2026-07-30'), businessName: undefined } as unknown as RouteRecord)
  await assert.doesNotReject(() => endBusinessContract(input(), f.deps))
  assert.equal(f.routes.find(r => r.token === 'legacy')?.status, 'assigned')
})

test('a second sweep catches a future route created by an already in-flight generator', async () => {
  const f = fixture()
  const originalList = f.deps.listRoutes
  let reads = 0
  f.deps.listRoutes = async () => {
    reads++
    if (reads === 2) f.routes.push(route('late-generated', 'draft', '2026-08-02'))
    return originalList()
  }

  const result = await endBusinessContract(input(), f.deps)
  assert.equal(result.ok, true)
  assert.equal(f.routes.find(r => r.token === 'late-generated')?.status, 'cancelled')
  assert.equal(result.cancelledRouteCount, 4)
})

test('repeating end is idempotent and does not duplicate lifecycle or rate history', async () => {
  const f = fixture()
  await endBusinessContract(input(), f.deps)
  const historyLength = f.business?.rateHistory?.length
  const contractHistoryLength = f.business?.contractHistory?.length

  const second = await endBusinessContract(input({ now: NOW + 1000 }), f.deps)
  assert.equal(second.ok, true)
  assert.equal(second.cancelledRouteCount, 0)
  assert.equal(second.pausedTemplateCount, 0)
  assert.equal(f.business?.rateHistory?.length, historyLength)
  assert.equal(f.business?.contractHistory?.length, contractHistoryLength)
  assert.equal(f.business?.contractEndedAt, NOW)
})

test('a route-only client can be ended by creating a minimal archival business record', async () => {
  const f = fixture({ business: null })
  const result = await endBusinessContract(input({ businessName: 'Best Buy Warehouse (Lancaster)' }), f.deps)
  assert.equal(result.ok, true)
  assert.equal(f.business?.key, 'best buy warehouse (lancaster)')
  assert.equal(f.business?.name, 'Best Buy Warehouse (Lancaster)')
  assert.equal(f.business?.contractEndedAt, NOW)
})

test('reopening restores prior pricing state but never revives routes or templates', async () => {
  const f = fixture()
  await endBusinessContract(input(), f.deps)
  const ended = structuredClone(f.business!)
  const routeStates = f.routes.map(r => r.status)
  const templateStates = f.templates.map(t => t.active)

  const reopened = await reopenBusinessContract(ended, actor, NOW + 5000, f.deps.saveBusiness)
  assert.equal(reopened.contractEndedAt, undefined)
  assert.equal(reopened.pricingActive, true)
  assert.equal(reopened.contractHistory?.at(-1)?.action, 'reopened')
  assert.deepEqual(f.routes.map(r => r.status), routeStates)
  assert.deepEqual(f.templates.map(t => t.active), templateStates)
})

test('API requires all three mutation permissions and the UI exposes end/restore with explicit history-preservation copy', () => {
  const api = readFileSync('app/api/admin/businesses/route.ts', 'utf8')
  const detail = readFileSync('app/admin/operations/business/[key]/page.tsx', 'utf8')
  const list = readFileSync('app/admin/operations/list/page.tsx', 'utf8')
  for (const permission of ['businesses:manage', 'routes:manage', 'recurring:manage']) {
    assert.match(api, new RegExp(`requirePermission\\(req, '${permission}'\\)`))
  }
  assert.match(detail, /End contract/)
  assert.match(detail, /Restore client/)
  assert.match(detail, /Completed work, invoices, pay, and claims will stay in history/)
  assert.match(list, /Show ended contracts/)
  assert.match(list, /showEnded \|\| !endedKeys\.has\(g\.bizKey\)/)
  // The caller no longer restates the limit or the fetch size as literals — the limit
  // is the service's fail-closed default and the fetch size is derived from it, so the
  // two can no longer drift apart. Pinned by "the fetch size is one beyond the limit".
  assert.match(api, /listRoutes\(routeScanFetchSize\(\)\)/)
})


// ── Follow-ups from the #126 delta review ────────────────────────────────────
//
// Two defects the earlier fixes left behind: an over-limit refusal still paused every
// recurring schedule first (a permanently half-applied state no retry could finish),
// and the scan limit defaulted to Number.MAX_SAFE_INTEGER, so a caller that forgot to
// pass it silently lost the guarantee entirely.

/** A fixture whose route list is exactly `total` records, none of them matching the
 *  business under test — so any refusal is attributable to the count, not the work. */
function bulkFixture(total: number) {
  const routes = Array.from({ length: total }, (_, i) => route(`bulk-${i}`, 'assigned', '2026-08-01', 'JW Logistics'))
  const pausedTemplates: string[] = []
  const savedBusinesses: Business[] = []
  const cancelled: string[] = []
  const deps: BusinessContractDeps = {
    getBusiness: async () => null,
    saveBusiness: async b => { savedBusinesses.push(structuredClone(b)) },
    listRoutes: async () => routes,
    listTemplates: async () => [template('active'), template('second')],
    saveTemplate: async t => { pausedTemplates.push(t.id) },
    cancelRoute: async token => { cancelled.push(token); return 'cancelled' },
  }
  return { deps, pausedTemplates, savedBusinesses, cancelled }
}

test('an over-limit refusal is completely side-effect-free: no template paused, no route cancelled, no archive', async () => {
  const f = bulkFixture(DEFAULT_ROUTE_SCAN_LIMIT + 1)
  const result = await endBusinessContract(input(), f.deps)

  assert.equal(result.ok, false)
  assert.match(result.incompleteReason ?? '', /completeness cannot be proven/)
  // The point of the reorder: nothing was written before we knew we could finish.
  assert.deepEqual(f.pausedTemplates, [], 'recurring schedules must NOT be paused when we cannot finish')
  assert.equal(result.pausedTemplateCount, 0)
  assert.deepEqual(f.cancelled, [], 'no route may be cancelled')
  assert.equal(result.cancelledRouteCount, 0)
  assert.deepEqual(f.savedBusinesses, [], 'the business must not be archived')
})

test('the scan limit is enforced even when the caller omits routeScanLimit (fail closed)', async () => {
  const f = bulkFixture(DEFAULT_ROUTE_SCAN_LIMIT + 1)
  // input() deliberately does NOT set routeScanLimit — the old default was
  // Number.MAX_SAFE_INTEGER and this archived 2,001 routes' worth of work happily.
  const result = await endBusinessContract(input(), f.deps)
  assert.equal(result.ok, false)
  assert.match(result.incompleteReason ?? '', /More than 2,000 operations exist/)
  assert.deepEqual(f.savedBusinesses, [])
})

test('exactly the limit is provably complete and still archives', async () => {
  const f = bulkFixture(DEFAULT_ROUTE_SCAN_LIMIT)
  const result = await endBusinessContract(input(), f.deps)
  assert.equal(result.ok, true, 'seeing exactly the limit means we saw everything')
  assert.equal(result.incompleteReason, undefined)
  assert.equal(f.savedBusinesses.length, 1)
  assert.deepEqual(f.pausedTemplates, ['active', 'second'], 'schedules pause on the success path')
})

test('the fetch size is one beyond the limit, from a single source of truth', () => {
  // The limit and the fetch size used to be separate magic numbers in separate files
  // (2000 here, 2001 in the route); changing one alone disabled the guard silently.
  assert.equal(routeScanFetchSize(), DEFAULT_ROUTE_SCAN_LIMIT + 1)
  assert.equal(routeScanFetchSize(10), 11)
  const routeSrc = readFileSync('app/api/admin/businesses/route.ts', 'utf8')
  assert.match(routeSrc, /listRoutes\(routeScanFetchSize\(\)\)/, 'the caller derives its fetch size, never hardcodes it')
  assert.ok(!/listRoutes\(2001\)/.test(routeSrc), 'no hardcoded 2001 may reappear')
  assert.ok(!/routeScanLimit:\s*2000/.test(routeSrc), 'the limit comes from the fail-closed default, not a literal')
})

test('the completeness check runs BEFORE schedules are paused', async () => {
  // Ordering, asserted by observation rather than by reading: the first write of any
  // kind must not happen until the count has been proven.
  const order: string[] = []
  const routes = Array.from({ length: DEFAULT_ROUTE_SCAN_LIMIT + 1 }, (_, i) =>
    route(`bulk-${i}`, 'assigned', '2026-08-01', 'JW Logistics'))
  const deps: BusinessContractDeps = {
    getBusiness: async () => null,
    saveBusiness: async () => { order.push('saveBusiness') },
    listRoutes: async () => { order.push('listRoutes'); return routes },
    listTemplates: async () => [template('active')],
    saveTemplate: async () => { order.push('saveTemplate') },
    cancelRoute: async () => { order.push('cancelRoute'); return 'cancelled' },
  }
  const result = await endBusinessContract(input(), deps)
  assert.equal(result.ok, false)
  assert.deepEqual(order, ['listRoutes'], 'the scan happened, and then nothing else did')
})

test('the reorder did not break pause-before-sweep on the success path', async () => {
  // The original ordering guarantee still has to hold: schedules must stop before the
  // working set is read, or a generator can add a route mid-sweep.
  const order: string[] = []
  const f = fixture()
  const deps: BusinessContractDeps = {
    ...f.deps,
    listRoutes: async () => { order.push('listRoutes'); return f.routes },
    saveTemplate: async t => { order.push('saveTemplate'); await f.deps.saveTemplate(t) },
  }
  await endBusinessContract(input(), deps)
  const firstSave = order.indexOf('saveTemplate')
  const sweepRead = order.indexOf('listRoutes', firstSave)
  assert.equal(order[0], 'listRoutes', 'preflight count comes first')
  assert.ok(firstSave > 0, 'schedules are paused')
  assert.ok(sweepRead > firstSave, 'the working set is re-read only AFTER schedules are paused')
})

test('retry after a template failure remains idempotent and never archives', async () => {
  const f = fixture()
  let failNext = true
  const deps: BusinessContractDeps = {
    ...f.deps,
    saveTemplate: async t => {
      if (failNext && t.id === 'active') { failNext = false; throw new Error('store down') }
      await f.deps.saveTemplate(t)
    },
  }
  const first = await endBusinessContract(input(), deps)
  assert.equal(first.ok, false)
  assert.deepEqual(first.failedTemplates, ['active'])
  assert.equal(f.savedBusinesses.length, 0, 'no archive on the failed attempt')

  const second = await endBusinessContract(input(), deps)
  assert.equal(second.ok, true, 'the retry completes')
  assert.equal(f.savedBusinesses.length, 1, 'archived exactly once')
  assert.equal(f.savedBusinesses[0].contractHistory?.length, 1, 'one lifecycle event, not two')
})
