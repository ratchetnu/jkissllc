// Issue #190 — plan a backfill without performing one.
//
// Until now the only way to learn what a backfill would do was to run it. On a
// first Production pass against live crew data that makes the first observation of
// the result the same moment it is already written — the wrong order for a
// subsystem whose failure mode is "a crew member cannot clock in".
//
// These run against the REAL KV emulator as a child process (the same harness
// open-punch-index.test.ts uses), not an in-memory Map. Commands cross a socket,
// so "wrote nothing" is measured at the store rather than asserted about a stub.
import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.ADMIN_SESSION_SECRET ||= 'test-admin-session-secret-32byteslong!!'

const PORT = 9300 + (process.pid % 60)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { saveRoute, type RouteRecord } from '../app/lib/routes'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import {
  planOpenPunchBackfill, backfillOpenPunchIndex, reconcileOpenPunchIndex,
} from '../app/lib/timeclock/open-punch-backfill'
import { readReadyMarker, indexIsAuthoritative } from '../app/lib/timeclock/open-punch-index'

const TENANT = 'jkiss'
const T = <X>(fn: () => Promise<X>) => runWithTenant({ tenantId: TENANT }, fn)
const DAY = '2030-05-01'

let kv: ChildProcess | null = null

/**
 * A fingerprint of everything the store currently holds, taken from the emulator's
 * own dump. Compared before/after, this proves "wrote nothing" AT THE STORE rather
 * than asserting it about a stub — including that no existing value was rewritten,
 * which a key COUNT alone would miss.
 */
