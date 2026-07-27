// FIN-2 — voiding a pay statement must never free a period that a NEWER live
// statement owns.
//
// The July 2026 race audit reproduced this with NO concurrency at all: void deleted
// `paystmt:period:{staff}:{start}:{end}` unconditionally, but a void is addressed by
// statement ID. So voiding a statement that had already been superseded deleted the
// REPLACEMENT's index, the duplicate guard went blind, and a second live statement
// issued for the same crew member and week — FIN-1's defect through another door.
//
// These tests drive the REAL route handlers against an in-memory Upstash fake with a
// genuine signed session. No Preview or Production data is touched.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'

// ── In-memory Upstash REST fake ──────────────────────────────────────────────
type Entry = { value: string; expiresAt?: number }
const kv = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
let failOnce: ((cmd: string, key: string) => boolean) | null = null

function live(key: string): string | null {
  const e = kv.get(key)
  if (!e) return null
  if (e.expiresAt != null && e.expiresAt <= Date.now()) { kv.delete(key); return null }
  return e.value
}

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  // Yield per command so concurrent requests genuinely interleave (see the FIN-1 suite).
  await new Promise(r => setImmediate(r))
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const command = String(cmd).toUpperCase()
  const key = args[0]
  if (failOnce?.(command, key)) { failOnce = null; throw new Error('fake redis: injected failure') }
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(key); break
    case 'SET': {
      const flags = args.slice(2).map(a => String(a).toUpperCase())
      const nx = flags.includes('NX')
      const pxAt = flags.indexOf('PX')
      const ttl = pxAt >= 0 ? Number(args[2 + pxAt + 1]) : undefined
      if (nx && live(key) !== null) { result = null; break }
      kv.set(key, { value: args[1], expiresAt: ttl != null ? Date.now() + ttl : undefined })
      result = 'OK'; break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(live(key) ?? 0) + 1; kv.set(key, { value: String(n) }); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(key).delete(args[1]) ? 1 : 0; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE': case 'ZREVRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
      if (command === 'ZREVRANGE') arr.reverse()
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1); break
    }
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    case 'EVAL': {
      // Three ownership-guarded scripts share this shape — lock release, lock renew,
      // and the FIN-2 period-index compare-and-delete:
      //   if GET(KEYS[1]) == ARGV[1] then DEL | PEXPIRE(KEYS[1], ARGV[2]) else 0
      const script = String(args[0])
      const numKeys = Number(args[1])
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
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { POST as generatePOST } from '../app/api/admin/pay-statements/route'
import { POST as statementPOST } from '../app/api/admin/pay-statements/[id]/route'
import { GET as portalGET } from '../app/api/portal/pay-statements/route'
import { saveStaff } from '../app/lib/staff'
import { saveRoute, generateToken, type RouteRecord } from '../app/lib/routes'
import { listStatements, getStatement, releasePeriodIndexIfOwned, type PayStatement } from '../app/lib/pay-statements'
import { listAudit } from '../app/lib/audit'
import { withPayStatementLock, payStatementLockKey } from '../app/lib/pay-statement-mutex'

// ── Harness ──────────────────────────────────────────────────────────────────
const CTX = { params: Promise.resolve({} as Record<string, string>) }
const START = '2026-07-06'
const END = '2026-07-12'
let adminCookie = ''
let crewCookie = ''

const post = (body: unknown, cookie = adminCookie) => new NextRequest('http://localhost/api/admin/pay-statements', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` },
  body: JSON.stringify(body),
})
const generate = (staffId = 'marcus', periodStart = START, periodEnd = END) =>
  generatePOST(post({ staffId, periodStart, periodEnd }), CTX)
const voidStmt = (id: string) =>
  statementPOST(post({ action: 'void' }), { params: Promise.resolve({ id }) })

type Body = { ok: boolean; error?: string; reason?: string; alreadyVoid?: boolean; statement?: PayStatement; statements?: PayStatement[] }
const readJson = async (res: Response) => await res.json() as Body

const periodKey = (staffId = 'marcus') => `paystmt:period:${staffId}:${START}:${END}`
const periodKeys = () => [...kv.keys()].filter(k => k.startsWith('paystmt:period:') && live(k) !== null)
const lockKeys = () => [...kv.keys()].filter(k => k.startsWith('paystmt:lock:') && live(k) !== null)
const liveStatements = async (staffId = 'marcus') =>
  (await listStatements()).filter(s => s.status === 'issued' && s.staffId === staffId)
const voidEvents = async () => (await listAudit()).filter(e => e.action === 'paystatement.voided')

const route = (staffId: string, num: string, date: string, payCents: number): RouteRecord => ({
  token: generateToken(), routeNumber: num, status: 'completed', businessName: 'Supercharged',
  reportAddress: '1 Main St', reportTime: '8:00 AM', routeDate: date, events: [], audit: [],
  createdAt: 1, updatedAt: 1,
  assignees: [{ staffId, name: staffId, role: 'Driver', token: generateToken(), payCents, pay: `$${(payCents / 100).toFixed(2)}` }],
} as unknown as RouteRecord)

async function reset() {
  kv.clear(); zsets.clear(); failOnce = null
  adminCookie = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  crewCookie = await createUserSessionToken({ id: 'u_marcus', role: 'crew', staffId: 'marcus' })
  await saveStaff({ id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
  await saveStaff({ id: 'dana', name: 'Dana', phone: '+15550002', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
  await saveRoute(route('marcus', 'JK-R-2001', '2026-07-07', 17500))
  await saveRoute(route('dana', 'JK-R-2002', '2026-07-08', 12500))
  await saveRoute(route('marcus', 'JK-R-2003', '2026-07-15', 20000))   // the next week
}
const portalCount = async () => {
  const res = await portalGET(new NextRequest('http://localhost/api/portal/pay-statements',
    { headers: { cookie: `jk_admin_session=${crewCookie}` } }), CTX)
  return ((await res.json()) as Body).statements!.length
}

// ─────────────────────────────────────────────────────────────────────────────
// The defect: a stale void must not free a successor's period
// ─────────────────────────────────────────────────────────────────────────────

test('FIN-2: a stale second void of a superseded statement leaves the LIVE index alone', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  assert.equal((await voidStmt(a.id)).status, 200, 'the legitimate void frees the period')
  const b = (await readJson(await generate())).statement!
  assert.equal(live(periodKey()), b.id, 'the period now belongs to B')

  // The operator clicks Void again on the OLD row (stale tab / double-click).
  const stale = await voidStmt(a.id)
  assert.equal(stale.status, 200)
  const staleBody = await readJson(stale)
  assert.equal(staleBody.alreadyVoid, true, 'truthful: nothing changed')
  assert.equal(live(periodKey()), b.id, 'B still owns its period index')

  // The duplicate guard is intact, so no replacement C can be created.
  const c = await generate()
  assert.equal(c.status, 409, 'generation still sees B and refuses')
  assert.equal((await readJson(c)).reason, 'duplicate_period')

  const alive = await liveStatements()
  assert.equal(alive.length, 1, `exactly one live statement, got ${alive.map(s => s.statementNumber).join(', ')}`)
  assert.equal(alive[0].id, b.id)
  assert.equal(await portalCount(), 1, 'the contractor sees exactly one live statement')
})

test('FIN-2: even a void of a still-issued predecessor cannot steal the successor\'s index', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  // Force the pathological shape directly: A is still ISSUED, but the period index
  // has already moved to another statement. Voiding A must leave that index alone —
  // the old code deleted it and re-opened the duplicate window.
  kv.set(periodKey(), { value: 'ps_someone_else' })
  const res = await voidStmt(a.id)
  assert.equal(res.status, 200)
  assert.equal(live(periodKey()), 'ps_someone_else', 'a foreign statement id keeps the index')
  assert.equal((await getStatement(a.id))!.status, 'void', 'A is still correctly voided')
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

test('void is idempotent: repeat requests converge and audit exactly once', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  const first = await readJson(await voidStmt(a.id))
  assert.equal(first.ok, true)
  assert.equal(first.alreadyVoid, undefined, 'the first void really voided')

  for (let i = 0; i < 3; i++) {
    const again = await voidStmt(a.id)
    assert.equal(again.status, 200)
    assert.equal((await readJson(again)).alreadyVoid, true)
  }
  assert.equal((await voidEvents()).length, 1, 'one state change → one audit event')
  assert.equal((await liveStatements()).length, 0)
  assert.deepEqual(periodKeys(), [], 'the period stayed free')
})

test('three concurrent voids of one statement converge safely', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  const results = await Promise.all([voidStmt(a.id), voidStmt(a.id), voidStmt(a.id)])

  for (const r of results) assert.ok(r.status === 200 || r.status === 423, `safe status, got ${r.status}`)
  for (const r of results) assert.ok(r.status < 500, 'contention is never a 500')
  const bodies = await Promise.all(results.map(readJson))
  const changed = bodies.filter(b => b.ok && !b.alreadyVoid)
  assert.equal(changed.length, 1, 'exactly one request performed the void')
  assert.equal((await voidEvents()).length, 1, 'no duplicate successful void audit event')
  assert.equal((await getStatement(a.id))!.status, 'void')
  assert.deepEqual(periodKeys(), [])
  assert.deepEqual(lockKeys(), [], 'no orphaned lock')
})

// ─────────────────────────────────────────────────────────────────────────────
// Void ↔ generation share one lock
// ─────────────────────────────────────────────────────────────────────────────

test('void and generate serialize on the same lock — at most one live replacement', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  // Void and two re-issues, all fired together at the same crew+period.
  const [v, g1, g2] = await Promise.all([voidStmt(a.id), generate(), generate()])
  for (const r of [v, g1, g2]) assert.ok(r.status < 500, `no 500s under contention, got ${r.status}`)

  const alive = await liveStatements()
  assert.ok(alive.length <= 1, `at most one live statement, got ${alive.length}`)
  assert.equal(await portalCount(), alive.length)
  assert.deepEqual(lockKeys(), [])
  // Whatever the interleaving, the index and the live record agree.
  const idx = live(periodKey())
  if (alive.length === 1) assert.equal(idx, alive[0].id, 'the index points at the live statement')
  else assert.equal(idx, null, 'no live statement → no index')
})

test('a generation cannot pass the duplicate check while the live statement is indexed', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  // Hold the period lock, then try to generate: it must not create a second live one.
  await withPayStatementLock({ staffId: 'marcus', periodStart: START, periodEnd: END }, async () => {
    const res = await generate()
    assert.equal(res.status, 423, 'blocked while the period is held, never a duplicate')
    assert.equal((await readJson(res)).reason, 'generation_in_progress')
  }, { ttlMs: 5_000 })
  assert.equal((await liveStatements()).length, 1)
  assert.equal(live(periodKey()), a.id)
})

test('void contention: safe 423, no mutation, and the holder\'s lock is left intact', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  const key = payStatementLockKey('marcus', START, END)
  // Another caller holds the period for longer than the void's retry budget.
  kv.set(key, { value: 'another-callers-token', expiresAt: Date.now() + 60_000 })

  const res = await voidStmt(a.id)
  assert.equal(res.status, 423, 'ordinary contention, never a 500')
  const body = await readJson(res)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'statement_busy')

  assert.equal(live(key), 'another-callers-token', 'the holder\'s lock was neither stolen nor released')
  assert.equal((await getStatement(a.id))!.status, 'issued', 'the blocked void changed nothing')
  assert.equal(live(periodKey()), a.id, 'and the period index is untouched')
})

test('void does not block an unrelated crew member or an unrelated period', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  // Hold marcus/week-1 with a void while unrelated work proceeds.
  const [v, otherStaff, otherWeek] = await Promise.all([
    voidStmt(a.id),
    generate('dana'),
    generate('marcus', '2026-07-13', '2026-07-19'),
  ])
  assert.equal(v.status, 200)
  assert.equal(otherStaff.status, 200, 'a different crew member is never blocked')
  assert.equal(otherWeek.status, 200, 'a different period is never blocked')
  assert.equal((await liveStatements('dana')).length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// The compare-and-delete primitive
// ─────────────────────────────────────────────────────────────────────────────

test('releasePeriodIndexIfOwned: frees only its own period', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  const foreign = { id: 'ps_not_this_one', staffId: 'marcus', periodStart: START, periodEnd: END }

  assert.equal(await releasePeriodIndexIfOwned(foreign), false, 'a foreign id cannot free the period')
  assert.equal(live(periodKey()), a.id, 'index untouched')

  assert.equal(await releasePeriodIndexIfOwned(a), true, 'the owner frees it')
  assert.equal(live(periodKey()), null)
  assert.equal(await releasePeriodIndexIfOwned(a), false, 'and a repeat is a no-op, not a delete')
})

// ─────────────────────────────────────────────────────────────────────────────
// Failure & invariants
// ─────────────────────────────────────────────────────────────────────────────

test('a persistence failure during void leaves recoverable, truthful state', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  failOnce = (cmd, key) => cmd === 'SET' && key === `paystmt:${a.id}`     // the void write itself
  await assert.rejects(async () => { await voidStmt(a.id) })

  assert.equal((await getStatement(a.id))!.status, 'issued', 'still issued — no half-void record')
  assert.equal(live(periodKey()), a.id, 'and it still owns its index, so no duplicate can be issued')
  assert.deepEqual(lockKeys(), [], 'the lock was released')
  assert.equal((await generate()).status, 409, 'the duplicate guard is intact')

  const retry = await voidStmt(a.id)                                     // and the void still works
  assert.equal(retry.status, 200)
  assert.equal((await liveStatements()).length, 0)
})

test('invariant: the period index never points at a missing or void statement once settled', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  await voidStmt(a.id)
  const b = (await readJson(await generate())).statement!
  await voidStmt(a.id)                                    // the stale void again
  await voidStmt(b.id)                                    // and a real one
  const c = (await readJson(await generate())).statement!

  for (const k of periodKeys()) {
    const id = live(k)!
    const s = await getStatement(id)
    assert.ok(s, `index ${k} points at a real statement`)
    assert.equal(s!.status, 'issued', `index ${k} points at a LIVE statement`)
  }
  assert.equal(live(periodKey()), c.id)
  assert.equal((await liveStatements()).length, 1)
  assert.equal(await portalCount(), 1)
})

test('void consumes no statement number and never rewrites history', async () => {
  await reset()
  const a = (await readJson(await generate())).statement!
  const counterBefore = live('paystmt:counter')
  const snapshotBefore = JSON.stringify(await getStatement(a.id))

  await voidStmt(a.id); await voidStmt(a.id)
  assert.equal(live('paystmt:counter'), counterBefore, 'void burns no statement number')

  const after = (await getStatement(a.id))!
  assert.equal(after.statementNumber, a.statementNumber, 'the number is unchanged')
  const before = JSON.parse(snapshotBefore) as PayStatement
  for (const k of ['grossCents', 'deductionCents', 'netCents', 'routeCount', 'issuedAt', 'issuedBy'] as const) {
    assert.deepEqual(after[k], before[k], `${k} is immutable across a void`)
  }
  assert.deepEqual(after.lines, before.lines, 'the snapshot lines are immutable')
  assert.deepEqual(after.deductions, before.deductions, 'deductions are immutable')
  assert.equal(after.status, 'void', 'only the status moved')
  // Void statements stay in admin history.
  assert.ok((await listStatements()).some(s => s.id === a.id), 'the voided statement remains in admin history')
  assert.equal(await portalCount(), 0, 'but the crew portal hides it')
})
