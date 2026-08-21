// FIN-1 — pay-statement generation must be atomic per crew member + period.
//
// The July 2026 audit reproduced this 5/5: five concurrent identical POSTs to
// /api/admin/pay-statements all returned 200 and issued five statements for the same
// staffId + period, because findByPeriod() (check) and saveStatement() (act) were two
// separate steps. The old counter increment was atomic, so the duplicates even carried valid
// sequential numbers and looked legitimate.
//
// These tests drive the REAL route handlers against an in-memory Upstash fake with a
// genuine signed session. No Preview or Production data is touched.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Must be set before any handler runs; redis.ts + the session signer read env lazily.
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'

const UPSTASH = 'http://fake-upstash.local'

// ── In-memory Upstash REST fake ──────────────────────────────────────────────
// Supports what the pay-statement path uses, plus the two primitives the lock needs:
// SET ... NX PX (atomic acquire-if-absent with a TTL) and EVAL (compare-and-delete).
type Entry = { value: string; expiresAt?: number }
const kv = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

// Injected fault: when set, any command whose (cmd, key) matches throws once.
let failOnce: ((cmd: string, key: string) => boolean) | null = null
// Injected interference: runs BEFORE the command is served, so a test can perturb the
// store mid-request (e.g. steal a lock while a generation is between reads).
let onCommand: ((cmd: string, key: string) => void) | null = null
// Runs after the fake has applied a command. It models a lost response after a
// successful commit and malformed store responses without changing production code.
let afterCommand: ((cmd: string, key: string, result: unknown) => unknown) | null = null

function live(key: string): string | null {
  const e = kv.get(key)
  if (!e) return null
  if (e.expiresAt != null && e.expiresAt <= Date.now()) { kv.delete(key); return null }
  return e.value
}

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  // Every command yields to the event loop before it is served. A REST round trip to
  // Upstash is real IO, so concurrent requests genuinely interleave between any two
  // KV operations — without this the fake resolves in microtasks and the in-flight
  // requests run in near-lockstep, which HIDES a check-then-act race instead of
  // exposing it. (Verified: with this yield the pre-fix handler issues 5 duplicate
  // statements for one crew+period; the locked handler issues 1.)
  await new Promise(r => setImmediate(r))
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const command = String(cmd).toUpperCase()
  const key = args[0]
  if (failOnce?.(command, key)) { failOnce = null; throw new Error('fake redis: injected failure') }
  onCommand?.(command, key)
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(key); break
    case 'MGET': result = args.map(live); break
    case 'SET': {
      // SET key value [NX] [PX ms]
      const flags = args.slice(2).map(a => String(a).toUpperCase())
      const nx = flags.includes('NX')
      const pxAt = flags.indexOf('PX')
      const ttl = pxAt >= 0 ? Number(args[2 + pxAt + 1]) : undefined
      if (nx && live(key) !== null) { result = null; break }
      kv.set(key, { value: args[1], expiresAt: ttl != null ? Date.now() + ttl : undefined })
      result = 'OK'
      break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(live(key) ?? 0) + 1; kv.set(key, { value: String(n) }); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(key).delete(args[1]) ? 1 : 0; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
      if (command === 'ZREVRANGE') arr.reverse()
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1)
      break
    }
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    case 'EVAL': {
      // Two ownership-guarded scripts are in use, distinguished by their body:
      //   release: if GET(KEYS[1]) == ARGV[1] then DEL(KEYS[1])            else 0
      //   renew:   if GET(KEYS[1]) == ARGV[1] then PEXPIRE(KEYS[1], ARGV[2]) else 0
      const script = String(args[0])
      const numKeys = Number(args[1])
      const keys = args.slice(2, 2 + numKeys)
      const argv = args.slice(2 + numKeys)
      if (/return 'NOT_ISSUED'/i.test(script)) {
        const raw = live(keys[0])
        if (!raw) { result = 'NOT_FOUND'; break }
        const statement = JSON.parse(raw)
        if (statement.status !== 'issued') { result = 'NOT_ISSUED'; break }
        result = argv[0]; kv.set(keys[0], { value: result as string }); break
      }
      if (/missing statement number placeholder/i.test(script)) {
        const n = Number(live(keys[0]) ?? 0) + 1
        kv.set(keys[0], { value: String(n) })
        result = argv[0].replace(argv[4], `${argv[1]}${1000 + n}`)
        kv.set(keys[1], { value: result as string })
        z(keys[2]).set(argv[3], Number(argv[2])); z(keys[3]).set(argv[3], Number(argv[2])); kv.set(keys[4], { value: argv[3] })
        break
      }
      if (/statement\.status\s*~=\s*'void'/i.test(script)) {
        const statement = JSON.parse(argv[0])
        kv.set(keys[0], { value: argv[0] }); z(keys[1]).set(argv[2], Number(argv[1])); z(keys[2]).set(argv[2], Number(argv[1]))
        if (statement.status !== 'void') kv.set(keys[3], { value: argv[2] })
        result = 1; break
      }
      const k = args[2]
      const token = args[2 + numKeys]
      const owns = live(k) === token
      if (/pexpire/i.test(script)) {
        if (owns) { kv.set(k, { value: token, expiresAt: Date.now() + Number(args[3 + numKeys]) }); result = 1 } else result = 0
      } else {
        if (owns) { kv.delete(k); result = 1 } else result = 0
      }
      break
    }
    default: result = null
  }
  if (afterCommand) result = afterCommand(command, key, result)
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { POST as generatePOST, GET as adminListGET } from '../app/api/admin/pay-statements/route'
import { GET as portalGET } from '../app/api/portal/pay-statements/route'
import { GET as portalDetailGET } from '../app/api/portal/pay-statements/[id]/route'
import { saveStaff } from '../app/lib/staff'
import { saveBusinessAddress } from '../app/lib/business-address'
import { saveRoute, generateToken, type RouteRecord } from '../app/lib/routes'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { saveClaim, type ClaimRecord } from '../app/lib/claims'
import { historicalYtdByStaff, listStatements, findByPeriod, recordedYtdForStaff, recordedYtdForStatement, saveStatement, type PayStatement } from '../app/lib/pay-statements'
import { listAudit } from '../app/lib/audit'
import { createCorrection, decideCorrection, getCorrection } from '../app/lib/pay-corrections'
import {
  withPayStatementLock, payStatementLockKey, normalizePeriodBoundary, StatementGenerationBusyError,
} from '../app/lib/pay-statement-mutex'
import { scopeKey } from '../app/lib/platform/tenancy/keys'
import { resolveTokenBinding } from '../app/lib/platform/tenancy/token-binding'

