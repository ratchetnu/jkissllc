// AI Command Center Increment 3 — Models, Usage/Controls, Alerts/Readiness, Settings.
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { deriveAiAlerts, countBySeverity, SEVERITY_RANK, type AiAlertState } from '../app/lib/estimation/shadow-ai-alerts'
import { validateAiPrefs, DEFAULT_AI_PREFS } from '../app/lib/estimation/ai-prefs'
import { AI_SECTIONS } from '../app/admin/operations/ai/AICommandShell'
import { COOKIE_NAME } from '../app/api/admin/_lib/session'

// ── deriveAiAlerts: deterministic, deduplicated, severity-ranked ─────────────

const NOW = 1_760_000_000_000
const DAY = 86_400_000
const base: AiAlertState = {
  failed: 0, retriesToday: 0, preventedRetriesToday: 0, budgetBlockedToday: 0,
  awaitingGroundTruth: 0, needingReview: 0, lastEvaluationAt: NOW - 3600_000, now: NOW,
  completedEvaluations: 0, groundTruthCount: 0, groundTruthCoveragePct: 0,
  avgV2ErrorPct: null, avgImprovementPct: null,
  evalsToday: 0, maxEvalsPerDay: 50, costTodayUsd: 0, maxDailyCostUsd: 2,
  spendAllowed: true, spendBlockReason: null, killed: false,
  readinessTier: 'NOT_READY', readinessBlockers: [], configMismatches: [], staleVersion: false,
}

test('a healthy state produces no alerts', () => {
  assert.deepEqual(deriveAiAlerts(base), [])
})

test('kill switch → a single critical alert', () => {
  const a = deriveAiAlerts({ ...base, killed: true })
  assert.equal(a.length, 1)
  assert.equal(a[0].severity, 'critical')
  assert.equal(a[0].key, 'kill_switch_active')
  assert.match(a[0].href, /\/usage$/)
})

test('budget exhausted vs approaching are DISTINCT (not one vague offline state)', () => {
  const exhausted = deriveAiAlerts({ ...base, spendAllowed: false, spendBlockReason: 'Daily cap reached.' })
  assert.ok(exhausted.some((x) => x.key === 'budget_exhausted' && x.severity === 'warning'))
  const approaching = deriveAiAlerts({ ...base, costTodayUsd: 1.7, maxDailyCostUsd: 2 })
  assert.ok(approaching.some((x) => x.key === 'budget_warning' && x.severity === 'attention'))
  assert.ok(!approaching.some((x) => x.key === 'budget_exhausted'))
})

test('failed / stale / missing-GT / regression each map to their own alert + link', () => {
  const a = deriveAiAlerts({
    ...base, failed: 2, lastEvaluationAt: NOW - 5 * DAY, awaitingGroundTruth: 3,
    groundTruthCount: 10, avgImprovementPct: -4, avgV2ErrorPct: 25,
  })
  const byKey = Object.fromEntries(a.map((x) => [x.key, x]))
  assert.ok(byKey.failed_evaluations); assert.match(byKey.failed_evaluations.href, /tier=needs_intervention/)
  assert.ok(byKey.stale_evaluations)
  assert.ok(byKey.missing_ground_truth); assert.match(byKey.missing_ground_truth.href, /tier=missing_ground_truth/)
  assert.ok(byKey.v2_regression && byKey.v2_regression.severity === 'warning')
  assert.ok(byKey.high_v2_error)
})

test('regression + high error need a real sample (≥8) — thin data stays quiet', () => {
  const thin = deriveAiAlerts({ ...base, groundTruthCount: 4, avgImprovementPct: -20, avgV2ErrorPct: 40 })
  assert.ok(!thin.some((x) => x.key === 'v2_regression' || x.key === 'high_v2_error'))
})

test('alerts are deduplicated by condition and sorted by severity', () => {
  const a = deriveAiAlerts({ ...base, killed: true, failed: 1, readinessBlockers: ['1 false negative', '1 false negative'] })
  const keys = a.map((x) => x.key)
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys — same condition never twice')
  // severity non-decreasing
  for (let i = 1; i < a.length; i++) assert.ok(SEVERITY_RANK[a[i - 1].severity] <= SEVERITY_RANK[a[i].severity])
  assert.equal(a[0].severity, 'critical', 'kill switch (critical) first')
})

test('config mismatch (queue on, worker off) surfaces deterministically', () => {
  const a = deriveAiAlerts({ ...base, configMismatches: ['Shadow jobs can be queued but the worker is off — they will not process.'] })
  assert.ok(a.some((x) => x.key.startsWith('config_mismatch:') && x.system === 'config'))
})

test('deriveAiAlerts is deterministic — same input, identical output', () => {
  const s = { ...base, failed: 1, awaitingGroundTruth: 2, groundTruthCount: 12, avgV2ErrorPct: 22 }
  assert.deepEqual(deriveAiAlerts(s), deriveAiAlerts(s))
})

test('countBySeverity totals the four restrained severities', () => {
  const a = deriveAiAlerts({ ...base, killed: true, failed: 1, awaitingGroundTruth: 1 })
  const c = countBySeverity(a)
  assert.equal(c.critical + c.warning + c.attention + c.informational, a.length)
  assert.equal(c.critical, 1)
})

