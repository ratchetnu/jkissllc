// FIN-1 — pay-statement generation must be atomic per crew member + period.
//
// The July 2026 audit reproduced this 5/5: five concurrent identical POSTs to
// /api/admin/pay-statements all returned 200 and issued five statements for the same
// staffId + period, because findByPeriod() (check) and saveStatement() (act) were two
// separate steps. nextStatementNumber() is atomic, so the duplicates even carried valid
// sequential numbers and looked legitimate.
//
// These tests drive the REAL route handlers against an in-memory Upstash fake with a
// genuine signed session. No Preview or Production data is touched.
import assert from 'node:assert/strict'
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
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(key); break
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
      // The only script in use is the compare-and-delete lock release:
      //   if GET(KEYS[1]) == ARGV[1] then DEL(KEYS[1]) else 0
      const numKeys = Number(args[1])
      const k = args[2]
      const token = args[2 + numKeys]
      if (live(k) === token) { kv.delete(k); result = 1 } else result = 0
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { POST as generatePOST, GET as adminListGET } from '../app/api/admin/pay-statements/route'
import { GET as portalGET } from '../app/api/portal/pay-statements/route'
import { saveStaff } from '../app/lib/staff'
import { saveRoute, generateToken, type RouteRecord } from '../app/lib/routes'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { saveClaim, type ClaimRecord } from '../app/lib/claims'
import { listStatements, findByPeriod } from '../app/lib/pay-statements'
import { listAudit } from '../app/lib/audit'
import {
  withPayStatementLock, payStatementLockKey, normalizePeriodBoundary, StatementGenerationBusyError,
} from '../app/lib/pay-statement-mutex'
import { scopeKey } from '../app/lib/platform/tenancy/keys'

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
  kv.clear(); zsets.clear(); failOnce = null
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

test('different periods for the same crew member generate concurrently', async () => {
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

  failOnce = (cmd, key) => cmd === 'ZADD' && key === 'paystmt:index'   // mid-persist
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

test('lock key: mirrors the period index, normalizes boundaries, scopes per tenant', () => {
  assert.equal(payStatementLockKey('marcus', START, END), `paystmt:lock:marcus:${START}:${END}`)
  // Same period spelled differently → the SAME lock.
  assert.equal(payStatementLockKey(' marcus ', ' 2026-07-06 ', '2026-07-12T00:00:00.000Z'), `paystmt:lock:marcus:${START}:${END}`)
  assert.equal(normalizePeriodBoundary('2026-07-06T23:59:59Z'), '2026-07-06')
  assert.throws(() => normalizePeriodBoundary('07/06/2026'))
  assert.throws(() => payStatementLockKey('', START, END))
  // Different staff / different period → different keys (no cross-blocking).
  assert.notEqual(payStatementLockKey('marcus', START, END), payStatementLockKey('dana', START, END))
  assert.notEqual(payStatementLockKey('marcus', START, END), payStatementLockKey('marcus', '2026-07-13', '2026-07-19'))
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
