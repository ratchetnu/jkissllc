// ─────────────────────────────────────────────────────────────────────────────
// Legacy public route-confirmation surface — Sprint 3 connection treatment.
//
// The audit that produced this change concluded RETAIN AND HARDEN rather than
// redirect or retire, because a route assignee is not guaranteed to have a login:
// a Staff roster record and a User account are separate objects, `staff.email` is
// documented as "contact only", and creating a crew login is a distinct admin
// action (POST /api/admin/users with role='crew' + staffId). The public token is
// therefore the only way an account-less contractor can act on their route, and
// SMS delivers that link in the assignment, reminder, and details messages.
//
// These tests pin the four things that make the retry treatment safe: the verbs
// really are idempotent server-side, the token really is the credential, the token
// really is tenant-bound, and no punch is ever stored for later delivery.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 8700 + (process.pid % 200)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { NextRequest } from 'next/server'
import { saveRoute, getRouteByToken, getRouteByConfirmToken, type RouteRecord, type Assignee } from '../app/lib/routes'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { bindToken } from '../app/lib/platform/tenancy/token-binding'
import { GET, POST } from '../app/api/route/[token]/route'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(async () => { await fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {}) })

// Route + assignee tokens must satisfy /^[a-f0-9]{16,}$/.
const ROUTE_TOK = 'aaaa0000bbbb1111'
const CREW_TOK = 'cccc2222dddd3333'
const OTHER_TOK = 'eeee4444ffff5555'
const TENANT = 'jkiss'

const assignee = (over: Partial<Assignee> = {}): Assignee => ({
  name: 'Sam Contractor', token: CREW_TOK, staffId: 's1', ...over,
} as Assignee)

const mkRoute = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  token: ROUTE_TOK, routeNumber: 'JK-R-9001', status: 'assigned',
  businessName: 'JW Logistics', reportAddress: '1 Commerce St', reportTime: '7:00 AM',
  routeDate: '2030-01-01', events: [], audit: [], createdAt: 1, updatedAt: 1,
  assignees: [assignee()], ...over,
} as RouteRecord)

const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const get = (token: string) => GET(new NextRequest(`http://localhost/api/route/${token}`), ctx(token) as never)
const post = (token: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/route/${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), ctx(token) as never)

const seed = async (r: RouteRecord = mkRoute()) => {
  await runWithTenant({ tenantId: TENANT }, async () => {
    await saveRoute(r)
    await bindToken(r.token, { tenantId: TENANT, resourceType: 'route', resourceId: r.token })
    for (const a of r.assignees ?? []) {
      await bindToken(a.token, { tenantId: TENANT, resourceType: 'route', resourceId: r.token })
    }
  })
  return r
}
const stored = (token: string) => runWithTenant({ tenantId: TENANT }, () => getRouteByToken(token))

// ── Authorization: the token IS the credential ───────────────────────────────

test('AUTHZ: an unknown token is 404, and never reveals that the route exists', async () => {
  await seed()
  const res = await get('9999888877776666')
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'not_found' })
})

test('AUTHZ: a malformed token is refused without reaching the store', async () => {
  await seed()
  for (const bad of ['not-a-token!!', 'short', '../../etc/passwd', '']) {
    const res = await get(bad)
    assert.equal(res.status, 404, `${JSON.stringify(bad)} must be refused`)
  }
})

test('AUTHZ: a valid assignee token resolves to that assignee only', async () => {
  await seed(mkRoute({ assignees: [assignee(), assignee({ name: 'Other Crew', token: OTHER_TOK, staffId: 's2' })] }))
  const res = await get(CREW_TOK)
  assert.equal(res.status, 200)
  const { route } = await res.json()
  assert.equal(route.routeNumber, 'JK-R-9001')
  // The scrubbed projection must not carry the other contractor or any audit trail.
  const raw = JSON.stringify(route)
  assert.equal(raw.includes('Other Crew'), false, 'never exposes another contractor')
  assert.equal(raw.includes(OTHER_TOK), false, "never exposes another contractor's token")
  assert.equal(raw.includes('audit'), false, 'never exposes the audit trail')
})

test('AUTHZ: a token bound to a DIFFERENT resource type is refused', async () => {
  await seed()
  await runWithTenant({ tenantId: TENANT }, () =>
    bindToken(OTHER_TOK, { tenantId: TENANT, resourceType: 'booking', resourceId: OTHER_TOK }))
  const res = await get(OTHER_TOK)
  assert.equal(res.status, 404, "a booking token must not open the route surface (expect: 'route')")
})

