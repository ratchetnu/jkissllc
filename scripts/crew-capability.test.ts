// Crew capability wave — time corrections + flexible compensation.
//
// Three invariants carry the whole feature:
//   1. the ORIGINAL punch is never rewritten (there is no code path that writes
//      clockInAt/clockOutAt — corrections live in their own keyspace);
//   2. ONE effective model decides payable time and payable amount, so the
//      timesheet, payroll and the crew portal cannot disagree;
//   3. an unresolved configuration is a visible GAP, never a silent $0.
//
// Real route handlers against an in-memory Upstash fake. No Production data.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'   // both lanes visible, as in production Preview

const UPSTASH = 'http://fake-upstash.local'
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
      const nx = flags.includes('NX'); const pxAt = flags.indexOf('PX')
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
      const script = String(args[0]); const n = Number(args[1]); const k = args[2]; const token = args[2 + n]
      const owns = live(k) === token
      if (/pexpire/i.test(script)) {
        if (owns) { kv.set(k, { value: token, expiresAt: Date.now() + Number(args[3 + n]) }); result = 1 } else result = 0
      } else { if (owns) kv.delete(k); result = owns ? 1 : 0 }
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { GET as correctionsGET, POST as correctionsPOST } from '../app/api/admin/time-corrections/route'
import { GET as timesheetsGET } from '../app/api/admin/timesheets/route'
import { saveStaff } from '../app/lib/staff'
import { saveRoute, generateToken, type RouteRecord } from '../app/lib/routes'
import { listAudit } from '../app/lib/audit'
import { computePay } from '../app/lib/route-pay'
import {
  punchId, parsePunchId, effectivePunch, validateCorrection, listCorrections,
  MAX_PUNCH_MINUTES, type TimeCorrection,
} from '../app/lib/time-corrections'
import {
  assignmentId, validateCompensation, resolveCompensation, payableForAssignment,
  appendSnapshot, listSnapshots, currentSnapshot, detectAmbiguousAllocations,
  crewVisibleCompensation, MAX_HOURLY_RATE_CENTS, type CompensationSnapshot,
} from '../app/lib/crew-compensation'

const CTX = { params: Promise.resolve({} as Record<string, string>) }
const DAY = (d: string, h: number, m = 0) => Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
const MON = '2026-07-06', TUE = '2026-07-07', WED = '2026-07-08'

let adminCookie = '', managerCookie = '', crewCookie = ''
let routeToken = ''

