// Issue #189 — the single-open-punch policy under genuine contention.
//
// Every test written for this feature so far runs ONE caller against an in-memory
// Map. The feature exists to arbitrate the opposite situation: the same crew member
// clocking in on two jobs at the same moment. That scenario was untested, which
// made it the most likely place for the feature to be wrong.
//
// These run against the REAL KV emulator as a child process. The policy's lock is a
// DISTRIBUTED lock — `SET NX PX` over the store — so it can only be exercised by
// callers that actually race for it across a socket. An in-process fake cannot
// express that; a stubbed `fetch` resolves synchronously and hands the winner the
// lock before the loser ever asks.
//
// The emulator is single-threaded, which is how Redis executes commands, so `SET NX`
// atomicity here models production rather than approximating it.
//
// WHAT THIS STILL CANNOT PROVE: network partition, Upstash latency, or lease expiry
// under real wall-clock pressure. Preview against real Upstash remains required
// (E3 in docs/operations/PUNCH-ENGINE-ACTIVATION-HANDOFF.md).
import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.ADMIN_SESSION_SECRET ||= 'test-admin-session-secret-32byteslong!!'

const PORT = 9500 + (process.pid % 60)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { saveRoute, getRouteByToken, type RouteRecord } from '../app/lib/routes'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { withSingleOpenPunchPolicy } from '../app/lib/timeclock/punch-policy'
import { syncAssigneePunchIndex } from '../app/lib/timeclock/punch-index-sync'
import { backfillOpenPunchIndex } from '../app/lib/timeclock/open-punch-backfill'
import { reconcileOpenPunchIndex } from '../app/lib/timeclock/open-punch-backfill'

const T = <X>(fn: () => Promise<X>) => runWithTenant({ tenantId: 'jkiss' }, fn)
const DAY = '2030-07-01'
const STAFF = 's-race'

let kv: ChildProcess | null = null
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
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  delete process.env.OPEN_PUNCH_INDEX_ENABLED
})

const mkRoute = (n: number): RouteRecord => ({
  token: `a00000000000000${n}`,
  routeNumber: `JK-R-70${n}`,
  businessName: 'Acme',
  routeDate: DAY,
  status: 'assigned',
  createdAt: 1, updatedAt: 1, events: [], audit: [],
  assignees: [{ staffId: STAFF, name: 'Racer', token: `c000000000000000${n}`, confirmedAt: 1 }],
} as unknown as RouteRecord)

/** Apply a clock-in the way a real caller does: persist, then file the index. */
async function applyClockIn(token: string): Promise<'written'> {
  const r = await getRouteByToken(token)
  if (!r) throw new Error(`route ${token} vanished`)
  const a = r.assignees![0]
  a.clockInAt = Date.now()
  await saveRoute(r)
  await syncAssigneePunchIndex('route', r.token, r.routeDate, a)
  return 'written'
}

/** How many routes actually carry an open punch, read back from the store. */
async function openPunchCount(tokens: string[]): Promise<number> {
  let n = 0
  for (const t of tokens) {
    const r = await getRouteByToken(t)
    const a = r?.assignees?.[0]
    if (a?.clockInAt && !a.clockOutAt) n++
  }
  return n
}

const attempt = (token: string) =>
  T(() => withSingleOpenPunchPolicy('clock_in', {
    type: 'route', jobToken: token, staffId: STAFF, serviceDate: DAY,
  }, () => applyClockIn(token)))

// ── The core invariant ──────────────────────────────────────────────────────

test('two simultaneous clock-ins on different jobs create exactly ONE open punch', async () => {
  const tokens = [mkRoute(1).token, mkRoute(2).token]
  await T(async () => { await saveRoute(mkRoute(1)); await saveRoute(mkRoute(2)) })

  const [a, b] = await Promise.all([attempt(tokens[0]), attempt(tokens[1])])

  assert.equal(await T(() => openPunchCount(tokens)), 1,
    'the whole point of the feature: one crew member, one open punch')

  const winners = [a, b].filter(r => r.ok)
  const losers = [a, b].filter(r => !r.ok)
  assert.equal(winners.length, 1, 'exactly one caller may write')
  assert.equal(losers.length, 1, 'and exactly one must be refused')
  assert.equal(!losers[0].ok && losers[0].block, 'other_open_punch',
    'the loser is told WHY, not handed a generic failure')
})

test('five simultaneous attempts still create exactly ONE open punch', async () => {
  const tokens = [1, 2, 3, 4, 5].map(n => mkRoute(n).token)
  await T(async () => { for (const n of [1, 2, 3, 4, 5]) await saveRoute(mkRoute(n)) })

  const results = await Promise.all(tokens.map(t => attempt(t)))

  assert.equal(await T(() => openPunchCount(tokens)), 1, `5 racers → 1 punch`)
  assert.equal(results.filter(r => r.ok).length, 1, 'one winner')
  for (const r of results.filter(x => !x.ok)) {
    assert.ok(
      !r.ok && (r.block === 'other_open_punch' || r.block === 'busy'),
      `a loser must be refused for a NAMED reason, got ${!r.ok ? r.block : '?'}`,
    )
  }
})