// ── Harness ──────────────────────────────────────────────────────────────────
const CTX = { params: Promise.resolve({} as Record<string, string>) }
const START = '2026-07-06'
const END = '2026-07-12'

let adminCookie = ''
let crewCookie = ''

function req(body: unknown, cookie = adminCookie): NextRequest {
  return new NextRequest('http://localhost/api/admin/pay-statements', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` },
    body: JSON.stringify(body),
  })
}
const getReq = (url: string, cookie: string) =>
  new NextRequest(url, { headers: { cookie: `jk_admin_session=${cookie}` } })

const generate = (staffId: string, periodStart = START, periodEnd = END) =>
  generatePOST(req({ staffId, periodStart, periodEnd }), CTX)

const historical = (over: Record<string, unknown> = {}, cookie = adminCookie) => generatePOST(req({
  action: 'historical', staffId: 'marcus', periodUnit: 'week', periodStart: START, periodEnd: END,
  paymentDate: '2026-07-17', paymentMethod: 'check', paymentReference: '1042',
  lines: [{ kind: 'hourly', description: 'Regular hours', quantity: 40, rate: '20.00' }],
  deductions: [],
  ...over,
}, cookie), CTX)

async function readJson(res: Response) {
  return await res.json() as { ok: boolean; error?: string; reason?: string; statement?: { id: string; statementNumber: string; grossCents: number; netCents: number; deductionCents: number; routeCount: number }; statements?: unknown[] }
}

const periodKeys = () => [...kv.keys()].filter(k => k.startsWith('paystmt:period:'))
const lockKeys = () => [...kv.keys()].filter(k => k.startsWith('paystmt:lock:') && live(k) !== null)

const route = (staffId: string, num: string, date: string, payCents: number): RouteRecord => ({
  token: generateToken(), routeNumber: num, status: 'completed',
  businessName: 'Supercharged', reportAddress: '1 Main St', reportTime: '8:00 AM',
  routeDate: date, events: [], audit: [], createdAt: 1, updatedAt: 1,
  assignees: [{ staffId, name: staffId, role: 'Driver', token: generateToken(), payCents, pay: `$${(payCents / 100).toFixed(2)}` }],
} as unknown as RouteRecord)

const booking = (staffId: string, num: string, date: string, payCents: number, over: Partial<Booking> = {}): Booking => ({
  token: generateToken(), bookingNumber: num, customerName: 'Alex Customer',
  serviceType: 'junk-removal', items: [], invoiceAmountCents: 45000,
  depositAmountCents: 0, amountPaidCents: 0, availableDates: [], availableWindows: [],
  selectedDate: date, status: 'completed', payments: [], source: 'online',
  createdAt: 1, updatedAt: 1, jobCompletedAt: 2, jobCompletedBy: 'crew',
  assignees: [{ staffId, name: staffId, role: 'Driver', token: generateToken(), payCents, pay: `$${(payCents / 100).toFixed(2)}` }],
  ...over,
} as unknown as Booking)

const claimWithDeduction = (staffId: string, amountCents: number, periodDate: string): ClaimRecord => ({
  id: `clm_${staffId}`, claimNumber: `JK-C-90${staffId.length}`, businessName: 'Acme',
  businessKey: 'acme', routeNumber: 'JK-R-1001', status: 'open', createdAt: 1, updatedAt: 1,
  assignments: [{
    staffId, name: staffId, responsibilityCents: 100000, status: 'active',
    ledger: [{ id: `e_${staffId}`, at: 1, kind: 'scheduled', direction: 'credit', amountCents, periodDate, actor: 'test' }],
  }],
} as unknown as ClaimRecord)

async function reset() {
  kv.clear(); zsets.clear(); failOnce = null; onCommand = null; afterCommand = null
  adminCookie = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  crewCookie = await createUserSessionToken({ id: 'u_marcus', role: 'crew', staffId: 'marcus' })
  await saveStaff({ id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
  await saveStaff({ id: 'dana', name: 'Dana', phone: '+15550002', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
}

// ─────────────────────────────────────────────────────────────────────────────
// The defect itself: five concurrent identical requests
// ─────────────────────────────────────────────────────────────────────────────

test('FIN-1: five concurrent identical requests issue exactly ONE statement', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))

  const results = await Promise.all(Array.from({ length: 5 }, () => generate('marcus')))
  const bodies = await Promise.all(results.map(readJson))

  // Exactly one success.
  const ok = bodies.filter(b => b.ok)
  assert.equal(ok.length, 1, 'exactly one request may create the statement')
  assert.equal(results.filter(r => r.status === 200).length, 1)

  // Every loser is a safe conflict / in-progress answer — never a 500, never a success.
  const losers = results.filter(r => r.status !== 200)
  assert.equal(losers.length, 4)
  for (const r of losers) {
    assert.ok(r.status === 409 || r.status === 423, `contention must be 409 or 423, got ${r.status}`)
    assert.ok(r.status < 500, 'ordinary contention is never a 500')
  }
  for (const b of bodies.filter(x => !x.ok)) {
    assert.ok(b.reason === 'duplicate_period' || b.reason === 'generation_in_progress', `loser must carry a reason, got ${b.reason}`)
  }

  // Exactly one persisted statement, one period index, no leaked lock.
  const all = await listStatements()
  assert.equal(all.length, 1, `expected 1 statement, found ${all.length} (${all.map(s => s.statementNumber).join(', ')})`)
  assert.equal(all[0].statementNumber, ok[0].statement!.statementNumber)
  assert.deepEqual(periodKeys(), [`paystmt:period:marcus:${START}:${END}`])
  assert.deepEqual(lockKeys(), [], 'the generation lock must be released')

  // Only ONE statement number was consumed — losers return before allocating one.
  assert.equal(live('paystmt:counter'), '1', 'a blocked request must not burn a statement number')
  assert.equal(all[0].statementNumber, 'JK-PS-1001')
})

test('FIN-1: the crew portal shows exactly one statement after concurrent generation', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await Promise.all(Array.from({ length: 5 }, () => generate('marcus')))

  const portal = await readJson(await portalGET(getReq('http://localhost/api/portal/pay-statements', crewCookie), CTX))
  assert.equal(portal.ok, true)
  assert.equal(portal.statements!.length, 1, 'a contractor must never see duplicate statements for one period')

  const admin = await readJson(await adminListGET(getReq('http://localhost/api/admin/pay-statements?staffId=marcus', adminCookie), CTX))
  assert.equal(admin.statements!.length, 1)
})

test('sequential duplicate still returns 409 with the existing statement', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))

  const first = await generate('marcus')
  assert.equal(first.status, 200)
  const second = await generate('marcus')
  assert.equal(second.status, 409)
  const body = await readJson(second)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'duplicate_period')
  assert.match(body.error!, /already exists \(JK-PS-1001\)/)
  assert.equal((await listStatements()).length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// The lock must be narrow: unrelated generations stay concurrent
// ─────────────────────────────────────────────────────────────────────────────

test('different crew members generate concurrently — one does not block the other', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await saveRoute(route('dana', 'JK-R-2002', '2026-07-08', 12500))

  const [a, b] = await Promise.all([generate('marcus'), generate('dana')])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  const all = await listStatements()
  assert.deepEqual(all.map(s => s.staffId).sort(), ['dana', 'marcus'])
  assert.equal(periodKeys().length, 2)
})

test('different non-overlapping periods for the same crew member serialize and both issue', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await saveRoute(route('marcus', 'JK-R-2002', '2026-07-14', 22500))

  const [a, b] = await Promise.all([
    generate('marcus', '2026-07-06', '2026-07-12'),
    generate('marcus', '2026-07-13', '2026-07-19'),
  ])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  const all = await listStatements()
  assert.equal(all.length, 2)
  assert.deepEqual(all.map(s => s.periodStart).sort(), ['2026-07-06', '2026-07-13'])
})

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths: the lock always comes back, and never leaves a false index
// ─────────────────────────────────────────────────────────────────────────────

test('a payroll-calculation failure releases the lock and writes nothing', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))

  failOnce = (cmd, key) => cmd === 'ZREVRANGE' && key === 'rt:index'   // computePay's route read
  await assert.rejects(async () => { await generate('marcus') })

  assert.deepEqual(lockKeys(), [], 'a failed generation must release its lock')
  assert.deepEqual(periodKeys(), [], 'a failed calculation must not leave a period index')
  assert.equal((await listStatements()).length, 0)

  // And the next attempt succeeds — the lock was not left stuck.
  assert.equal((await generate('marcus')).status, 200)
})

test('a persistence failure releases the lock and leaves NO period index', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))

  failOnce = (cmd, key) => cmd === 'EVAL' && /missing statement number placeholder/i.test(key) // atomic issue command
  await assert.rejects(async () => { await generate('marcus') })

  assert.deepEqual(lockKeys(), [], 'a failed persist must release its lock')
  assert.deepEqual(periodKeys(), [], 'a half-written statement must not claim the period')
  assert.equal(await findByPeriod('marcus', START, END), null)
  assert.equal((await listStatements()).length, 0, 'the half-written record is not indexed, so nothing surfaces')

  // The period is still free, so a retry issues the real statement.
  const retry = await generate('marcus')
  assert.equal(retry.status, 200)
  assert.equal((await listStatements()).length, 1)
  const portal = await readJson(await portalGET(getReq('http://localhost/api/portal/pay-statements', crewCookie), CTX))
  assert.equal(portal.statements!.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// Lock primitive: ownership, expiry, contention, key shape
// ─────────────────────────────────────────────────────────────────────────────

test('lock ownership: one caller can never release another caller\'s lock', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)

  let innerRan = false
  await withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => {
    // A second caller, holding a DIFFERENT token, gives up rather than stealing it.
    await assert.rejects(
      () => withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => { innerRan = true }, { attempts: 3, backoffMs: 1 }),
      (e: Error) => e instanceof StatementGenerationBusyError,
    )
    assert.equal(innerRan, false)
    assert.ok(live(key), 'the holder still owns the lock after the loser gave up')
  })
  assert.equal(live(key), null, 'the owner released it')
})

test('a failed acquire does not delete the holder\'s lock on its way out', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)
  kv.set(key, { value: 'someone-elses-token', expiresAt: Date.now() + 5_000 })

  await assert.rejects(
    () => withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => 'never', { attempts: 2, backoffMs: 1 }),
    (e: Error) => e instanceof StatementGenerationBusyError,
  )
  assert.equal(live(key), 'someone-elses-token', 'the other caller\'s lock survives untouched')
})

test('a stale lock expires and does not wedge the period forever', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)
  kv.set(key, { value: 'crashed-holder', expiresAt: Date.now() + 40 })   // holder died mid-generation

  // Immediately: blocked. After the TTL lapses: acquirable again.
  await assert.rejects(
    () => withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => 'x', { attempts: 1, backoffMs: 0 }),
    (e: Error) => e instanceof StatementGenerationBusyError,
  )
  const value = await withPayStatementLock(
    { staffId: 'marcus', periodStart: START, periodEnd: END },
    async () => 'acquired-after-expiry',
    { attempts: 20, backoffMs: 10 },
  )
  assert.equal(value, 'acquired-after-expiry')
  assert.equal(live(key), null)
})

test('the lock never outlives its work, and the route waits out a real generation', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  // Hold the lock briefly, then release; the route's retry budget outlasts it and
  // the request then sees the duplicate check honestly (nothing exists → it issues).
  const hold = withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => {
    await new Promise(r => setTimeout(r, 120))
  })
  const res = await generate('marcus')
  await hold
  assert.equal(res.status, 200, 'a brief hold is waited out, not rejected')
  assert.deepEqual(lockKeys(), [])
})

// ─────────────────────────────────────────────────────────────────────────────
// Lease renewal — the critical section is data-proportional (~5,200 KV reads at the
// configured ceilings), so it can outlast any fixed TTL. The lease is renewed while
// the work runs, and a genuinely lost lease must abort rather than write.
// ─────────────────────────────────────────────────────────────────────────────

test('the heartbeat keeps a long generation\'s lease alive past the base TTL', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)
  let heldThroughout = true

  // Work runs ~5x the base lease; without renewal the key would be long gone.
  await withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async (lock) => {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 20))
      if (live(key) === null) heldThroughout = false
    }
    await lock.assertHeld()   // still ours at the end of a long run
  }, { ttlMs: 40, renewEveryMs: 10 })

  assert.equal(heldThroughout, true, 'the lease must never lapse while the work is running')
  assert.equal(live(key), null, 'and it is released when the work finishes')
})

test('the heartbeat stops with the work — it cannot keep a released lock alive', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)
  await withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => {
    await new Promise(r => setTimeout(r, 30))
  }, { ttlMs: 40, renewEveryMs: 10 })
  assert.equal(live(key), null)

  // A competitor takes the key; the finished holder's (cleared) heartbeat must not
  // extend or disturb it.
  kv.set(key, { value: 'competitor-token', expiresAt: Date.now() + 60 })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(live(key), 'competitor-token', 'untouched by the previous holder')
  await new Promise(r => setTimeout(r, 40))
  assert.equal(live(key), null, 'and it expires on its own schedule, not an extended one')
})

test('compare-and-extend never prolongs another caller\'s lock', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)
  kv.set(key, { value: 'someone-elses-token', expiresAt: Date.now() + 80 })

  // A caller that does not own the key runs its heartbeat against it and gives up on
  // acquire; the foreign lock must still expire on its ORIGINAL schedule.
  await assert.rejects(
    () => withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => 'x',
      { attempts: 3, backoffMs: 10, ttlMs: 10_000, renewEveryMs: 10 }),
    (e: Error) => e instanceof StatementGenerationBusyError,
  )
  await new Promise(r => setTimeout(r, 100))
  assert.equal(live(key), null, 'the foreign lock expired on time — nobody extended it')
})

test('a lost lease ABORTS the generation: 423, and nothing is written', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  const key = payStatementLockKey('marcus', START, END)

  // Steal the lock mid-generation — while computePay is reading, before any write.
  onCommand = (cmd, k) => {
    if (cmd === 'ZREVRANGE' && k === 'rt:index') {
      kv.set(key, { value: 'stolen-by-another-instance', expiresAt: Date.now() + 30_000 })
      onCommand = null
    }
  }

  const res = await generate('marcus')
  assert.equal(res.status, 423, 'a generation that lost its lease must not push through')
  const body = await readJson(res)
  assert.equal(body.reason, 'generation_in_progress')

  assert.equal((await listStatements()).length, 0, 'no statement was written')
  assert.deepEqual(periodKeys(), [], 'no period index was written')
  assert.equal(live('paystmt:counter'), null, 'no statement number was consumed')
  assert.equal(live(key), 'stolen-by-another-instance', 'and the thief\'s lock was not deleted')
})

test('lock key: serializes every period for one staff member and scopes per tenant', () => {
  assert.equal(payStatementLockKey('marcus', START, END), 'paystmt:lock:marcus')
  // Same period spelled differently → the SAME lock.
  assert.equal(payStatementLockKey(' marcus ', ' 2026-07-06 ', '2026-07-12T00:00:00.000Z'), 'paystmt:lock:marcus')
  assert.equal(normalizePeriodBoundary('2026-07-06T23:59:59Z'), '2026-07-06')
  assert.throws(() => normalizePeriodBoundary('07/06/2026'))
  assert.throws(() => payStatementLockKey('', START, END))
  // Different staff remain independent; different periods for one staff deliberately
  // share the lock so overlapping day/week/month/custom ranges cannot race.
  assert.notEqual(payStatementLockKey('marcus', START, END), payStatementLockKey('dana', START, END))
  assert.equal(payStatementLockKey('marcus', START, END), payStatementLockKey('marcus', '2026-07-13', '2026-07-19'))
})

test('tenant isolation: two tenants take physically different locks', () => {
  const logical = payStatementLockKey('marcus', START, END)
  const a = scopeKey(logical, { enabled: true, tenantId: 'tenant-a' })
  const b = scopeKey(logical, { enabled: true, tenantId: 'tenant-b' })
  assert.equal(a, `t:tenant-a:${logical}`)
  assert.equal(b, `t:tenant-b:${logical}`)
  assert.notEqual(a, b, 'one tenant must never contend on, or release, another tenant\'s lock')
  // Flag off → byte-identical to today's single-tenant key.
  assert.equal(scopeKey(logical, { enabled: false }), logical)
})

// ─────────────────────────────────────────────────────────────────────────────
// The money must be unchanged by the lock
// ─────────────────────────────────────────────────────────────────────────────

test('route-only totals are unchanged', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await saveRoute(route('marcus', 'JK-R-2002', '2026-07-09', 12500))

  const body = await readJson(await generate('marcus'))
  assert.equal(body.statement!.grossCents, 30000)
  assert.equal(body.statement!.deductionCents, 0)
  assert.equal(body.statement!.netCents, 30000)
  assert.equal(body.statement!.routeCount, 2)
})

test('booking + route combined pay is unchanged', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await saveBooking(booking('marcus', 'JK-B-2101', '2026-07-08', 22500))

  const body = await readJson(await generate('marcus'))
  assert.equal(body.statement!.grossCents, 40000)
  assert.equal(body.statement!.netCents, 40000)
  assert.equal(body.statement!.routeCount, 2)
  const stored = (await listStatements())[0]
  assert.deepEqual(stored.lines.map(l => [l.source, l.routeNumber]).sort(), [['booking', 'JK-B-2101'], ['route', 'JK-R-2001']])
})

test('a claim deduction is applied exactly once under concurrent generation', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 40000))
  await saveClaim(claimWithDeduction('marcus', 10000, '2026-07-07'))

  const results = await Promise.all(Array.from({ length: 5 }, () => generate('marcus')))
  assert.equal(results.filter(r => r.status === 200).length, 1)

  const all = await listStatements()
  assert.equal(all.length, 1)
  assert.equal(all[0].grossCents, 40000)
  assert.equal(all[0].deductionCents, 10000, 'the deduction is withheld once, not five times')
  assert.equal(all[0].netCents, 30000)
  assert.equal(all[0].deductions.length, 1)
})

test('the immutable snapshot is not rewritten by a blocked duplicate', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  const first = await readJson(await generate('marcus'))
  const before = JSON.stringify((await listStatements())[0])

  // Work changes after issuance; a duplicate attempt must not recompute the snapshot.
  await saveRoute(route('marcus', 'JK-R-2099', '2026-07-09', 99900))
  const dup = await generate('marcus')
  assert.equal(dup.status, 409)
  const after = (await listStatements())[0]
  assert.equal(JSON.stringify(after), before, 'the issued snapshot is untouched')
  assert.equal(after.grossCents, 17500)
  assert.equal(after.statementNumber, first.statement!.statementNumber)
})

// ─────────────────────────────────────────────────────────────────────────────
// Preserved behavior: gaps, preview, audit
// ─────────────────────────────────────────────────────────────────────────────

test('payroll-gap validation still blocks with 409 and issues nothing', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await saveBooking(booking('marcus', 'JK-B-2102', '2026-07-08', 22500, { selectedDate: undefined, availableDates: [] }))

  const res = await generate('marcus')
  assert.equal(res.status, 409)
  const body = await res.json() as { ok: boolean; payrollGaps?: { bookingNumber: string }[] }
  assert.equal(body.ok, false)
  assert.deepEqual(body.payrollGaps?.map(g => g.bookingNumber), ['JK-B-2102'])
  assert.equal((await listStatements()).length, 0)
  assert.deepEqual(lockKeys(), [], 'a blocked generation releases its lock')
  assert.equal(live('paystmt:counter'), null, 'a blocked generation burns no statement number')
})

test('preview is read-only: it takes no lock and cannot be blocked by one', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  // Hold the generation lock for this exact crew + period…
  await withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => {
    const res = await generatePOST(req({ staffId: 'marcus', periodStart: START, periodEnd: END, action: 'preview' }), CTX)
    assert.equal(res.status, 200, 'preview must not wait on the generation lock')
    const body = await res.json() as { ok: boolean; preview: { grossCents: number } }
    assert.equal(body.preview.grossCents, 17500)
  })
  assert.equal((await listStatements()).length, 0, 'preview issues nothing')
})

test('audit: exactly one issuance event, and none for the blocked duplicates', async () => {
  await reset()
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await Promise.all(Array.from({ length: 5 }, () => generate('marcus')))

  const issued = (await listAudit()).filter(e => e.action === 'paystatement.issued')
  assert.equal(issued.length, 1, 'one issuance = one audit line')
  assert.equal(issued[0].outcome, 'success')
  assert.equal(issued[0].actor, 'u_admin')
  assert.equal(issued[0].entity, 'pay_statement')
  assert.equal(issued[0].entityId, (await listStatements())[0].id)
  assert.match(issued[0].summary, /JK-PS-1001/)
  // No money in the audit meta — the statement itself is the money record.
  assert.ok(!JSON.stringify(issued[0].meta ?? {}).match(/Cents/), 'audit meta carries no amounts')
})

// ─────────────────────────────────────────────────────────────────────────────
// Historical/manual statements — real stubs without synthetic work records
// ─────────────────────────────────────────────────────────────────────────────

test('historical pay issues an immutable stub without a route, booking, or punch', async () => {
  await reset()
  const res = await historical({
    periodUnit: 'month', periodStart: '2026-01-01', periodEnd: '2026-01-31', paymentDate: '2026-02-06',
    lines: [
      { kind: 'hourly', description: 'Regular hours', quantity: 40, rate: '20' },
      { kind: 'daily', description: 'Daily work', quantity: 2, rate: '150' },
      { kind: 'fixed', description: 'Bonus', amount: '75' },
    ],
    deductions: [{ label: 'Advance', amount: '25' }],
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { ok: boolean; statement: import('../app/lib/pay-statements').PayStatement }
  assert.equal(body.ok, true)
  assert.equal(body.statement.statementSource, 'historical_manual')
  assert.equal(body.statement.routeCount, 0)
  assert.equal(body.statement.grossCents, 117500)
  assert.equal(body.statement.deductionCents, 2500)
  assert.equal(body.statement.netCents, 115000)
  assert.deepEqual(body.statement.lines.map(line => line.source), ['historical', 'historical', 'historical'])
  assert.equal(body.statement.paymentReference, '1042')
  assert.equal((await listAudit()).filter(event => event.action === 'paystatement.historical_issued').length, 1)
})

test('atomic Lua issuance preserves empty arrays instead of re-encoding them as objects', async () => {
  await reset()
  const res = await historical({ deductions: [] })
  assert.equal(res.status, 200)
  const body = await res.json() as { statement: PayStatement }
  const stored = JSON.parse(live(`paystmt:${body.statement.id}`)!) as PayStatement
  assert.equal(Array.isArray(body.statement.lines), true)
  assert.equal(Array.isArray(body.statement.deductions), true)
  assert.equal(Array.isArray(stored.lines), true)
  assert.equal(Array.isArray(stored.deductions), true)
  assert.deepEqual(stored.deductions, [])

  const source = readFileSync(new URL('../app/lib/pay-statements.ts', import.meta.url), 'utf8')
  const issueScript = source.match(/const ISSUE_STATEMENT = `([\s\S]*?)`/)?.[1] ?? ''
  const emailScript = source.match(/const MARK_EMAILED_IF_ISSUED = `([\s\S]*?)`/)?.[1] ?? ''
  assert.doesNotMatch(issueScript, /cjson\.encode/, 'Lua must never serialize an immutable statement')
  assert.doesNotMatch(emailScript, /cjson\.encode/, 'email metadata must preserve caller JSON arrays')
  assert.match(issueScript, /string\.find\(encoded, needle, 1, true\)/)
  assert.match(emailScript, /redis\.call\('SET', KEYS\[1\], ARGV\[1\]\)/)

  const lua = spawnSync('lua', ['-v'], { encoding: 'utf8' })
  if (lua.status === 0) {
    const pending = JSON.stringify({
      id: 'ps_lua_array_check', statementNumber: '__OPERION_STATEMENT_NUMBER_PENDING__',
      status: 'issued', lines: [], deductions: [],
    })
    const harness = `
local values = { ['counter'] = '0' }
local zsets = {}
redis = {}
function redis.error_reply(message) error(message) end
function redis.call(command, ...)
  local args = {...}
  if command == 'INCR' then values[args[1]] = tostring(tonumber(values[args[1]] or '0') + 1); return tonumber(values[args[1]]) end
  if command == 'SET' then values[args[1]] = args[2]; return 'OK' end
  if command == 'ZADD' then zsets[args[1]] = { score = args[2], member = args[3] }; return 1 end
  error('unsupported command ' .. command)
end
KEYS = {'counter', 'record', 'global', 'staff', 'period'}
ARGV = {${JSON.stringify(pending)}, 'JK-PS-', '1', 'ps_lua_array_check', '__OPERION_STATEMENT_NUMBER_PENDING__'}
local result = (function()
${issueScript}
end)()
io.write(result)
`
    const executed = spawnSync('lua', ['-'], { input: harness, encoding: 'utf8' })
    assert.equal(executed.status, 0, executed.stderr)
    const luaIssued = JSON.parse(executed.stdout) as PayStatement
    assert.equal(luaIssued.statementNumber, 'JK-PS-1001')
    assert.deepEqual(luaIssued.lines, [])
    assert.deepEqual(luaIssued.deductions, [])
  }
})

test('post-issue shape validation rejects a malformed Redis payload', async () => {
  await reset()
  afterCommand = (command, key, result) => {
    if (command !== 'EVAL' || !/missing statement number placeholder/i.test(key)) return result
    afterCommand = null
    const malformed = JSON.parse(String(result)) as Record<string, unknown>
    malformed.deductions = {}
    return JSON.stringify(malformed)
  }
  await assert.rejects(async () => historical(), /PAY_STATEMENT_SHAPE_INVALID/)
})

test('a lost response after commit keeps the verification binding', async () => {
  await reset()
  afterCommand = (command, key, result) => {
    if (command !== 'EVAL' || !/missing statement number placeholder/i.test(key)) return result
    afterCommand = null
    throw new Error('simulated response loss after commit')
  }
  await assert.rejects(async () => historical(), /simulated response loss after commit/)
  const [committed] = await listStatements()
  assert.ok(committed, 'the fake committed before losing the response')
  assert.equal((await resolveTokenBinding(committed.id))?.resourceId, committed.id,
    'ambiguous commit state must preserve the verification binding')
})

test('statement detail keeps immutable crew and business address snapshots', async () => {
  await reset()
  await saveStaff({
    id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 2,
    address: { line1: '1 Old St', city: 'Dallas', state: 'TX', postalCode: '75201' },
  })
  await saveBusinessAddress({ line1: '10 Original Ave', city: 'Plano', state: 'TX', postalCode: '75024' })
  const issued = await historical()
  assert.equal(issued.status, 200)
  const id = (await issued.json() as { statement: PayStatement }).statement.id

  await saveStaff({
    id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 3,
    address: { line1: '999 New Ave', city: 'Irving', state: 'TX', postalCode: '75039' },
  })
  await saveBusinessAddress({ line1: '20 Replacement Rd', city: 'Frisco', state: 'TX', postalCode: '75034' })

  const detail = await portalDetailGET(
    getReq(`http://localhost/api/portal/pay-statements/${id}`, crewCookie),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(detail.status, 200)
  const payload = await detail.json() as { contractorAddress?: string; businessAddress?: string; statement: Record<string, unknown> }
  assert.equal(payload.contractorAddress, '1 Old St, Dallas, TX 75201')
  assert.equal(payload.businessAddress, '10 Original Ave, Plano, TX 75024')
  assert.equal('contractorAddress' in payload.statement, false)
  assert.equal('businessAddress' in payload.statement, false)
})