const post = (body: unknown, cookie: string) => new NextRequest('http://localhost/api/admin/time-corrections', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` }, body: JSON.stringify(body),
})
const get = (url: string, cookie: string) => new NextRequest(url, { headers: { cookie: `jk_admin_session=${cookie}` } })

const mkRoute = (token: string, num: string, date: string, assignees: RouteRecord['assignees']): RouteRecord => ({
  token, routeNumber: num, status: 'completed', businessName: 'Acme',
  reportAddress: '1 Main St', reportTime: '8:00 AM', routeDate: date, events: [], audit: [],
  createdAt: 1, updatedAt: 1, assignees,
} as unknown as RouteRecord)

const crewA = (over: Record<string, unknown> = {}) => ({
  staffId: 'marcus', name: 'Marcus', role: 'Driver', token: generateToken(),
  clockInAt: DAY(MON, 8), clockOutAt: DAY(MON, 16), payCents: 17500, pay: '$175.00', paySource: 'crew_default',
  ...over,
} as never)

async function reset() {
  kv.clear(); zsets.clear(); failOnce = null
  adminCookie = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  managerCookie = await createUserSessionToken({ id: 'u_mgr', role: 'manager' })
  crewCookie = await createUserSessionToken({ id: 'u_marcus', role: 'crew', staffId: 'marcus' })
  await saveStaff({ id: 'marcus', name: 'Marcus', phone: '+15550001', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
  await saveStaff({ id: 'dana', name: 'Dana', phone: '+15550002', role: 'Driver', active: true, createdAt: 1, updatedAt: 1 })
  routeToken = generateToken()
  await saveRoute(mkRoute(routeToken, 'JK-R-3001', MON, [crewA()]))
}
const PID = () => punchId('route', routeToken, 'marcus')
const AID = () => assignmentId('route', routeToken, 'marcus')
type Body = { ok: boolean; error?: string; reason?: string; errors?: { field: string }[]; correction?: TimeCorrection; corrections?: TimeCorrection[]; version?: number; entries?: never[]; canCorrect?: boolean; periodTotalMinutes?: number }
const readJson = async (r: Response) => await r.json() as Body

const correct = (body: Record<string, unknown>, cookie = adminCookie) =>
  correctionsPOST(post({ punchId: PID(), correctionReason: 'Forgot to clock out', ...body }, cookie), CTX)

// ─────────────────────────────────────────────────────────────────────────────
// Punch identity + effective model (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('a punch has a stable derived identity (there is no punch entity to version)', () => {
  const id = punchId('route', 'tok123', 'marcus')
  assert.equal(id, 'route:tok123:marcus')
  assert.deepEqual(parsePunchId(id), { workType: 'route', jobToken: 'tok123', staffId: 'marcus' })
  assert.equal(parsePunchId('nonsense'), null)
  assert.throws(() => punchId('route', '', 'marcus'))
  assert.notEqual(punchId('route', 'tok', 'a'), punchId('booking', 'tok', 'a'))
})

test('effectivePunch: latest ACTIVE correction wins; otherwise the original', () => {
  const original = { clockInAt: 100, clockOutAt: 200 }
  assert.deepEqual(effectivePunch(original, []), { clockInAt: 100, clockOutAt: 200, corrected: false, correctionCount: 0 })

  const c = (over: Partial<TimeCorrection>): TimeCorrection => ({
    correctionId: 'c1', punchId: 'p', staffId: 's', workType: 'route', jobToken: 't',
    originalClockIn: 100, originalClockOut: 200, previousEffectiveClockIn: 100, previousEffectiveClockOut: 200,
    correctedClockIn: 150, correctedClockOut: 250, correctionReason: 'r', correctedByUserId: 'u',
    correctedByRole: 'admin', correctedAt: 1_000, status: 'active', version: 1, ...over,
  })
  const one = effectivePunch(original, [c({})])
  assert.deepEqual([one.clockInAt, one.clockOutAt, one.corrected], [150, 250, true])

  // A superseded record is history, not the answer.
  const two = effectivePunch(original, [
    c({ correctionId: 'c1', status: 'superseded', correctedAt: 1_000 }),
    c({ correctionId: 'c2', status: 'active', correctedAt: 2_000, correctedClockIn: 300, correctedClockOut: 400, version: 2 }),
  ])
  assert.deepEqual([two.clockInAt, two.clockOutAt, two.correctionCount], [300, 400, 2])

  // Reversed corrections fall back to the original.
  const rev = effectivePunch(original, [c({ status: 'reversed' })])
  assert.deepEqual([rev.clockInAt, rev.corrected], [100, false])
})

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

test('correction validation covers every documented rule', () => {
  const cur = { effectiveClockIn: DAY(MON, 8), effectiveClockOut: DAY(MON, 16) }
  const base = { correctedClockIn: DAY(MON, 9), correctedClockOut: DAY(MON, 17), correctionReason: 'fix' }

  const bad = (patch: Record<string, unknown>, field: string) => {
    const r = validateCorrection({ ...base, ...patch }, cur)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.errors.some(e => e.field === field), `expected an error on ${field}`)
  }
  bad({ correctionReason: '   ' }, 'correctionReason')
  bad({ correctedClockIn: 'nope' }, 'correctedClockIn')
  bad({ correctedClockIn: -5 }, 'correctedClockIn')
  bad({ correctedClockOut: DAY(MON, 7) }, 'correctedClockOut')                       // out before in
  bad({ correctedClockOut: DAY(MON, 9) + (MAX_PUNCH_MINUTES + 1) * 60_000 }, 'correctedClockOut')
  bad({ correctedClockIn: cur.effectiveClockIn, correctedClockOut: cur.effectiveClockOut }, 'correctedClockIn')  // unchanged

  const ok = validateCorrection(base, cur)
  assert.equal(ok.ok, true)
  // An open punch is legitimate: clock-out may be omitted.
  const open = validateCorrection({ ...base, correctedClockOut: null }, cur)
  assert.equal(open.ok, true)
  assert.equal(open.ok && open.value.correctedClockOut, null)
})

// ─────────────────────────────────────────────────────────────────────────────
// Permissions — enforced server-side, not by hiding controls
// ─────────────────────────────────────────────────────────────────────────────

test('admin and manager may correct; crew and anonymous may not', async () => {
  await reset()
  assert.equal((await correct({ correctedClockIn: DAY(MON, 9) }, adminCookie)).status, 200)
  assert.equal((await correct({ correctedClockIn: DAY(MON, 10) }, managerCookie)).status, 200)

  const crewWrite = await correct({ correctedClockIn: DAY(MON, 11) }, crewCookie)
  assert.equal(crewWrite.status, 403, 'crew is read-only on the write API')
  const crewRead = await correctionsGET(get(`http://localhost/api/admin/time-corrections?punchId=${PID()}`, crewCookie), CTX)
  assert.equal(crewRead.status, 403, 'and on the management history API')

  const anon = await correctionsPOST(new NextRequest('http://localhost/api/admin/time-corrections', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ punchId: PID(), correctedClockIn: 1 }),
  }), CTX)
  assert.equal(anon.status, 401)
})

test('a punch that does not exist in this tenant is not addressable', async () => {
  await reset()
  const other = await correctionsPOST(post({
    punchId: punchId('route', generateToken(), 'marcus'), correctedClockIn: DAY(MON, 9), correctionReason: 'x',
  }, adminCookie), CTX)
  assert.equal(other.status, 404, 'another tenant\'s (or a bogus) punch resolves to nothing')
  assert.equal((await correctionsPOST(post({ punchId: 'garbage', correctedClockIn: 1, correctionReason: 'x' }, adminCookie), CTX)).status, 400)
})