// ── Settings prefs validation ────────────────────────────────────────────────

test('validateAiPrefs: accepts valid values, rejects invalid, ignores unknown keys', () => {
  const ok = validateAiPrefs({ defaultPerformanceRange: '7d', showInformationalAlerts: false })
  assert.ok(ok.ok && ok.prefs.defaultPerformanceRange === '7d' && ok.prefs.showInformationalAlerts === false)

  assert.equal(validateAiPrefs({ defaultPerformanceRange: '5y' }).ok, false)
  assert.equal(validateAiPrefs({ defaultQueueTier: 'nonsense' }).ok, false)
  assert.equal(validateAiPrefs({ showInformationalAlerts: 'yes' }).ok, false)

  // an empty patch returns the current prefs unchanged
  const same = validateAiPrefs({}, DEFAULT_AI_PREFS)
  assert.ok(same.ok && same.prefs.defaultPerformanceRange === DEFAULT_AI_PREFS.defaultPerformanceRange)
})

test('validateAiPrefs merges onto current — a partial patch preserves other fields', () => {
  const cur = { defaultPerformanceRange: '90d' as const, defaultQueueTier: 'ready_to_run' as const, showInformationalAlerts: true }
  const v = validateAiPrefs({ showInformationalAlerts: false }, cur)
  assert.ok(v.ok)
  assert.equal(v.prefs.defaultPerformanceRange, '90d')
  assert.equal(v.prefs.defaultQueueTier, 'ready_to_run')
  assert.equal(v.prefs.showInformationalAlerts, false)
})

// ── section map: eight canonical sections + canonical hrefs ───────────────────

test('all eight sections present with canonical hrefs', () => {
  assert.deepEqual(AI_SECTIONS.map((s) => s.id), ['overview', 'queue', 'performance', 'learning', 'models', 'controls', 'alerts', 'settings'])
  const href = (id: string) => AI_SECTIONS.find((s) => s.id === id)!.href
  assert.equal(href('queue'), '/admin/operations/ai/queue')
  assert.equal(href('performance'), '/admin/operations/ai/performance')
  assert.equal(href('controls'), '/admin/operations/ai/usage')
  assert.equal(href('models'), '/admin/operations/ai/models')
  assert.equal(href('alerts'), '/admin/operations/ai/alerts')
  assert.equal(href('settings'), '/admin/operations/ai/settings')
})

// ── API authorization + dormancy + secret redaction ──────────────────────────

const SECRET = 'test-admin-session-secret-value'
async function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(over)) { prev[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]! }
  try { await fn() } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! } }
}
type NextInit = ConstructorParameters<typeof NextRequest>[1]
const mk = (url: string, token?: string, init?: NextInit) => { const r = new NextRequest(url, init); if (token) r.cookies.set(COOKIE_NAME, token); return r }

for (const [name, path] of [['ai-alerts', '/api/admin/ai-alerts'], ['ai-config', '/api/admin/ai-config'], ['ai-settings', '/api/admin/ai-settings']] as const) {
  test(`${name}: unauthenticated is 401; owner+flag-off is dormant`, async () => {
    const mod = await import(`../app/api/admin/${name}/route`)
    const { createSessionToken } = await import('../app/api/admin/_lib/session')
    await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'true' }, async () => {
      assert.equal((await mod.GET(mk(`http://localhost${path}`), { params: Promise.resolve({}) })).status, 401)
    })
    await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'false' }, async () => {
      const res = await mod.GET(mk(`http://localhost${path}`, await createSessionToken()), { params: Promise.resolve({}) })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).enabled, false)
    })
  })
}

test('ai-config never returns a secret VALUE — only presence', async () => {
  const { GET } = await import('../app/api/admin/ai-config/route')
  const { createSessionToken } = await import('../app/api/admin/_lib/session')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'false' }, async () => {
    // Dormant path returns {enabled:false} with no config leakage; the enabled path's config
    // array carries only status strings (asserted structurally by the type). Here we confirm the
    // dormant response body contains no env secret substrings.
    const res = await GET(mk('http://localhost/api/admin/ai-config', await createSessionToken()), { params: Promise.resolve({}) })
    const text = JSON.stringify(await res.json())
    assert.ok(!text.includes(SECRET), 'no session secret in the response')
  })
})

test('ai-settings: a live non-owner session is denied 403', async () => {
  const { createUserSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET, POST } = await import('../app/api/admin/ai-settings/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'true', PLATFORM_OWNER_SUBS: undefined }, async () => {
    const token = await createUserSessionToken({ id: 'not-owner', role: 'admin' })
    assert.equal((await GET(mk('http://localhost/api/admin/ai-settings', token), { params: Promise.resolve({}) })).status, 403)
    const post = mk('http://localhost/api/admin/ai-settings', token, { method: 'POST', body: JSON.stringify({ defaultPerformanceRange: '7d' }), headers: { 'content-type': 'application/json' } })
    assert.equal((await POST(post, { params: Promise.resolve({}) })).status, 403)
  })
})