test('replacement issuance resolves and links its approved correction', async () => {
  await reset()
  const correction = await createCorrection({
    staffId: 'marcus', staffName: 'Marcus', statementNumber: 'JK-PS-0999',
    periodStart: START, periodEnd: END, message: 'The amount is incorrect.',
  })
  await decideCorrection(correction.id, true, 'Owner')
  const res = await historical({ correctionId: correction.id })
  assert.equal(res.status, 200)
  const issued = (await res.json() as { statement: PayStatement; warning?: string })
  assert.equal(issued.warning, undefined)
  const resolved = await getCorrection(correction.id)
  assert.equal(resolved?.status, 'resolved')
  assert.equal(resolved?.replacementStatementId, issued.statement.id)
  assert.equal(resolved?.replacementStatementNumber, issued.statement.statementNumber)
  assert.equal(resolved?.resolvedBy, 'Admin (u_admin)')
})

test('a correction can never resolve against another crew member replacement', async () => {
  await reset()
  const correction = await createCorrection({
    staffId: 'different-crew', staffName: 'Different Crew', periodStart: START, periodEnd: END, message: 'Fix this.',
  })
  await decideCorrection(correction.id, true, 'Owner')
  const res = await historical({ correctionId: correction.id })
  assert.equal(res.status, 200)
  const body = await res.json() as { warning?: string }
  assert.match(body.warning ?? '', /could not be linked/i)
  const untouched = await getCorrection(correction.id)
  assert.equal(untouched?.status, 'approved')
  assert.equal(untouched?.replacementStatementId, undefined)
  assert.equal(untouched?.replacementStatementNumber, undefined)
})