test('the timesheet tells the UI whether to offer the row action — and the API still enforces it', async () => {
  await reset()
  const asAdmin = await readJson(await timesheetsGET(get('http://localhost/api/admin/timesheets', adminCookie), CTX))
  assert.equal(asAdmin.canCorrect, true)
  const asManager = await readJson(await timesheetsGET(get('http://localhost/api/admin/timesheets', managerCookie), CTX))
  assert.equal(asManager.canCorrect, true)
  const asCrew = await timesheetsGET(get('http://localhost/api/admin/timesheets', crewCookie), CTX)
  assert.equal(asCrew.status, 403, 'crew never reaches the admin timesheet at all')
})

// ─────────────────────────────────────────────────────────────────────────────
// Correction integrity — append-only, original immutable
// ─────────────────────────────────────────────────────────────────────────────

test('the ORIGINAL punch is never rewritten and history is append-only', async () => {
  await reset()
  const { getRouteByToken } = await import('../app/lib/routes')

  await correct({ correctedClockIn: DAY(MON, 9), correctedClockOut: DAY(MON, 17) })
  await correct({ correctedClockIn: DAY(MON, 10), correctedClockOut: DAY(MON, 18) })

  const route = await getRouteByToken(routeToken)
  const a = route!.assignees![0]
  assert.equal(a.clockInAt, DAY(MON, 8), 'the stored punch is untouched')
  assert.equal(a.clockOutAt, DAY(MON, 16))

  const history = await listCorrections(PID())
  assert.equal(history.length, 2, 'both corrections are kept')
  const [first, second] = history
  assert.equal(first.status, 'superseded')
  assert.equal(second.status, 'active')
  assert.equal(second.supersedesCorrectionId, first.correctionId)
  assert.equal(second.version, 2)
  // Every record carries the original AND the effective value it replaced.
  assert.equal(second.originalClockIn, DAY(MON, 8))
  assert.equal(second.previousEffectiveClockIn, DAY(MON, 9))
  assert.equal(first.previousEffectiveClockIn, DAY(MON, 8))
})

test('the timesheet reports EFFECTIVE time, duration and period total', async () => {
  await reset()
  const before = await readJson(await timesheetsGET(get('http://localhost/api/admin/timesheets', adminCookie), CTX))
  assert.equal(before.periodTotalMinutes, 480, '8h original')

  await correct({ correctedClockIn: DAY(MON, 8), correctedClockOut: DAY(MON, 18) })
  const after = await readJson(await timesheetsGET(get('http://localhost/api/admin/timesheets', adminCookie), CTX))
  assert.equal(after.periodTotalMinutes, 600, '10h effective after the correction')

  const e = (after.entries as unknown as { corrected: boolean; clockInAt: number; originalClockOutAt: number; clockOutAt: number; correctionCount: number }[])[0]
  assert.equal(e.corrected, true, 'the row is flagged for the Corrected badge')
  assert.equal(e.clockOutAt, DAY(MON, 18), 'effective value')
  assert.equal(e.originalClockOutAt, DAY(MON, 16), 'original kept beside it')
  assert.equal(e.correctionCount, 1)
})

test('an open punch may be corrected and stays excluded from payable totals', async () => {
  await reset()
  await saveRoute(mkRoute(routeToken, 'JK-R-3001', MON, [crewA({ clockInAt: DAY(MON, 8), clockOutAt: undefined })]))
  const res = await correct({ correctedClockIn: DAY(MON, 7), correctedClockOut: null })
  assert.equal(res.status, 200)

  const sheet = await readJson(await timesheetsGET(get('http://localhost/api/admin/timesheets', adminCookie), CTX))
  const e = (sheet.entries as unknown as { status: string; clockInAt: number; durationMinutes: number | null }[])[0]
  assert.equal(e.status, 'open', 'still on the clock')
  assert.equal(e.clockInAt, DAY(MON, 7), 'with the corrected start')
  assert.equal(e.durationMinutes, null)
  assert.equal(sheet.periodTotalMinutes, 0, 'open punches never enter payable totals')
})

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency
// ─────────────────────────────────────────────────────────────────────────────

test('a stale editor is refused with 409 rather than clobbering a newer correction', async () => {
  await reset()
  await correct({ correctedClockIn: DAY(MON, 9) })                        // version 1
  const stale = await correct({ correctedClockIn: DAY(MON, 11), expectedVersion: 0 })
  assert.equal(stale.status, 409)
  const body = await readJson(stale)
  assert.equal(body.reason, 'stale_version')
  const history = await listCorrections(PID())
  assert.equal(history.length, 1, 'the stale attempt wrote nothing')
})

test('duplicate rapid submissions create exactly one correction', async () => {
  await reset()
  const payload = { correctedClockIn: DAY(MON, 9), correctedClockOut: DAY(MON, 17) }
  const results = await Promise.all([correct(payload), correct(payload), correct(payload)])
  for (const r of results) assert.ok(r.status < 500, `no 500s, got ${r.status}`)
  assert.equal(results.filter(r => r.status === 200).length, 1, 'one winner')
  const history = await listCorrections(PID())
  assert.equal(history.length, 1, 'and exactly one record')
  assert.deepEqual([...kv.keys()].filter(k => k.startsWith('tcorr:lock:')), [], 'no orphaned lock')
})

