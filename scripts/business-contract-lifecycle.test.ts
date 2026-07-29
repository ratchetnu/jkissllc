import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CONTRACT_ENDABLE_ROUTE_STATUSES,
  endBusinessContract,
  isFutureContractRoute,
  reopenBusinessContract,
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
})
