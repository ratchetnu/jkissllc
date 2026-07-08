// End-to-end through the REAL data layer: claim → weekly accrual → pay statement.
// Unit tests cover the money math; this proves the pieces are actually wired to
// each other (Redis keys, indexes, normalize(), and the accrual → payroll handoff).
//
// Upstash is spoken over its REST API, so we stand up an in-memory Redis by
// stubbing global fetch. No network, no real data.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

// ── in-memory Upstash ────────────────────────────────────────────────────────
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const [cmd, ...args] = JSON.parse(init.body) as string[]
  const key = args[0]
  let result: unknown = null

  switch (cmd.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const sorted = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
      if (cmd.toUpperCase() === 'ZREVRANGE') sorted.reverse()
      const start = Number(args[1])
      const stop = Number(args[2])
      result = sorted.slice(start, stop === -1 ? undefined : stop + 1)
      break
    }
    case 'PEXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return { json: async () => ({ result }) }
}) as unknown as typeof fetch

// Static imports are safe here: lib/redis reads both the env vars and global fetch
// lazily, inside call() — never at module load — so the stub above is already in
// place by the time any Redis command runs.
import {
  saveClaim, getClaim, listClaims, generateClaimId, nextClaimNumber, setResponsibility,
  startDeduction, remainingCents, recoveredCents, snapshotFromRoute, type ClaimRecord,
} from '../app/lib/claims'
import { accrueAllClaims } from '../app/lib/claim-accrual'
import { computePay } from '../app/lib/route-pay'
import { saveRoute, generateToken, listRoutes, type RouteRecord, type Assignee } from '../app/lib/routes'
import { saveStaff } from '../app/lib/staff'
import { addDaysStr } from '../app/lib/dates'

const MON = '2026-07-06'                                  // Monday
const SUN = addDaysStr(MON, 6)
const NEXT_TUE = Date.UTC(2026, 6, 14, 18, 0, 0)          // the week is over

async function seed() {
  kv.clear(); zsets.clear()

  await saveStaff({ id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })

  const route: RouteRecord = {
    token: generateToken(), routeNumber: 'JK-R-2001', status: 'completed',
    businessName: 'Amazon DSP', reportAddress: '1 Commerce St', reportTime: '7:00 AM',
    routeDate: '2026-07-08', events: [], audit: [], createdAt: 1, updatedAt: 1,
    financials: { businessPriceCents: 45000, priceSource: 'contract', snapshotAt: 1 },
    assignees: [{ staffId: 'marcus', name: 'Marcus', role: 'Driver', token: generateToken(), payCents: 17500, pay: '$175.00' } as Assignee],
  } as RouteRecord
  await saveRoute(route)

  const claim: ClaimRecord = {
    id: generateClaimId(), claimNumber: await nextClaimNumber(), status: 'approved', claimType: 'property_damage',
    businessKey: 'amazon dsp', businessName: 'Amazon DSP',
    routeToken: route.token, routeNumber: route.routeNumber,
    claimDate: '2026-07-08', reportedDate: '2026-07-08',
    description: 'Backed into a bollard', totalCents: 80000,
    attachments: [], assignments: [], audit: [],
    snapshot: snapshotFromRoute(route, null),
    createdAt: Date.now(), updatedAt: Date.now(),
  }
  setResponsibility(claim, [{ staffId: 'marcus', name: 'Marcus' }], 'dollar', [{ staffId: 'marcus', value: 50000 }])
  startDeduction(claim, 'marcus', { weeklyCents: 5000, startDate: MON })
  await saveClaim(claim)
  return { claim, route }
}

test('a claim round-trips through Redis with its ledger and snapshot intact', async () => {
  const { claim, route } = await seed()

  const read = await getClaim(claim.id)
  assert.ok(read, 'claim is retrievable by id')
  assert.equal(read!.claimNumber, claim.claimNumber)
  assert.equal(read!.assignments[0].staffId, 'marcus')
  assert.equal(read!.snapshot.routeNumber, route.routeNumber)
  assert.equal(read!.snapshot.businessPriceCents, 45000)
  assert.equal(read!.snapshot.routeProfitCents, 27500)

  const all = await listClaims()
  assert.equal(all.length, 1, 'the claim is in the index')
  assert.equal(all[0].id, claim.id)
})