test('a persistent correction-link failure is visible without rolling back the issued statement', async () => {
  await reset()
  const correction = await createCorrection({ staffId: 'marcus', periodStart: START, periodEnd: END, message: 'Fix this.' })
  await decideCorrection(correction.id, true, 'Owner')
  onCommand = (cmd, key) => {
    if (cmd === 'SET' && key === `paycorr:${correction.id}`) throw new Error('simulated correction store outage')
  }
  const res = await historical({ correctionId: correction.id })
  onCommand = null
  assert.equal(res.status, 200)
  const body = await res.json() as { statement: PayStatement; warning?: string }
  assert.match(body.warning ?? '', /statement was issued/i)
  assert.equal((await listStatements()).some(statement => statement.id === body.statement.id), true)
  assert.equal((await getCorrection(correction.id))?.status, 'approved')
})

test('five simultaneous historical submissions issue exactly one stub and one number', async () => {
  await reset()
  const results = await Promise.all(Array.from({ length: 5 }, () => historical()))
  assert.equal(results.filter(res => res.status === 200).length, 1)
  assert.equal((await listStatements()).length, 1)
  assert.equal(live('paystmt:counter'), '1')
  assert.equal(periodKeys().length, 1)
  assert.deepEqual(lockKeys(), [])
  assert.equal((await listAudit()).filter(event => event.action === 'paystatement.historical_issued').length, 1)
})