test('AUTHZ: clocking and completing are refused before the route is confirmed', async () => {
  await seed()
  for (const action of ['clock_in', 'complete']) {
    const res = await post(CREW_TOK, { action })
    assert.equal(res.status, 409, `${action} requires confirmation first`)
  }
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockInAt, undefined, 'nothing was written')
})

// ── Idempotency: what makes an automatic retry safe ──────────────────────────

test('RETRY-SAFE: confirm replayed returns already and writes no second event', async () => {
  await seed()
  const first = await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  assert.equal(first.status, 200)
  const afterFirst = (await stored(ROUTE_TOK))!
  const stamp = afterFirst.assignees![0].confirmedAt
  const events = afterFirst.events!.length

  const replay = await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).already, true, 'a replay reports already, not a new confirm')

  const after = (await stored(ROUTE_TOK))!
  assert.equal(after.assignees![0].confirmedAt, stamp, 'the FIRST confirmation timestamp survives')
  assert.equal(after.events!.length, events, 'no duplicate event')
})

test('RETRY-SAFE: decline replayed returns already and keeps the first reason', async () => {
  await seed()
  assert.equal((await post(CREW_TOK, { action: 'decline', reason: 'first' })).status, 200)
  const stamp = (await stored(ROUTE_TOK))!.assignees![0].declinedAt

  const replay = await post(CREW_TOK, { action: 'decline', reason: 'second' })
  assert.equal((await replay.json()).already, true)
  const after = (await stored(ROUTE_TOK))!
  assert.equal(after.assignees![0].declinedAt, stamp)
  assert.equal(after.assignees![0].declineReason, 'first', 'a replay cannot rewrite the reason')
})

test('RETRY-SAFE: each punch is guarded by its own stamp; the FIRST time persists', async () => {
  await seed()
  await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })

  assert.equal((await post(CREW_TOK, { action: 'clock_in', locationDenied: true })).status, 200)
  const inAt = (await stored(ROUTE_TOK))!.assignees![0].clockInAt
  assert.ok(inAt, 'clocked in')

  const replayIn = await post(CREW_TOK, { action: 'clock_in', locationDenied: true })
  assert.equal((await replayIn.json()).already, true)
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockInAt, inAt,
    'a replayed punch must never move the recorded work time')

  assert.equal((await post(CREW_TOK, { action: 'clock_out', locationDenied: true })).status, 200)
  const outAt = (await stored(ROUTE_TOK))!.assignees![0].clockOutAt
  const replayOut = await post(CREW_TOK, { action: 'clock_out', locationDenied: true })
  assert.equal((await replayOut.json()).already, true)
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockOutAt, outAt)
})

test('RETRY-SAFE: completion is status-idempotent, so a replay cannot restamp it', async () => {
  await seed()
  await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  assert.equal((await post(CREW_TOK, { action: 'complete', note: 'first' })).status, 200)
  const first = (await stored(ROUTE_TOK))!
  const completedAt = first.completedAt

  const replay = await post(CREW_TOK, { action: 'complete', note: 'second' })
  assert.equal((await replay.json()).already, true)
  const after = (await stored(ROUTE_TOK))!
  assert.equal(after.completedAt, completedAt, 'the first completion time survives')
  assert.equal(after.completionNote, 'first', 'a replay cannot rewrite the note')
})

// ── Tenancy: the token carries its own scope ─────────────────────────────────

test('TENANCY: a token bound to another tenant does not open this route', async () => {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = 'true'
  try {
    await seed()
    // Same token shape, bound to a DIFFERENT tenant: resolution must not fall back
    // to the ambient tenant or to an unscoped read.
    await runWithTenant({ tenantId: 'other' }, () =>
      bindToken(OTHER_TOK, { tenantId: 'other', resourceType: 'route', resourceId: OTHER_TOK }))
    const res = await get(OTHER_TOK)
    assert.equal(res.status, 404, 'a foreign-tenant token resolves to nothing here')
  } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev
  }
})