test('duplicate attempts fail safely — no partial write, no thrown error', async () => {
  const tokens = [mkRoute(1).token, mkRoute(2).token]
  await T(async () => { await saveRoute(mkRoute(1)); await saveRoute(mkRoute(2)) })

  const settled = await Promise.allSettled([attempt(tokens[0]), attempt(tokens[1])])
  for (const s of settled) {
    assert.equal(s.status, 'fulfilled', 'a refusal is a RESULT, never a rejection')
  }
  assert.equal(await T(() => openPunchCount(tokens)), 1)
})

// ── Retries ─────────────────────────────────────────────────────────────────

test('a refused caller retrying does not create a second punch', async () => {
  const tokens = [mkRoute(1).token, mkRoute(2).token]
  await T(async () => { await saveRoute(mkRoute(1)); await saveRoute(mkRoute(2)) })

  const [a, b] = await Promise.all([attempt(tokens[0]), attempt(tokens[1])])
  const loserToken = a.ok ? tokens[1] : tokens[0]

  for (let i = 0; i < 3; i++) {
    const retry = await attempt(loserToken)
    assert.equal(retry.ok, false, `retry ${i + 1} must still be refused`)
  }
  assert.equal(await T(() => openPunchCount(tokens)), 1, 'retries converge, never accumulate')
  void b
})

test('the WINNER re-tapping its own job does not double-open', async () => {
  // Idempotent re-tap: the same job, same person. Must not be treated as a second
  // punch, and must not be refused as "another job" either.
  const tokens = [mkRoute(1).token]
  await T(() => saveRoute(mkRoute(1)))
  const first = await attempt(tokens[0])
  assert.equal(first.ok, true)
  await attempt(tokens[0])
  assert.equal(await T(() => openPunchCount(tokens)), 1, 'still one punch on one job')
})

// ── Stale state must not corrupt the index ──────────────────────────────────

test('a stale index entry does not survive reconciliation after a race', async () => {
  process.env.OPEN_PUNCH_INDEX_ENABLED = 'true'
  const tokens = [mkRoute(1).token, mkRoute(2).token]
  await T(async () => { await saveRoute(mkRoute(1)); await saveRoute(mkRoute(2)) })
  await T(() => backfillOpenPunchIndex('seed', Date.now()))

  await Promise.all([attempt(tokens[0]), attempt(tokens[1])])

  const drift = await T(() => reconcileOpenPunchIndex())
  assert.equal(drift.complete, true, 'the scan must complete')
  assert.deepEqual(drift.missing, [], 'the index must not UNDER-report — that permits a double clock-in')
  assert.deepEqual(drift.extra, [], 'nor over-report — that wrongly blocks a crew member')
  assert.deepEqual(drift.misfiled, [])
})

test('the index agrees with truth after a five-way race', async () => {
  process.env.OPEN_PUNCH_INDEX_ENABLED = 'true'
  const tokens = [1, 2, 3, 4, 5].map(n => mkRoute(n).token)
  await T(async () => { for (const n of [1, 2, 3, 4, 5]) await saveRoute(mkRoute(n)) })
  await T(() => backfillOpenPunchIndex('seed', Date.now()))

  await Promise.all(tokens.map(t => attempt(t)))

  const drift = await T(() => reconcileOpenPunchIndex())
  assert.equal(drift.complete, true)
  assert.equal(drift.missing.length + drift.extra.length + drift.misfiled.length, 0,
    `index diverged from truth after a race: ${JSON.stringify({ m: drift.missing, e: drift.extra, f: drift.misfiled })}`)
  assert.equal(await T(() => openPunchCount(tokens)), 1)
})

// ── Flag OFF reproduces today's behaviour ───────────────────────────────────

test('FLAG-OFF: the same race is NOT arbitrated — today\'s behaviour, unchanged', async () => {
  // Not a bug being documented — the point of the flag. With enforcement off the
  // policy is inert, so both writes land. This is the baseline the flag changes,
  // and asserting it is what makes the flag-ON tests above meaningful.
  delete process.env.SINGLE_OPEN_PUNCH_ENABLED
  const tokens = [mkRoute(1).token, mkRoute(2).token]
  await T(async () => { await saveRoute(mkRoute(1)); await saveRoute(mkRoute(2)) })

  const results = await Promise.all([attempt(tokens[0]), attempt(tokens[1])])
  for (const r of results) assert.equal(r.ok, true, 'flag off refuses nobody')
  assert.equal(await T(() => openPunchCount(tokens)), 2,
    'two open punches — exactly what the flag exists to stop, and what happens without it')
})