test('unrelated punches never block each other', async () => {
  await reset()
  const other = generateToken()
  await saveRoute(mkRoute(other, 'JK-R-3002', TUE, [crewA({ staffId: 'dana', name: 'Dana', clockInAt: DAY(TUE, 8), clockOutAt: DAY(TUE, 12) })]))
  const [a, b] = await Promise.all([
    correct({ correctedClockIn: DAY(MON, 9) }),
    correctionsPOST(post({ punchId: punchId('route', other, 'dana'), correctedClockIn: DAY(TUE, 9), correctionReason: 'fix' }, adminCookie), CTX),
  ])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
})

test('a failed write leaves no partial correction state', async () => {
  await reset()
  failOnce = (cmd, key) => cmd === 'SET' && key.startsWith('tcorr:tc_')
  await assert.rejects(async () => { await correct({ correctedClockIn: DAY(MON, 9) }) })
  assert.deepEqual(await listCorrections(PID()), [], 'nothing indexed')
  assert.deepEqual([...kv.keys()].filter(k => k.startsWith('tcorr:lock:')), [], 'lock released')
  assert.equal((await correct({ correctedClockIn: DAY(MON, 9) })).status, 200, 'and a retry works')
})

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

test('one audit event per correction; a supersede records both; failures record none', async () => {
  await reset()
  await correct({ correctedClockIn: DAY(MON, 9) })
  let created = (await listAudit()).filter(e => e.action === 'time.correction.created')
  assert.equal(created.length, 1)
  assert.equal(created[0].entity, 'time_punch')
  assert.equal(created[0].actor, 'u_admin')
  assert.equal(created[0].outcome, 'success')

  await correct({ correctedClockIn: DAY(MON, 10) }, managerCookie)
  created = (await listAudit()).filter(e => e.action === 'time.correction.created')
  const superseded = (await listAudit()).filter(e => e.action === 'time.correction.superseded')
  assert.equal(created.length, 2)
  assert.equal(superseded.length, 1, 'the prior record\'s fate is auditable on its own')
  assert.equal(created.find(e => e.actor === 'u_mgr')?.actorRole, 'manager')

  const before = (await listAudit()).length
  await correct({ correctedClockIn: 'bad' as never })                      // rejected
  assert.equal((await listAudit()).length, before, 'a blocked action emits no successful event')
})

// ─────────────────────────────────────────────────────────────────────────────
// Compensation — validation, precedence, snapshots
// ─────────────────────────────────────────────────────────────────────────────

test('compensation validation: mode decides the amount; both together is an error', () => {
  const bad = (input: Record<string, unknown>, field: string) => {
    const r = validateCompensation(input as never)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.errors.some(e => e.field === field), `expected error on ${field}`)
  }
  bad({ compensationMode: 'weekly' }, 'compensationMode')
  bad({ compensationMode: 'hourly' }, 'hourlyRateCents')                   // missing rate
  bad({ compensationMode: 'route_flat' }, 'flatRoutePayCents')             // missing amount
  bad({ compensationMode: 'hourly', hourlyRateCents: -100 }, 'hourlyRateCents')
  bad({ compensationMode: 'hourly', hourlyRateCents: 22.5 }, 'hourlyRateCents')   // not integer cents
  bad({ compensationMode: 'hourly', hourlyRateCents: MAX_HOURLY_RATE_CENTS + 1 }, 'hourlyRateCents')
  bad({ compensationMode: 'route_flat', flatRoutePayCents: 'lots' }, 'flatRoutePayCents')
  // Supplying both is rejected outright rather than silently ignoring one.
  bad({ compensationMode: 'hourly', hourlyRateCents: 2200, flatRoutePayCents: 12000 }, 'compensationMode')

  const ok = validateCompensation({ compensationMode: 'hourly', hourlyRateCents: 2200 })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.value.compensationSource, 'assignment_override', 'defaults to the assignment')
})

test('precedence: snapshot beats legacy pay; legacy beats nothing; nothing is a GAP not $0', () => {
  const ctx = { staffId: 'marcus', workType: 'route' as const, jobToken: 't', serviceDate: MON }
  const snap = {
    compensationSnapshotId: 'cs1', staffId: 'marcus', workType: 'route', jobToken: 't', serviceDate: MON,
    compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override',
    configuredByUserId: 'u', configuredByRole: 'admin', configuredAt: 1, effectiveAt: 1, snapshotVersion: 1,
  } as CompensationSnapshot

  const withSnap = resolveCompensation(snap, { payCents: 17500, paySource: 'crew_default' }, ctx)
  assert.equal(withSnap.ok && withSnap.snapshot.compensationMode, 'hourly', 'the assignment override wins')

  const legacy = resolveCompensation(null, { payCents: 17500, paySource: 'crew_business' }, ctx)
  assert.equal(legacy.ok && legacy.snapshot.compensationMode, 'route_flat')
  assert.equal(legacy.ok && legacy.snapshot.flatRoutePayCents, 17500)
  assert.equal(legacy.ok && legacy.snapshot.compensationSource, 'business_rule', 'legacy source is mapped, not guessed')

  const crewDefault = resolveCompensation(null, { payCents: 15000, paySource: 'crew_default' }, ctx)
  assert.equal(crewDefault.ok && crewDefault.snapshot.compensationSource, 'crew_default')

  const nothing = resolveCompensation(null, null, ctx)
  assert.equal(nothing.ok, false)
  assert.equal(!nothing.ok && nothing.gap, 'no_compensation_configured')
})

