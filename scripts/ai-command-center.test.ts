// AI Command Center (Increment 1) — nav consolidation, section map, overview API.
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { NAV_ITEMS, visibleNav } from '../app/admin/operations/nav-config'
import { AI_SECTIONS } from '../app/admin/operations/ai/AICommandShell'
import { COOKIE_NAME } from '../app/api/admin/_lib/session'

// ── navigation consolidation ─────────────────────────────────────────────────

test('nav: exactly ONE AI entry, the Command Center; the old three are gone', () => {
  const aiItems = NAV_ITEMS.filter((n) => n.href.startsWith('/admin/operations/ai'))
  assert.equal(aiItems.length, 1, 'only one top-level AI destination')
  assert.equal(aiItems[0].href, '/admin/operations/ai')
  assert.equal(aiItems[0].label, 'AI Command Center')
  for (const gone of ['/admin/operations/ai/shadow', '/admin/operations/ai/learning', '/admin/operations/ai/alerts']) {
    assert.ok(!NAV_ITEMS.some((n) => n.href === gone), `${gone} must not be a top-level nav entry`)
  }
})

test('nav: the Command Center is owner-only, hidden from every non-owner', () => {
  const item = NAV_ITEMS.find((n) => n.href === '/admin/operations/ai')!
  assert.equal(item.ownerOnly, true)
  assert.equal(item.adminOnly, true)
  assert.ok(visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true }).some((n) => n.href === '/admin/operations/ai'))
  for (const ctx of [{ role: 'admin', isOwner: false }, { role: 'manager', isOwner: false }, { role: 'crew', isOwner: false }]) {
    assert.ok(!visibleNav(NAV_ITEMS, ctx).some((n) => n.href === '/admin/operations/ai'), `${ctx.role} must not see it`)
  }
})

test('section map: the nine spec sections, unique ids, overview first, all under /ai', () => {
  assert.deepEqual(AI_SECTIONS.map((s) => s.id), ['overview', 'queue', 'performance', 'pipeline', 'learning', 'models', 'controls', 'alerts', 'settings'])
  assert.equal(new Set(AI_SECTIONS.map((s) => s.id)).size, 9)
  for (const s of AI_SECTIONS) assert.ok(s.href.startsWith('/admin/operations/ai'), `${s.id} href is under the Command Center`)
})

// ── overview API: auth, dormancy, zero-AI ────────────────────────────────────

const SECRET = 'test-admin-session-secret-value'
async function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(over)) { prev[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]! }
  try { await fn() } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! } }
}
type NextInit = ConstructorParameters<typeof NextRequest>[1]
const req = (token?: string, init?: NextInit) => {
  const r = new NextRequest('http://localhost/api/admin/ai-overview', init)
  if (token) r.cookies.set(COOKIE_NAME, token)
  return r
}

test('ai-overview: unauthenticated is 401, before the flag is consulted', async () => {
  const { GET } = await import('../app/api/admin/ai-overview/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'true' }, async () => {
    const res = await GET(req(), { params: Promise.resolve({}) })
    assert.equal(res.status, 401)
  })
})

test('ai-overview: a live non-owner session is denied 403, not merely hidden', async () => {
  const { createUserSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET } = await import('../app/api/admin/ai-overview/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'true', PLATFORM_OWNER_SUBS: undefined }, async () => {
    for (const role of ['admin', 'manager', 'crew'] as const) {
      const token = await createUserSessionToken({ id: `not-owner-${role}`, role })
      assert.equal((await GET(req(token), { params: Promise.resolve({}) })).status, 403, role)
    }
  })
})

test('ai-overview: owner reaches it, but the flag keeps it dormant — no store read, no AI', async () => {
  const { createSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET } = await import('../app/api/admin/ai-overview/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'false' }, async () => {
    const res = await GET(req(await createSessionToken()), { params: Promise.resolve({}) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.enabled, false)
    // Dormant path returns before any Redis read — reaching Redis would throw (unconfigured in tests).
    assert.equal(body.readiness, undefined)
  })
})