async function storeState(): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${PORT}/__admin/dump`)
  if (!r.ok) throw new Error('emulator dump unavailable — this test would prove nothing')
  const j = (await r.json()) as { strings: Record<string, string>; zsets: Record<string, Record<string, unknown>>; hashes: Record<string, Record<string, unknown>> }
  // EMPTY collections are dropped. The emulator lazily materialises an empty zset
  // when one is READ, which real Redis does not — so counting those as writes would
  // fail this test on an artefact of the harness rather than on anything the code
  // did. Content is what matters, and content is what is compared.
  const nonEmpty = (o: Record<string, Record<string, unknown>>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => Object.keys(v ?? {}).length > 0))
  return JSON.stringify({ strings: j.strings, zsets: nonEmpty(j.zsets), hashes: nonEmpty(j.hashes) })
}

before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(async () => {
  await fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {})
  process.env.OPEN_PUNCH_INDEX_ENABLED = 'true'
  delete process.env.SINGLE_OPEN_PUNCH_ENABLED
})

const route = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  token: 'r0000000000000001',
  routeNumber: 'JK-R-9001',
  businessName: 'Acme',
  routeDate: DAY,
  status: 'assigned',
  createdAt: 1,
  updatedAt: 1,
  events: [],
  audit: [],
  assignees: [{ staffId: 's1', name: 'Sam', token: 'c0000000000000001', confirmedAt: 1, clockInAt: 1000 }],
  ...over,
} as RouteRecord)

// ── It writes nothing. Measured at the store. ───────────────────────────────

test('a dry run writes NOTHING — the whole store is byte-identical afterwards', async () => {
  await T(() => saveRoute(route()))
  const before = await storeState()

  const plan = await T(() => planOpenPunchBackfill())
  assert.equal(plan.ok, true)

  assert.equal(await storeState(), before,
    'a dry run must not create, remove or rewrite a single value')
})

test('a dry run never writes the READY MARKER — the one write that changes behaviour', async () => {
  await T(() => saveRoute(route()))
  assert.equal(await T(() => readReadyMarker()), null, 'no marker to begin with')

  await T(() => planOpenPunchBackfill())

  assert.equal(await T(() => readReadyMarker()), null, 'still no marker')
  assert.equal(await T(() => indexIsAuthoritative()), false,
    'a plan must never make an unpopulated index authoritative — that fails OPEN')
})

test('a dry run leaves the index non-authoritative even run repeatedly', async () => {
  await T(() => saveRoute(route()))
  for (let i = 0; i < 3; i++) await T(() => planOpenPunchBackfill())
  assert.equal(await T(() => indexIsAuthoritative()), false)
  assert.equal(await T(() => readReadyMarker()), null)
})

// ── It reports the population and the drift ─────────────────────────────────

test('reports the live open-punch population, not an estimate', async () => {
  await T(() => saveRoute(route({
    assignees: [
      { staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 1000 },                      // open
      { staffId: 's2', name: 'Ada', token: 'c2', confirmedAt: 1, clockInAt: 1000, clockOutAt: 2000 },   // closed
      { staffId: 's3', name: 'Rae', token: 'c3', confirmedAt: 1 },                                       // never clocked in
    ],
  } as Partial<RouteRecord>)))

  const plan = await T(() => planOpenPunchBackfill())
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.openPunches, 1, 'only the genuinely open punch counts')
  assert.ok(plan.routesScanned >= 1)
})

test('on an empty index everything is "would index", nothing is stale', async () => {
  await T(() => saveRoute(route()))
  const plan = await T(() => planOpenPunchBackfill())
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.wouldIndex, plan.openPunches, 'nothing is indexed yet')
  assert.equal(plan.alreadyCorrect, 0)
  assert.equal(plan.wouldRemoveStale, 0)
  assert.equal(plan.missing.length, plan.openPunches)
  assert.equal(plan.markerPresent, false)
})

test('the plan matches what a real run then actually does', async () => {
  // The claim that makes a dry run worth trusting: its numbers predict reality.
  await T(() => saveRoute(route()))
  const plan = await T(() => planOpenPunchBackfill())
  assert.equal(plan.ok, true)
  if (!plan.ok) return

  const real = await T(() => backfillOpenPunchIndex('run-1', Date.now()))
  assert.equal(real.ok, true)
  if (!real.ok) return

  assert.equal(real.marker.openPunchesIndexed, plan.openPunches, 'population predicted correctly')
  assert.equal(real.removedStale, plan.wouldRemoveStale, 'stale removal predicted correctly')
})

test('after a real run, a second dry run reports parity and zero work', async () => {
  await T(() => saveRoute(route()))
  await T(() => backfillOpenPunchIndex('run-1', Date.now()))

  const plan = await T(() => planOpenPunchBackfill())
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.wouldIndex, 0, 'nothing left to write')
  assert.equal(plan.wouldRemoveStale, 0, 'nothing left to remove')
  assert.equal(plan.alreadyCorrect, plan.openPunches)
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(plan.extra, [])
  assert.equal(plan.markerPresent, true, 'and it reports that the index IS authoritative now')
})

test('drift is reported without being repaired', async () => {
  // Index a punch, then close it in truth. The index now holds an entry truth does
  // not support — the direction that wrongly BLOCKS a crew member.
  await T(() => saveRoute(route()))
  await T(() => backfillOpenPunchIndex('run-1', Date.now()))
  await T(() => saveRoute(route({
    assignees: [{ staffId: 's1', name: 'Sam', token: 'c0000000000000001', confirmedAt: 1, clockInAt: 1000, clockOutAt: 2000 }],
  } as Partial<RouteRecord>)))

  const plan = await T(() => planOpenPunchBackfill())
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.wouldRemoveStale, 1, 'the stale entry is reported')
  assert.equal(plan.extra.length, 1)

  // ...and is still there. A plan reports; it does not repair.
  const after = await T(() => reconcileOpenPunchIndex())
  assert.equal(after.extra.length, 1, 'the dry run must NOT have cleaned it up')
  assert.equal(after.repaired, false)
})

// ── It cannot block a real run ──────────────────────────────────────────────

test('a dry run takes no lease — a real backfill can run immediately after', async () => {
  // If planning held the backfill lease, a long scan would lock out the real run.
  // Interleaving them proves the lease was never taken.
  await T(() => saveRoute(route()))
  await T(() => planOpenPunchBackfill())
  const real = await T(() => backfillOpenPunchIndex('run-after-plan', Date.now()))
  assert.equal(real.ok, true, 'a plan must never block the run it is planning')
})

test('concurrent dry runs do not contend', async () => {
  await T(() => saveRoute(route()))
  const results = await Promise.all([
    T(() => planOpenPunchBackfill()),
    T(() => planOpenPunchBackfill()),
    T(() => planOpenPunchBackfill()),
  ])
  for (const r of results) assert.equal(r.ok, true, 'no planner is ever refused as busy')
})

// ── Failure is reported, not guessed ────────────────────────────────────────

test('a failed scan never reports an empty population', async () => {
  // The worst possible answer here is a confident "0 open punches" produced by a scan
  // that could not run: it reads as "nothing to back-fill" and invites the flip. It
  // may surface as a thrown error OR a structured refusal — either is safe. What must
  // never happen is ok:true with a fabricated zero.
  kv?.kill('SIGKILL')
  kv = null
  let threw = false
  let plan: Awaited<ReturnType<typeof planOpenPunchBackfill>> | null = null
  try { plan = await T(() => planOpenPunchBackfill()) } catch { threw = true }

  if (threw) return                       // failed loudly — acceptable
  assert.ok(plan, 'no plan and no throw would mean it silently returned undefined')
  assert.equal(plan!.ok, false, 'a scan that could not run must NOT report ok:true')
})