test('historical month/week/day overlaps are rejected so YTD cannot double-count them', async () => {
  await reset()
  assert.equal((await historical({
    periodUnit: 'month', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    lines: [{ kind: 'fixed', amount: '4000' }],
  })).status, 200)

  for (const period of [
    { periodUnit: 'week', periodStart: '2026-07-13', periodEnd: '2026-07-19' },
    { periodUnit: 'day', periodStart: '2026-07-15', periodEnd: '2026-07-15' },
  ]) {
    const res = await historical({ ...period, lines: [{ kind: 'fixed', amount: '200' }] })
    assert.equal(res.status, 409)
    assert.equal((await readJson(res)).reason, 'overlapping_period')
  }
  assert.equal((await listStatements()).length, 1)
  assert.equal(live('paystmt:counter'), '1', 'overlap rejection consumes no statement number')
})

test('two differently-shaped overlapping submissions race to exactly one live statement', async () => {
  await reset()
  const [month, week] = await Promise.all([
    historical({ periodUnit: 'month', periodStart: '2026-07-01', periodEnd: '2026-07-31', lines: [{ kind: 'fixed', amount: '4000' }] }),
    historical({ periodUnit: 'week', periodStart: '2026-07-13', periodEnd: '2026-07-19', lines: [{ kind: 'fixed', amount: '900' }] }),
  ])
  assert.equal([month, week].filter(res => res.status === 200).length, 1)
  assert.equal([month, week].filter(res => res.status === 409 || res.status === 423).length, 1)
  assert.equal((await listStatements()).length, 1)
  assert.equal(live('paystmt:counter'), '1')
})