test('payable: flat pays once and ignores hours; hourly uses effective minutes', () => {
  const ctx = { staffId: 'm', workType: 'route' as const, jobToken: 't', serviceDate: MON }
  const flat = resolveCompensation(null, { payCents: 12000, paySource: 'manual' }, ctx)
  const flat8 = payableForAssignment({ compensation: flat, effectiveMinutes: 480, punchComplete: true })
  const flat10 = payableForAssignment({ compensation: flat, effectiveMinutes: 600, punchComplete: true })
  assert.equal(flat8.ok && flat8.amountCents, 12000)
  assert.equal(flat10.ok && flat10.amountCents, 12000, 'more hours do NOT change a flat route amount')
  const flatOpen = payableForAssignment({ compensation: flat, effectiveMinutes: null, punchComplete: false })
  assert.equal(flatOpen.ok && flatOpen.amountCents, 12000, 'flat pays without a punch at all')

  const hourly = resolveCompensation({
    compensationSnapshotId: 'cs', staffId: 'm', workType: 'route', jobToken: 't', serviceDate: MON,
    compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override',
    configuredByUserId: 'u', configuredByRole: 'admin', configuredAt: 1, effectiveAt: 1, snapshotVersion: 1,
  } as CompensationSnapshot, null, ctx)
  const h8 = payableForAssignment({ compensation: hourly, effectiveMinutes: 480, punchComplete: true })
  assert.equal(h8.ok && h8.amountCents, 17600, '8h × $22 = $176.00')
  const h90 = payableForAssignment({ compensation: hourly, effectiveMinutes: 90, punchComplete: true })
  assert.equal(h90.ok && h90.amountCents, 3300, '1.5h × $22 = $33.00 (rounded once, at the end)')

  const open = payableForAssignment({ compensation: hourly, effectiveMinutes: null, punchComplete: false })
  assert.equal(open.ok, false)
  assert.equal(!open.ok && open.gap, 'hourly_punch_incomplete', 'an open hourly punch is a GAP, never $0')

  const ambiguous = payableForAssignment({ compensation: hourly, effectiveMinutes: 480, punchComplete: true, ambiguousAllocation: true })
  assert.equal(!ambiguous.ok && ambiguous.gap, 'ambiguous_time_allocation')
})

test('overlapping hourly assignments for one crew member are flagged, never split by guess', () => {
  const flagged = detectAmbiguousAllocations([
    { assignmentId: 'a1', staffId: 'm', serviceDate: MON, mode: 'hourly', clockInAt: DAY(MON, 8), clockOutAt: DAY(MON, 12) },
    { assignmentId: 'a2', staffId: 'm', serviceDate: MON, mode: 'hourly', clockInAt: DAY(MON, 11), clockOutAt: DAY(MON, 15) },
    { assignmentId: 'a3', staffId: 'm', serviceDate: MON, mode: 'hourly', clockInAt: DAY(MON, 16), clockOutAt: DAY(MON, 18) },
    { assignmentId: 'a4', staffId: 'd', serviceDate: MON, mode: 'hourly', clockInAt: DAY(MON, 8), clockOutAt: DAY(MON, 12) },
    { assignmentId: 'a5', staffId: 'm', serviceDate: MON, mode: 'route_flat', clockInAt: DAY(MON, 8), clockOutAt: DAY(MON, 12) },
  ])
  assert.deepEqual([...flagged].sort(), ['a1', 'a2'], 'only the overlapping HOURLY pair for the same person')
})