test('claim numbers increment', async () => {
  await seed()
  const a = await nextClaimNumber()
  const b = await nextClaimNumber()
  assert.notEqual(a, b)
  assert.match(a, /^JK-C-\d+$/)
})

// The whole point of the module: a deduction posted by the cron shows up on the
// pay statement, reduces net pay, and names the claim it came from.
test('cron accrual → pay statement: deduction is taken, net pay drops, claim is named', async () => {
  const { claim } = await seed()

  const before = await computePay(MON, SUN)
  const m0 = before.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m0.grossCents, 17500, 'earned $175 for the completed route')
  assert.equal(m0.netCents, 17500, 'nothing deducted yet')
  assert.equal(before.grandDeductionCents, 0)

  const accrual = await accrueAllClaims(NEXT_TUE)
  assert.equal(accrual.posted.length, 1, 'one weekly deduction posted')
  assert.equal(accrual.posted[0].amountCents, 5000)
  assert.equal(accrual.posted[0].periodDate, MON)

  const after = await computePay(MON, SUN)
  const m1 = after.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m1.grossCents, 17500, 'gross is untouched')
  assert.equal(m1.deductionCents, 5000)
  assert.equal(m1.appliedCents, 5000)
  assert.equal(m1.netCents, 12500, '$175 − $50')
  assert.equal(m1.shortfallCents, 0)
  assert.equal(after.grandNetCents, 12500)

  const line = m1.deductions[0]
  assert.equal(line.claimNumber, claim.claimNumber, 'the statement names the claim')
  assert.equal(line.businessName, 'Amazon DSP')
  assert.equal(line.routeNumber, 'JK-R-2001')
  assert.equal(line.amountCents, 5000)
  assert.equal(line.date, MON)

  const persisted = await getClaim(claim.id)
  assert.equal(recoveredCents(persisted!.assignments[0]), 5000, 'the ledger was saved')
  assert.equal(remainingCents(persisted!.assignments[0]), 45000)
})

test('running the cron twice does not double-deduct', async () => {
  const { claim } = await seed()

  await accrueAllClaims(NEXT_TUE)
  const second = await accrueAllClaims(NEXT_TUE)
  assert.equal(second.posted.length, 0, 'the week is already posted')

  const persisted = await getClaim(claim.id)
  assert.equal(recoveredCents(persisted!.assignments[0]), 5000, 'still only one deduction')

  const pay = await computePay(MON, SUN)
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.netCents, 12500)
})

test('the cron will not deduct against a pay week that is still running', async () => {
  const { claim } = await seed()
  // Wednesday of the deduction's own week.
  const r = await accrueAllClaims(Date.UTC(2026, 6, 8, 18, 0, 0))
  assert.deepEqual(r.posted, [])
  assert.equal(recoveredCents((await getClaim(claim.id))!.assignments[0]), 0)
})

test('a contractor who earned nothing that week is not deducted, and owes the same', async () => {
  const { claim } = await seed()

  // Same claim, but the route was cancelled — so there's no pay to draw on.
  const c = await getClaim(claim.id)
  const all = await listRoutes()
  all[0].status = 'cancelled'
  await saveRoute(all[0])

  const r = await accrueAllClaims(NEXT_TUE)
  assert.deepEqual(r.posted, [], 'nothing collected')
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].reason, /no pay/)

  const after = await getClaim(c!.id)
  assert.equal(remainingCents(after!.assignments[0]), 50000, 'balance untouched — nothing forgiven')
  assert.equal(recoveredCents(after!.assignments[0]), 0)
  // …and the schedule moved on, so it retries next week rather than stalling.
  assert.equal(after!.assignments[0].nextDeductionOn, addDaysStr(MON, 7))
})
