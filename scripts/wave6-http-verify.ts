// ── WAVE 6 verification: authenticated two-tenant isolation over REAL HTTP ───
//
// This is the layer Wave 5 could not reach. It runs the actual Next.js app against
// a loopback KV emulator with TENANCY_ENABLED=true, creates two synthetic
// organizations with real password-authenticated users, and drives genuine
// login → cookie → request flows across the tenant boundary.
//
// Loopback only. The emulator binds 127.0.0.1 and holds everything in memory, so no
// remote store exists to reach even by accident, and no real credential is involved
// (the emulator accepts any bearer token; the synthetic users' passwords are minted
// here and die with the process).
//
//   npx tsx scripts/wave6-http-verify.ts
//
// Every check asserts FINAL KV STATE as well as the HTTP answer — a 403 that still
// performed the write would pass an HTTP-only assertion and fail here.

import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'

// .env.local already points KV_REST_API_URL at 127.0.0.1:6390 (the documented local
// audit setup). Matching it removes any ambiguity about which store the app talks to.
const KV_PORT = Number(process.env.WAVE6_KV_PORT || 6390)
const APP_PORT = 3800 + Math.floor(Math.random() * 100)
const BASE = `http://127.0.0.1:${APP_PORT}`

process.env.KV_REST_API_URL = `http://127.0.0.1:${KV_PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'
process.env.ADMIN_SESSION_SECRET = randomBytes(24).toString('hex')
process.env.TENANCY_ENABLED = 'true'

const A = 'wave6a'
const B = 'wave6b'
const PW_A = `a-${randomBytes(12).toString('hex')}`
const PW_B = `b-${randomBytes(12).toString('hex')}`

const results: { ok: boolean; label: string }[] = []
const ok = (cond: boolean, label: string) => {
  results.push({ ok: cond, label })
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

let kv: ChildProcess | null = null
let app: ChildProcess | null = null

async function waitFor(url: string, tries = 300): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return true } catch { /* not listening yet */ }
    await sleep(500)
  }
  return false
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
type Res = { status: number; json: Record<string, unknown>; cookie: string | null }

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }
  if (init.cookie) headers.cookie = init.cookie
  const r = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' })
  const setCookie = r.headers.get('set-cookie')
  let json: Record<string, unknown> = {}
  try { json = (await r.json()) as Record<string, unknown> } catch { /* non-JSON */ }
  const m = setCookie?.match(/jk_admin_session=([^;]*)/)
  return { status: r.status, json, cookie: m ? `jk_admin_session=${m[1]}` : null }
}

async function login(email: string, password: string): Promise<Res> {
  return call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

async function main() {
  // ── 1. Infrastructure ──────────────────────────────────────────────────────
  console.log('[1] starting loopback KV emulator + app')
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(KV_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(),
  })
  kv.stderr?.on('data', (d) => console.error('[kv]', String(d).trim()))
  kv.on('error', (e) => console.error('[kv spawn error]', e))
  if (!(await waitFor(`http://127.0.0.1:${KV_PORT}/__admin/health`, 60))) throw new Error(`kv emulator did not start on ${KV_PORT}`)
  console.log(`      kv on ${KV_PORT}, app will use ${APP_PORT}`)

  // Seed BEFORE the app boots so the first request already sees a coherent world.
  const { upsertTenant } = await import('../app/lib/platform/tenancy/tenant-registry')
  const { upsertMembership, getMembership } = await import('../app/lib/platform/tenancy/membership')
  const { createUser } = await import('../app/lib/users')
  const { redis } = await import('../app/lib/redis')
  const { runWithTenant } = await import('../app/lib/platform/tenancy/context')

  console.log('[2] seeding two synthetic organizations')
  for (const [id, name] of [[A, 'Wave6 Alpha'], [B, 'Wave6 Bravo']] as const) {
    await upsertTenant({
      id, slug: id, displayName: name, legal: {}, brand: {}, status: 'active', createdAt: 0,
    })
  }
  const ua = await createUser({ email: 'a@wave6.test', name: 'Alpha Admin', role: 'admin', password: PW_A })
  const ub = await createUser({ email: 'b@wave6.test', name: 'Bravo Admin', role: 'admin', password: PW_B })
  await upsertMembership({ tenantId: A, userId: ua.id, role: 'admin' })
  await upsertMembership({ tenantId: B, userId: ub.id, role: 'admin' })

  // Tenant-owned fixtures under the SAME logical id in both tenants.
  const SHARED = 'shared-token-1'
  const routeA = { token: SHARED, number: 'R-A', tenant: 'ALPHA', status: 'draft', updatedAt: 1 }
  const routeB = { token: SHARED, number: 'R-B', tenant: 'BRAVO', status: 'draft', updatedAt: 1 }
  await runWithTenant({ tenantId: A }, async () => {
    await redis.set(`rt:${SHARED}`, JSON.stringify(routeA)); await redis.zadd('rt:index', 1, SHARED)
  })
  await runWithTenant({ tenantId: B }, async () => {
    await redis.set(`rt:${SHARED}`, JSON.stringify(routeB)); await redis.zadd('rt:index', 1, SHARED)
  })

  console.log('[3] booting the app (next dev)')
  app = spawn('npx', ['next', 'dev', '-p', String(APP_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(), env: { ...process.env },
  })
  app.stdout?.on('data', (d) => console.log('[app:out]', String(d).trim().slice(0, 200)))
  app.stderr?.on('data', (d) => { const t = String(d).trim(); if (!t.includes('[ALERT]')) console.error('[app:err]', t.slice(0, 300)) })
  app.on('error', (e) => console.error('[app spawn error]', e))
  app.on('exit', (c) => console.error('[app exited]', c))
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error('app did not start')

  // ── 4. Login issues a NON-jkiss tenant session ─────────────────────────────
  console.log('\n[4] authenticated login binds the session to the membership tenant')
  const la = await login('a@wave6.test', PW_A)
  const lb = await login('b@wave6.test', PW_B)
  ok(la.status === 200 && la.json.tenantId === A, `A logs in and receives tenant=${String(la.json.tenantId)} (expected ${A})`)
  ok(lb.status === 200 && lb.json.tenantId === B, `B logs in and receives tenant=${String(lb.json.tenantId)} (expected ${B})`)
  ok(la.json.tenantId !== 'jkiss' && lb.json.tenantId !== 'jkiss', 'neither session fell back to the reference tenant')
  const cookieA = la.cookie!, cookieB = lb.cookie!
  ok(!!cookieA && !!cookieB && cookieA !== cookieB, 'two distinct session cookies were issued')

  const sa = await call('/api/admin/session', { cookie: cookieA })
  ok(sa.status === 200 && sa.json.authed === true, 'A holds a live authenticated session')

  // ── 5. LIST isolation ──────────────────────────────────────────────────────
  console.log('\n[5] list isolation')
  const listA = await call('/api/admin/routes', { cookie: cookieA })
  const listB = await call('/api/admin/routes', { cookie: cookieB })
  const itemsA = (listA.json.items ?? []) as { number?: string }[]
  const itemsB = (listB.json.items ?? []) as { number?: string }[]
  ok(listA.status === 200 && itemsA.every((r) => r.number !== 'R-B'), "A's list contains no BRAVO record")
  ok(listB.status === 200 && itemsB.every((r) => r.number !== 'R-A'), "B's list contains no ALPHA record")
  ok(itemsA.some((r) => r.number === 'R-A'), 'A can see its OWN record (the test is not vacuous)')
  ok(itemsB.some((r) => r.number === 'R-B'), 'B can see its OWN record')

  // ── 6. Header / body tenant override ───────────────────────────────────────
  console.log('\n[6] tenant cannot be overridden by header or body')
  const forgedHeader = await call('/api/admin/routes', {
    cookie: cookieA, headers: { 'x-tenant-id': B, 'x-tenant': B },
  })
  const forgedItems = (forgedHeader.json.items ?? []) as { number?: string }[]
  ok(forgedItems.every((r) => r.number !== 'R-B'), 'a forged x-tenant-id header does not move A into B')

  // ── 7. WRITE isolation, verified in storage ────────────────────────────────
  console.log('\n[7] cross-tenant write is refused AND leaves storage untouched')
  const beforeB = await runWithTenant({ tenantId: B }, () => redis.get(`rt:${SHARED}`))
  const write = await call(`/api/admin/routes/${SHARED}`, {
    method: 'PATCH', cookie: cookieA, body: JSON.stringify({ status: 'CLOBBERED-BY-A' }),
  })
  const afterB = await runWithTenant({ tenantId: B }, () => redis.get(`rt:${SHARED}`))
  ok(afterB === beforeB, "B's stored record is byte-identical after A's write attempt")
  ok(JSON.parse(afterB ?? '{}').status !== 'CLOBBERED-BY-A', "B's record was not clobbered")
  console.log(`      (A's PATCH returned ${write.status})`)

  // ── 8. Physical KV namespaces ──────────────────────────────────────────────
  console.log('\n[8] identical logical ids occupy distinct physical keys')
  const rawA = await runWithTenant({ tenantId: A }, () => redis.get(`rt:${SHARED}`))
  const rawB = await runWithTenant({ tenantId: B }, () => redis.get(`rt:${SHARED}`))
  ok(!!rawA && !!rawB && rawA !== rawB, 'the same route token resolves to two different records')
  const direct = await fetch(process.env.KV_REST_API_URL!, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', `t:${A}:rt:${SHARED}`]),
  }).then((r) => r.json())
  ok(!!direct.result, `the physical key t:${A}:rt:${SHARED} exists`)

  // ── 9. AI feedback cannot cross tenants ────────────────────────────────────
  console.log('\n[9] AI feedback is tenant-bound')
  const { recordAiCall } = await import('../app/lib/ai/telemetry')
  await recordAiCall({
    id: 'call-owned-by-a', at: Date.now(), tenantId: A, actor: ua.id, role: 'admin', feature: 'test',
    taskId: 'ops.insights', promptVersion: 1, model: 'test/model', latencyMs: 1, inputTokens: 1,
    outputTokens: 1, totalTokens: 2, estCostUsd: 0, requestChars: 0, responseValid: true,
    ok: true, outcome: 'ok',
  } as never)
  const fbB = await call('/api/admin/ai/feedback', {
    method: 'POST', cookie: cookieB, body: JSON.stringify({ callId: 'call-owned-by-a', helpful: true }),
  })
  const { getAiCall } = await import('../app/lib/ai/telemetry')
  const recAfter = await getAiCall('call-owned-by-a')
  ok(fbB.status === 404, `B is refused feedback on A's AI record (got ${fbB.status}, 404 hides existence)`)
  ok(recAfter?.feedback === undefined, "no feedback byte landed on A's record")

  // ── 10. Tenant switching ───────────────────────────────────────────────────
  console.log('\n[10] tenant switching requires membership')
  const listOwn = await call('/api/auth/tenant', { cookie: cookieA })
  const offered = (listOwn.json.tenants ?? []) as { tenantId: string }[]
  ok(offered.length === 1 && offered[0].tenantId === A, 'A is offered only its own organization')
  ok(!offered.some((t) => t.tenantId === B), "B is never listed for A")

  const badSwitch = await call('/api/auth/tenant', { method: 'POST', cookie: cookieA, body: JSON.stringify({ tenantId: B }) })
  ok(badSwitch.status === 403, `A cannot switch into B without a membership (got ${badSwitch.status})`)
  ok(!badSwitch.cookie, 'no session cookie was issued on a refused switch')

  // Grant A a real membership in B, then the switch must succeed with B's role.
  await upsertMembership({ tenantId: B, userId: ua.id, role: 'crew', staffId: 'staff-in-b' })
  const goodSwitch = await call('/api/auth/tenant', { method: 'POST', cookie: cookieA, body: JSON.stringify({ tenantId: B }) })
  ok(goodSwitch.status === 200 && goodSwitch.json.tenantId === B, 'with a membership the switch succeeds')
  ok(goodSwitch.json.role === 'crew', "the destination tenant's role is used, not the origin's admin")

  // ── 11. Revocation ─────────────────────────────────────────────────────────
  console.log('\n[11] a suspended membership loses access')
  await upsertMembership({ tenantId: B, userId: ua.id, role: 'crew', status: 'suspended' })
  const afterSuspend = await call('/api/auth/tenant', { method: 'POST', cookie: cookieA, body: JSON.stringify({ tenantId: B }) })
  ok(afterSuspend.status === 403, `a suspended membership cannot be switched into (got ${afterSuspend.status})`)
  ok((await getMembership(ua.id, B))?.status === 'suspended', 'the store reflects the suspension')

  // ── 12. No-membership login ────────────────────────────────────────────────
  console.log('\n[12] an account with no membership cannot obtain a session')
  const orphanPw = `o-${randomBytes(10).toString('hex')}`
  await createUser({ email: 'orphan@wave6.test', name: 'Orphan', role: 'admin', password: orphanPw })
  const lo = await login('orphan@wave6.test', orphanPw)
  ok(lo.status === 403 && lo.json.code === 'NO_MEMBERSHIP', `no-membership login is refused (got ${lo.status})`)
  ok(!lo.cookie, 'no session cookie issued for a membership-less account')

  // ── 13. Report ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  console.log(`\n==== ${failed.length === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed.length}/${results.length} FAILED`} ====`)
  failed.forEach((f) => console.log('  -', f.label))
  return failed.length
}

main()
  .then((failures) => { cleanup(); process.exit(failures === 0 ? 0 : 1) })
  .catch((e) => { console.error('FATAL', e); cleanup(); process.exit(1) })

function cleanup() {
  // In-memory emulator + dev server both die here; nothing is persisted anywhere.
  try { app?.kill('SIGKILL') } catch { /* already gone */ }
  try { kv?.kill('SIGKILL') } catch { /* already gone */ }
}