test('snapshots are append-only, versioned, and stale writes are refused', async () => {
  await reset()
  const actor = { sub: 'u_admin', role: 'admin' }
  const base = { staffId: 'marcus', workType: 'route' as const, jobToken: routeToken, serviceDate: MON, actor }

  const first = await appendSnapshot({ ...base, value: { compensationMode: 'route_flat', flatRoutePayCents: 12000, compensationSource: 'assignment_override' }, now: 1_000 })
  assert.equal(first.ok, true)
  const second = await appendSnapshot({ ...base, value: { compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override' }, now: 2_000, expectedVersion: 1 })
  assert.equal(second.ok, true)

  const history = await listSnapshots(AID())
  assert.equal(history.length, 2, 'the prior terms are preserved')
  const cur = currentSnapshot(history)!
  assert.equal(cur.compensationMode, 'hourly')
  assert.equal(cur.snapshotVersion, 2)
  assert.equal(cur.supersedesSnapshotId, first.ok ? first.snapshot.compensationSnapshotId : '')
  assert.equal(history[0].compensationMode, 'route_flat', 'history still shows what was agreed first')

  const stale = await appendSnapshot({ ...base, value: { compensationMode: 'hourly', hourlyRateCents: 9900, compensationSource: 'assignment_override' }, now: 3_000, expectedVersion: 1 })
  assert.equal(stale.ok, false)
  assert.equal(!stale.ok && stale.currentVersion, 2)
  assert.equal((await listSnapshots(AID())).length, 2, 'the stale write appended nothing')
})

test('crew-visible compensation omits internal reasoning', () => {
  const s = {
    compensationSnapshotId: 'cs', staffId: 'm', workType: 'route', jobToken: 't', serviceDate: MON,
    compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override',
    configuredByUserId: 'u_admin', configuredByRole: 'admin', configuredAt: 1, effectiveAt: 1, snapshotVersion: 1,
    reason: 'negotiated', note: 'internal: watch overtime',
  } as CompensationSnapshot
  const view = crewVisibleCompensation(s)!
  assert.deepEqual(Object.keys(view).sort(), ['hourlyRateCents', 'mode'])
  const json = JSON.stringify(view)
  assert.ok(!/internal|negotiated|u_admin|assignment_override/.test(json), 'no management-only fields leak to crew')
})

// ─────────────────────────────────────────────────────────────────────────────
// Payroll integration — one effective model end to end
// ─────────────────────────────────────────────────────────────────────────────

async function snapshotFor(token: string, staffId: string, date: string, value: Parameters<typeof appendSnapshot>[0]['value']) {
  return appendSnapshot({
    staffId, workType: 'route', jobToken: token, serviceDate: date,
    value, actor: { sub: 'u_admin', role: 'admin' }, now: Date.now(),
  })
}

test('backward compatibility: with no snapshots and no corrections, pay is unchanged', async () => {
  await reset()
  const pay = await computePay(MON, '2026-07-12')
  const m = pay.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m.grossCents, 17500, 'the legacy flat payCents still pays exactly what it paid')
  assert.equal(pay.compensationGaps, undefined, 'and nothing is flagged')
})

test('hourly pay uses the CORRECTED effective duration', async () => {
  await reset()
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override' })

  let pay = await computePay(MON, '2026-07-12')
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 17600, '8h × $22')

  await correct({ correctedClockIn: DAY(MON, 8), correctedClockOut: DAY(MON, 18) })
  pay = await computePay(MON, '2026-07-12')
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 22000, '10h × $22 after the correction')
})

test('a time correction does NOT change a flat route amount', async () => {
  await reset()
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'route_flat', flatRoutePayCents: 12000, compensationSource: 'assignment_override' })
  await correct({ correctedClockIn: DAY(MON, 6), correctedClockOut: DAY(MON, 20) })   // 14h recorded

  const pay = await computePay(MON, '2026-07-12')
  const m = pay.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m.grossCents, 12000, 'flat stays flat')
  assert.equal(m.routes[0].workedMinutes, 840, 'but the recorded hours DO reflect the correction')
})

test('an open hourly punch is a payroll GAP, never $0', async () => {
  await reset()
  await saveRoute(mkRoute(routeToken, 'JK-R-3001', MON, [crewA({ clockInAt: DAY(MON, 8), clockOutAt: undefined })]))
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override' })

  const pay = await computePay(MON, '2026-07-12')
  const m = pay.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m.grossCents, 0, 'nothing payable yet')
  assert.equal(m.unpricedCount, 1, 'surfaced as unpriced, not paid as zero')
  assert.equal(pay.compensationGaps?.[0].reason, 'hourly_punch_incomplete')
  assert.equal(pay.compensationGaps?.[0].staffName, 'Marcus')
})

test('the same crew member: flat Monday, flat Tuesday, hourly Wednesday — each independent', async () => {
  await reset()
  const monT = routeToken, tueT = generateToken(), wedT = generateToken()
  await saveRoute(mkRoute(tueT, 'JK-R-3002', TUE, [crewA({ clockInAt: DAY(TUE, 8), clockOutAt: DAY(TUE, 16) })]))
  await saveRoute(mkRoute(wedT, 'JK-R-3003', WED, [crewA({ clockInAt: DAY(WED, 9), clockOutAt: DAY(WED, 15) })]))

  await snapshotFor(monT, 'marcus', MON, { compensationMode: 'route_flat', flatRoutePayCents: 12000, compensationSource: 'assignment_override' })
  await snapshotFor(tueT, 'marcus', TUE, { compensationMode: 'route_flat', flatRoutePayCents: 15000, compensationSource: 'assignment_override' })
  await snapshotFor(wedT, 'marcus', WED, { compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override' })

  const pay = await computePay(MON, '2026-07-12')
  const m = pay.contractors.find(c => c.staffId === 'marcus')!
  const byNumber = new Map(m.routes.map(r => [r.routeNumber, r.amountCents]))
  assert.equal(byNumber.get('JK-R-3001'), 12000, 'Monday $120 flat')
  assert.equal(byNumber.get('JK-R-3002'), 15000, 'Tuesday $150 flat')
  assert.equal(byNumber.get('JK-R-3003'), 13200, 'Wednesday 6h × $22')
  assert.equal(m.grossCents, 40200, 'mixed hourly + flat totals combine correctly')
  assert.equal(m.count, 3, 'no assignment counted twice')
})

test('two crew members on ONE route can be paid differently', async () => {
  await reset()
  await saveRoute(mkRoute(routeToken, 'JK-R-3001', MON, [
    crewA(),
    crewA({ staffId: 'dana', name: 'Dana', payCents: undefined, pay: undefined, clockInAt: DAY(MON, 8), clockOutAt: DAY(MON, 14) }),
  ]))
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'route_flat', flatRoutePayCents: 12000, compensationSource: 'assignment_override' })
  await snapshotFor(routeToken, 'dana', MON, { compensationMode: 'hourly', hourlyRateCents: 2500, compensationSource: 'assignment_override' })

  const pay = await computePay(MON, '2026-07-12')
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 12000, 'Marcus: flat')
  assert.equal(pay.contractors.find(c => c.staffId === 'dana')!.grossCents, 15000, 'Dana: 6h × $25 — her own terms')
})