test('historical issuance that loses its staff lock aborts before allocating or writing', async () => {
  await reset()
  const key = payStatementLockKey('marcus', START, END)
  onCommand = (cmd, k) => {
    if (cmd === 'ZREVRANGE' && k === 'paystmt:staff:marcus') {
      kv.set(key, { value: 'stolen-by-another-instance', expiresAt: Date.now() + 30_000 })
      onCommand = null
    }
  }
  const res = await historical()
  assert.equal(res.status, 423)
  assert.equal((await readJson(res)).reason, 'generation_in_progress')
  assert.equal((await listStatements()).length, 0)
  assert.equal(live('paystmt:counter'), null)
  assert.equal(live(key), 'stolen-by-another-instance')
})

test('crew receives the complete monthly stub without internal manual-entry provenance', async () => {
  await reset()
  const issued = await historical({
    periodUnit: 'month', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    note: 'Reconstructed from owner spreadsheet',
  })
  const id = (await issued.json() as { statement: { id: string } }).statement.id
  const list = await portalGET(getReq('http://localhost/api/portal/pay-statements', crewCookie), CTX)
  const listed = await list.json() as { statements: Array<Record<string, unknown>> }
  assert.equal(listed.statements.length, 1)
  assert.equal('statementSource' in listed.statements[0], false)
  const res = await portalDetailGET(
    getReq(`http://localhost/api/portal/pay-statements/${id}`, crewCookie),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(res.status, 200)
  const payload = await res.json() as { statement: Record<string, unknown> & { lines: Array<Record<string, unknown>>; periodStart: string; periodEnd: string } }
  assert.equal('historicalNote' in payload.statement, false)
  assert.equal('statementSource' in payload.statement, false)
  assert.equal('issuedBy' in payload.statement, false)
  assert.equal('periodUnit' in payload.statement, false)
  assert.equal(payload.statement.lines.some(line => 'source' in line), false)
  assert.equal(payload.statement.lines.some(line => 'businessName' in line), false)
  assert.doesNotMatch(JSON.stringify(payload.statement), /historical|manual|manually|prior[ -]pay|entered by|administrator/i)
  assert.equal(payload.statement.periodStart, '2026-07-01')
  assert.equal(payload.statement.periodEnd, '2026-07-31')
})

test('historical import is admin-only but accepts inactive former crew', async () => {
  await reset()
  const manager = await createUserSessionToken({ id: 'u_manager', role: 'manager' })
  assert.equal((await historical({}, manager)).status, 403)

  await saveStaff({ id: 'dana', name: 'Dana', phone: '+15550002', role: 'Driver', active: false, createdAt: 1, updatedAt: 2 })
  const res = await historical({ staffId: 'dana' })
  assert.equal(res.status, 200)
  const statement = (await res.json() as { statement: { staffName: string } }).statement
  assert.equal(statement.staffName, 'Dana')
})

test('pay issuance is blocked while contractor onboarding awaits verification', async () => {
  await reset()
  await saveStaff({
    id: 'pending-pay', name: 'Pending Pay', active: false,
    contractorStatus: 'pending_verification', onboarding: true,
    createdAt: 1, updatedAt: 2,
  })
  const res = await historical({ staffId: 'pending-pay' })
  assert.equal(res.status, 409)
  assert.match((await res.json() as { error: string }).error, /until onboarding is verified/)
  assert.equal((await listStatements()).length, 0)
})

test('recorded YTD includes historical and generated statements once and excludes later periods', async () => {
  await reset()
  await historical({ periodUnit: 'month', periodStart: '2026-01-01', periodEnd: '2026-01-31', paymentDate: '2026-02-06', lines: [{ kind: 'fixed', amount: '500' }] })
  await historical({ periodUnit: 'month', periodStart: '2026-02-01', periodEnd: '2026-02-28', paymentDate: '2026-03-06', lines: [{ kind: 'fixed', amount: '700' }] })
  await historical({ periodUnit: 'month', periodStart: '2026-03-01', periodEnd: '2026-03-31', paymentDate: '2026-04-03', lines: [{ kind: 'fixed', amount: '900' }] })
  const feb = (await listStatements()).find(statement => statement.periodEnd === '2026-02-28')!
  assert.deepEqual(await recordedYtdForStatement(feb), { grossCents: 120000, deductionCents: 0, netCents: 120000 })
})

test('recorded YTD is uncapped, batched, same-year only, and excludes void statements', async () => {
  await reset()
  const make = (i: number, over: Partial<PayStatement> = {}): PayStatement => ({
    id: `ps_ytd_${i}`, statementNumber: `TEST-${i}`, staffId: 'marcus', staffName: 'Marcus',
    periodStart: '2026-01-01', periodEnd: '2026-01-01', grossCents: 100,
    deductionCents: 0, netCents: 100, routeCount: 0, lines: [], deductions: [],
    statementSource: 'historical_manual', status: 'issued', issuedBy: 'test', issuedAt: i + 1, updatedAt: i + 1,
    ...over,
  })
  const target = make(500)
  for (let i = 0; i <= 500; i++) {
    const statement = i === 500 ? target : make(i)
    await saveStatement(statement)
  }
  await saveStatement(make(600, { id: 'ps_void_000', status: 'void', grossCents: 99900, netCents: 99900 }))
  await saveStatement(make(601, { id: 'ps_prior_year_000', periodStart: '2025-12-31', periodEnd: '2025-12-31', grossCents: 99900, netCents: 99900 }))

  const limited = await (await adminListGET(getReq('http://localhost/api/admin/pay-statements', adminCookie), CTX)).json() as { statements: Array<{ statementNumber: string }> }
  assert.equal(limited.statements.some(statement => statement.statementNumber === 'TEST-0'), false, 'control: oldest statement is outside the 500-row admin list')
  const resolved = await (await adminListGET(getReq(
    'http://localhost/api/admin/pay-statements?resolveCorrection=1&staffId=marcus&statementNumber=TEST-0',
    adminCookie,
  ), CTX)).json() as { statement: { statementNumber: string } | null }
  assert.equal(resolved.statement?.statementNumber, 'TEST-0', 'correction lookup scans authoritative uncapped staff history')

  const calls = new Map<string, number>()
  onCommand = (cmd) => calls.set(cmd, (calls.get(cmd) ?? 0) + 1)
  const ytd = await recordedYtdForStatement(target)
  onCommand = null

  assert.deepEqual(ytd, { grossCents: 50_100, deductionCents: 0, netCents: 50_100 })
  assert.deepEqual(await recordedYtdForStaff('marcus', '2026-12-31'), ytd)
  assert.deepEqual(await historicalYtdByStaff('2026'), { marcus: 50_100 })
  assert.equal(calls.get('GET') ?? 0, 0, 'YTD never fans out to one GET per statement')
  assert.ok((calls.get('MGET') ?? 0) <= 3, `expected at most 3 batched reads, got ${calls.get('MGET')}`)
})