test('TENANCY: the handler is wrapped so its body runs inside the token’s tenant', () => {
  const src = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  assert.match(src, /withPublicTokenRoute\(/, 'both verbs are tenant-wrapped')
  assert.equal((src.match(/withPublicTokenRoute\(/g) ?? []).length, 2, 'GET and POST')
  assert.equal((src.match(/\{ expect: 'route' \}/g) ?? []).length, 2,
    'both refuse a token minted for another surface')
})

// ── Compatibility: existing contractor links keep working ────────────────────

test('COMPATIBILITY: the wire contract for an existing link is unchanged', async () => {
  await seed()
  const res = await get(CREW_TOK)
  assert.equal(res.status, 200)
  const body = await res.json()
  // The shape an already-delivered SMS link depends on.
  assert.ok(body.route, 'route projection present')
  assert.equal(typeof body.disclaimer, 'string', 'disclaimer still returned')
  for (const f of ['token', 'routeNumber', 'status', 'businessName', 'reportAddress', 'reportTime', 'routeDate', 'dispatchReady']) {
    assert.ok(f in body.route, `PublicRoute still carries ${f}`)
  }
  // And every verb an existing link can invoke still answers.
  await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  for (const action of ['clock_in', 'clock_out', 'complete']) {
    const r = await post(CREW_TOK, { action, locationDenied: true })
    assert.ok(r.status === 200 || r.status === 409, `${action} still handled (got ${r.status})`)
  }
})

test('COMPATIBILITY: link_opened is still stamped on first open', async () => {
  await seed()
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].linkOpenedAt, undefined)
  await get(CREW_TOK)
  const after = await getRouteByConfirmToken(CREW_TOK).catch(() => null)
    ?? await runWithTenant({ tenantId: TENANT }, () => getRouteByConfirmToken(CREW_TOK))
  assert.ok(after?.assignee.linkOpenedAt, 'first open is recorded')
})

// ── The client contract: retry allowlist and no queued punches ───────────────

test('CLIENT: only the four idempotent verbs may retry; completion may not', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /RETRY_SAFE_ACTIONS = new Set\(\['confirm', 'decline', 'clock_in', 'clock_out'\]\)/)
  assert.doesNotMatch(src, /RETRY_SAFE_ACTIONS = new Set\(\[[^\]]*'complete'/, 'completion is not retry-safe here')
  // Every mutation decides via the allowlist — never a bare `true`.
  const calls = src.match(/allowMutationRetry: [^,\n]+/g) ?? []
  assert.ok(calls.length >= 3, 'each mutation states its retry stance')
  for (const c of calls) {
    assert.match(c, /RETRY_SAFE_ACTIONS\.has\(/, `must consult the allowlist, got: ${c}`)
  }
})

test('CLIENT: offline refuses a punch outright and NEVER queues it', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|serviceWorker/,
    'a stored punch would record the reconnect time as the work time')
  assert.doesNotMatch(src, /\bqueue\b/i, 'nothing is deferred for later delivery')
  // The punch path refuses before it sets a busy flag, so a refusal cannot strand
  // the controls in a permanently-disabled state.
  const clockFn = src.slice(src.indexOf('async function clock('), src.indexOf('async function submitComplete('))
  assert.match(clockFn, /if \(offline\)[\s\S]{0,200}return/, 'offline is refused first')
  assert.ok(clockFn.indexOf('if (offline)') < clockFn.indexOf('setClocking(action)'),
    'the refusal precedes the busy flag')
})

test('CLIENT: going offline keeps the route visible and disables every action', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /if \(!offline\) void load\(\)/, 'reloads on reconnect, not on going offline')
  assert.doesNotMatch(src, /setRoute\(null\)/, 'offline never discards the loaded route')
  assert.match(src, /You’re offline\. Your route stays visible/)
  assert.match(src, /aria-live="polite"/, 'the retry notice is announced')
  // Confirm, decline, both punches, the picker and the completion submit all refuse.
  assert.ok((src.match(/\|\| offline/g) ?? []).length >= 6, 'every action control is gated on offline')
  // A dropped read must not be reported as a dead link. That classification moved
  // into app/route/[token]/load.ts and is proven behaviourally against an injected
  // fetcher in scripts/public-route-load-classification.test.ts — this string
  // assertion used to vouch for a message the user never actually saw, because the
  // render guard was `notFound || !route`.
  assert.match(src, /if \(notFound\) return wrap\(/, 'missing-link card is gated on a real 404 alone')
  assert.doesNotMatch(src, /if \(notFound \|\| !route\)/, 'the defect this replaced')
})