test('one crew member\'s snapshot never pays another crew member', async () => {
  await reset()
  await saveRoute(mkRoute(routeToken, 'JK-R-3001', MON, [
    crewA(),
    crewA({ staffId: 'dana', name: 'Dana', payCents: undefined, pay: undefined }),
  ]))
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'route_flat', flatRoutePayCents: 99000, compensationSource: 'assignment_override' })

  const pay = await computePay(MON, '2026-07-12')
  assert.equal(pay.contractors.find(c => c.staffId === 'marcus')!.grossCents, 99000)
  const dana = pay.contractors.find(c => c.staffId === 'dana')!
  assert.equal(dana.grossCents, 0, 'Dana does not inherit Marcus\'s terms')
  assert.ok(pay.compensationGaps?.some(g => g.staffId === 'dana' && g.reason === 'no_compensation_configured'),
    'she is a visible gap instead')
})

test('overlapping hourly assignments become a gap rather than paying the same minutes twice', async () => {
  await reset()
  const second = generateToken()
  await saveRoute(mkRoute(second, 'JK-R-3009', MON, [crewA({ clockInAt: DAY(MON, 12), clockOutAt: DAY(MON, 20) })]))
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'hourly', hourlyRateCents: 2000, compensationSource: 'assignment_override' })
  await snapshotFor(second, 'marcus', MON, { compensationMode: 'hourly', hourlyRateCents: 2000, compensationSource: 'assignment_override' })

  const pay = await computePay(MON, '2026-07-12')
  const m = pay.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m.grossCents, 0, 'neither overlapping assignment pays until an operator resolves it')
  assert.equal(pay.compensationGaps?.filter(g => g.reason === 'ambiguous_time_allocation').length, 2)
})

test('deductions still apply once over a mixed hourly + flat period', async () => {
  await reset()
  const { saveClaim } = await import('../app/lib/claims')
  const wedT = generateToken()
  await saveRoute(mkRoute(wedT, 'JK-R-3003', WED, [crewA({ clockInAt: DAY(WED, 9), clockOutAt: DAY(WED, 15) })]))
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'route_flat', flatRoutePayCents: 20000, compensationSource: 'assignment_override' })
  await snapshotFor(wedT, 'marcus', WED, { compensationMode: 'hourly', hourlyRateCents: 2000, compensationSource: 'assignment_override' })
  await saveClaim({
    id: 'clm_1', claimNumber: 'JK-C-9001', businessName: 'Acme', businessKey: 'acme', routeNumber: 'JK-R-3001',
    status: 'open', createdAt: 1, updatedAt: 1,
    assignments: [{ staffId: 'marcus', name: 'Marcus', responsibilityCents: 50000, status: 'active',
      ledger: [{ id: 'e1', at: 1, kind: 'scheduled', direction: 'credit', amountCents: 5000, periodDate: MON, actor: 'test' }] }],
  } as never)

  const pay = await computePay(MON, '2026-07-12')
  const m = pay.contractors.find(c => c.staffId === 'marcus')!
  assert.equal(m.grossCents, 32000, '$200 flat + 6h × $20')
  assert.equal(m.deductionCents, 5000)
  assert.equal(m.appliedCents, 5000, 'applied exactly once')
  assert.equal(m.netCents, 27000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Compensation API — permissions, validation, concurrency
// ─────────────────────────────────────────────────────────────────────────────

test('compensation writes require pay:configure; crew and manager cannot set money', async () => {
  await reset()
  const { POST: compPOST, GET: compGET } = await import('../app/api/admin/crew-compensation/route')
  const body = (over: Record<string, unknown> = {}) => ({
    assignmentId: AID(), compensationMode: 'hourly', hourlyRateCents: 2200, ...over,
  })
  const req = (b: unknown, cookie: string) => new NextRequest('http://localhost/api/admin/crew-compensation', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` }, body: JSON.stringify(b),
  })

  assert.equal((await compPOST(req(body({ reason: 'set rate' }), adminCookie), CTX)).status, 200, 'admin may configure')
  assert.equal((await compPOST(req(body(), managerCookie), CTX)).status, 403, 'manager submits adjustments, never sets rates')
  assert.equal((await compPOST(req(body(), crewCookie), CTX)).status, 403, 'crew never')
  assert.equal((await compPOST(new NextRequest('http://localhost/api/admin/crew-compensation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()),
  }), CTX)).status, 401, 'anonymous never')

  // Reading the configuration is a pay:view:all surface (admin + not crew).
  const url = `http://localhost/api/admin/crew-compensation?assignmentId=${encodeURIComponent(AID())}`
  assert.equal((await compGET(get(url, adminCookie), CTX)).status, 200)
  assert.equal((await compGET(get(url, crewCookie), CTX)).status, 403)
})

test('changing pay on a COMPLETED job requires a reason, and stale writes are refused', async () => {
  await reset()
  const { POST: compPOST } = await import('../app/api/admin/crew-compensation/route')
  const req = (b: unknown) => new NextRequest('http://localhost/api/admin/crew-compensation', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${adminCookie}` }, body: JSON.stringify(b),
  })
  // The seeded route is status 'completed'.
  const noReason = await compPOST(req({ assignmentId: AID(), compensationMode: 'route_flat', flatRoutePayCents: 12000 }), CTX)
  assert.equal(noReason.status, 400)
  assert.equal((await readJson(noReason)).reason, 'reason_required')

  const ok = await compPOST(req({ assignmentId: AID(), compensationMode: 'route_flat', flatRoutePayCents: 12000, reason: 'agreed flat rate' }), CTX)
  assert.equal(ok.status, 200)

  const stale = await compPOST(req({ assignmentId: AID(), compensationMode: 'hourly', hourlyRateCents: 3000, reason: 'again', expectedVersion: 0 }), CTX)
  assert.equal(stale.status, 409)
  assert.equal((await readJson(stale)).reason, 'stale_version')
  assert.equal((await listSnapshots(AID())).length, 1, 'the stale write appended nothing')
})

test('duplicate rapid compensation submissions create exactly one snapshot', async () => {
  await reset()
  const { POST: compPOST } = await import('../app/api/admin/crew-compensation/route')
  const payload = { assignmentId: AID(), compensationMode: 'hourly', hourlyRateCents: 2200, reason: 'set', expectedVersion: 0 }
  const req = () => new NextRequest('http://localhost/api/admin/crew-compensation', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${adminCookie}` }, body: JSON.stringify(payload),
  })
  const results = await Promise.all([compPOST(req(), CTX), compPOST(req(), CTX), compPOST(req(), CTX)])
  for (const r of results) assert.ok(r.status < 500, `no 500s, got ${r.status}`)
  assert.equal(results.filter(r => r.status === 200).length, 1, 'one winner')
  assert.equal((await listSnapshots(AID())).length, 1)
  assert.deepEqual([...kv.keys()].filter(k => k.startsWith('comp:lock:')), [], 'no orphaned lock')
})

test('one audit event per compensation change; blocked attempts record none', async () => {
  await reset()
  const { POST: compPOST } = await import('../app/api/admin/crew-compensation/route')
  const req = (b: unknown, cookie = adminCookie) => new NextRequest('http://localhost/api/admin/crew-compensation', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` }, body: JSON.stringify(b),
  })
  await compPOST(req({ assignmentId: AID(), compensationMode: 'hourly', hourlyRateCents: 2200, reason: 'initial' }), CTX)
  let events = (await listAudit()).filter(e => e.action === 'crew.compensation.set')
  assert.equal(events.length, 1)
  assert.equal(events[0].meta?.previousMode, null)
  assert.equal(events[0].meta?.newAmountCents, 2200)
  assert.equal(events[0].meta?.afterCompletion, true, 'a change after completion is recorded as such')

  await compPOST(req({ assignmentId: AID(), compensationMode: 'route_flat', flatRoutePayCents: 30000, reason: 'switch to flat' }), CTX)
  events = (await listAudit()).filter(e => e.action === 'crew.compensation.set')
  assert.equal(events.length, 2)
  const latest = events.find(e => e.meta?.newMode === 'route_flat')!
  assert.equal(latest.meta?.previousMode, 'hourly', 'the mode change is auditable')
  assert.equal(latest.meta?.previousAmountCents, 2200)

  const before = (await listAudit()).length
  await compPOST(req({ assignmentId: AID(), compensationMode: 'hourly' }), CTX)      // invalid: no rate
  assert.equal((await listAudit()).length, before, 'a rejected change emits nothing')
})

// ─────────────────────────────────────────────────────────────────────────────
// Crew portal must agree with Admin payroll
// ─────────────────────────────────────────────────────────────────────────────

test('crew portal earnings equal Admin payroll for the same effective assignments', async () => {
  await reset()
  const { setFinanceSettings } = await import('../app/lib/finance')
  await setFinanceSettings({ showPayInConfirm: true })
  await snapshotFor(routeToken, 'marcus', MON, { compensationMode: 'hourly', hourlyRateCents: 2200, compensationSource: 'assignment_override' })
  await correct({ correctedClockIn: DAY(MON, 8), correctedClockOut: DAY(MON, 18) })   // 10h effective

  const admin = await computePay(MON, '2026-07-12')
  const adminCents = admin.contractors.find(c => c.staffId === 'marcus')!.grossCents
  assert.equal(adminCents, 22000, '10h × $22 in Admin payroll')

  const { GET: portalPayGET } = await import('../app/api/portal/pay/route')
  const portal = await (await portalPayGET(get('http://localhost/api/portal/pay', crewCookie), CTX)).json() as
    { ok: boolean; visible: boolean; summary: { lifetimeEarningsCents: number } }
  assert.equal(portal.visible, true)
  assert.equal(portal.summary.lifetimeEarningsCents, adminCents,
    'the crew member sees exactly what payroll will pay — hourly, corrected, one model')
})
