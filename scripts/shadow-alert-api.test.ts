// Operion Shadow Alerting (Increment 2) — filters, authorization, dormancy, audit wiring.
//
// Two layers:
//  • PURE: the filter/facet/summary/export module — no I/O, exact assertions.
//  • ROUTE: the real handlers, invoked directly with minted sessions, asserting the
//    authorization decision and the flag gate happen BEFORE any work.
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import {
  applyAlertFilter, alertFacets, summarizeAlerts, sortAlerts, parseAlertFilter,
  alertsToCsv, alertToExportRow, prettyPolicyType,
} from '../app/lib/estimation/shadow-alert-filters'
import type { ShadowAlert, AlertSeverity, AlertPolicyType } from '../app/lib/estimation/shadow-alert-types'
import { SHADOW_ALERT_AUDIT_ACTIONS, isShadowAlertAuditAction } from '../app/lib/platform/updates/audit'
import { NAV_ITEMS, visibleNav } from '../app/admin/operations/nav-config'
import { isPlatformOwner, COOKIE_NAME } from '../app/api/admin/_lib/session'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

// ── fixtures ─────────────────────────────────────────────────────────────────

let n = 0
function alert(over: Partial<ShadowAlert> = {}): ShadowAlert {
  return {
    alertVersion: 1, id: over.id ?? `SAL-${1000 + n++}`,
    policyId: over.policyId ?? 'agreement-rate-drop',
    policyType: over.policyType ?? 'agreement_rate_drop',
    severity: over.severity ?? 'WARNING',
    status: over.status ?? 'OPEN',
    dedupKey: over.dedupKey ?? 'agreement-rate-drop:global',
    scopeKey: over.scopeKey ?? 'global',
    reason: over.reason ?? 'Agreement rate fell.',
    observed: over.observed ?? 50, threshold: over.threshold ?? 10, comparison: over.comparison ?? 100,
    sampleSize: over.sampleSize ?? 30,
    model: over.model, deployment: over.deployment, business: over.business,
    firstDetectedAt: over.firstDetectedAt ?? NOW - DAY,
    lastDetectedAt: over.lastDetectedAt ?? NOW,
    occurrences: over.occurrences ?? 1,
    acknowledgedBy: over.acknowledgedBy, resolvedBy: over.resolvedBy, resolvedReason: over.resolvedReason,
    escalatedAt: over.escalatedAt, mutedUntil: over.mutedUntil,
    relatedBookingIds: over.relatedBookingIds ?? [],
    relatedTraceIds: over.relatedTraceIds ?? [],
    readiness: over.readiness ?? null,
    notes: over.notes ?? [],
    unread: over.unread ?? true,
    deliveredChannels: over.deliveredChannels,
  }
}

const CRIT = { severity: 'CRITICAL' as AlertSeverity, policyType: 'critical_false_negative' as AlertPolicyType, policyId: 'critical-false-negative' }

// ── filtering ────────────────────────────────────────────────────────────────

test('applyAlertFilter: each dimension narrows independently', () => {
  const alerts = [
    alert({ id: 'a', ...CRIT, status: 'OPEN', model: 'a/one', deployment: 'a/one|1|2' }),
    alert({ id: 'b', severity: 'WARNING', status: 'RESOLVED', model: 'b/two', deployment: 'b/two|2|2' }),
    alert({ id: 'c', severity: 'INFO', policyType: 'readiness_milestone_reached', status: 'OPEN', model: 'a/one' }),
  ]
  const ids = (f: Parameters<typeof applyAlertFilter>[1]) => applyAlertFilter(alerts, f).map((x) => x.id)
  assert.deepEqual(ids({}), ['a', 'b', 'c'], 'an empty filter narrows nothing')
  assert.deepEqual(ids({ severity: 'CRITICAL' }), ['a'])
  assert.deepEqual(ids({ status: 'OPEN' }), ['a', 'c'])
  assert.deepEqual(ids({ policyType: 'critical_false_negative' }), ['a'])
  assert.deepEqual(ids({ model: 'a/one' }), ['a', 'c'])
  assert.deepEqual(ids({ deployment: 'b/two|2|2' }), ['b'])
  assert.deepEqual(ids({ severity: 'CRITICAL', status: 'RESOLVED' }), [], 'dimensions AND together')
})

test('applyAlertFilter: minSeverity is a floor, not an equality match', () => {
  const alerts = [
    alert({ id: 'crit', severity: 'CRITICAL' }), alert({ id: 'err', severity: 'ERROR' }),
    alert({ id: 'warn', severity: 'WARNING' }), alert({ id: 'info', severity: 'INFO' }),
  ]
  assert.deepEqual(applyAlertFilter(alerts, { minSeverity: 'INFO' }).map((a) => a.id), ['crit', 'err', 'warn', 'info'])
  assert.deepEqual(applyAlertFilter(alerts, { minSeverity: 'WARNING' }).map((a) => a.id), ['crit', 'err', 'warn'])
  assert.deepEqual(applyAlertFilter(alerts, { minSeverity: 'CRITICAL' }).map((a) => a.id), ['crit'])
})

test('applyAlertFilter: search spans reason, id, policy, and related bookings', () => {
  const alerts = [
    alert({ id: 'SAL-2000', reason: 'V2 auto-quoted booking abc123.', relatedBookingIds: ['abc123'] }),
    alert({ id: 'SAL-2001', reason: 'Latency regressed.', policyId: 'latency-regression' }),
  ]
  const q = (s: string) => applyAlertFilter(alerts, { q: s }).map((a) => a.id)
  assert.deepEqual(q('abc123'), ['SAL-2000'], 'finds by related booking id')
  assert.deepEqual(q('SAL-2001'), ['SAL-2001'], 'finds by alert id')
  assert.deepEqual(q('LATENCY'), ['SAL-2001'], 'case-insensitive')
  assert.deepEqual(q('auto-quoted'), ['SAL-2000'], 'searches the reason text')
  assert.deepEqual(q('nothing-here'), [])
})

test('applyAlertFilter: unread and date range', () => {
  const alerts = [
    alert({ id: 'old', lastDetectedAt: NOW - 10 * DAY, unread: false }),
    alert({ id: 'new', lastDetectedAt: NOW - HOUR, unread: true }),
  ]
  assert.deepEqual(applyAlertFilter(alerts, { unread: true }).map((a) => a.id), ['new'])
  assert.deepEqual(applyAlertFilter(alerts, { unread: false }).map((a) => a.id), ['old'])
  assert.deepEqual(applyAlertFilter(alerts, { from: NOW - 2 * DAY }).map((a) => a.id), ['new'])
  assert.deepEqual(applyAlertFilter(alerts, { to: NOW - 2 * DAY }).map((a) => a.id), ['old'], 'upper bound is exclusive')
})

test('sortAlerts: severity first, then most recent — the worst thing sits on top', () => {
  const alerts = [
    alert({ id: 'info-new', severity: 'INFO', lastDetectedAt: NOW }),
    alert({ id: 'crit-old', severity: 'CRITICAL', lastDetectedAt: NOW - 10 * DAY }),
    alert({ id: 'warn-new', severity: 'WARNING', lastDetectedAt: NOW }),
    alert({ id: 'crit-new', severity: 'CRITICAL', lastDetectedAt: NOW - HOUR }),
  ]
  assert.deepEqual(sortAlerts(alerts).map((a) => a.id), ['crit-new', 'crit-old', 'warn-new', 'info-new'])
})

test('sortAlerts does not mutate its input', () => {
  const alerts = [alert({ id: 'a', severity: 'INFO' }), alert({ id: 'b', severity: 'CRITICAL' })]
  const before = alerts.map((a) => a.id)
  sortAlerts(alerts)
  assert.deepEqual(alerts.map((a) => a.id), before)
})

// ── facets + summary ─────────────────────────────────────────────────────────

test('alertFacets: counts every dimension; business stays empty (inert today)', () => {
  const alerts = [
    alert({ ...CRIT, model: 'a/one', deployment: 'a/one|1|2' }),
    alert({ severity: 'WARNING', model: 'a/one', deployment: 'a/one|1|2' }),
    alert({ severity: 'INFO', model: 'b/two' }),
  ]
  const f = alertFacets(alerts)
  assert.deepEqual(f.severities.map((s) => [s.value, s.count]).sort(), [['CRITICAL', 1], ['INFO', 1], ['WARNING', 1]])
  assert.deepEqual(f.models[0], { value: 'a/one', label: 'one', count: 2 }, 'sorted by frequency, label is the short name')
  assert.equal(f.deployments[0].count, 2)
  assert.deepEqual(f.businesses, [], 'V2ShadowJob has no businessId — this dimension is plumbing, not a filter')
})

test('summarizeAlerts: statuses, unread, escalated, and the badge number', () => {
  const alerts = [
    alert({ ...CRIT, status: 'OPEN', unread: true }),
    alert({ ...CRIT, status: 'ACKNOWLEDGED', unread: false, escalatedAt: NOW }),
    alert({ severity: 'WARNING', status: 'OPEN', unread: true }),
    alert({ severity: 'INFO', status: 'RESOLVED', unread: false }),
    alert({ severity: 'INFO', status: 'MUTED', unread: false }),
    alert({ severity: 'INFO', status: 'EXPIRED', unread: false, lastDetectedAt: NOW - 30 * DAY }),
  ]
  const s = summarizeAlerts(alerts)
  assert.equal(s.total, 6)
  assert.equal(s.open, 2)
  assert.equal(s.acknowledged, 1)
  assert.equal(s.resolved, 1)
  assert.equal(s.muted, 1)
  assert.equal(s.expired, 1)
  assert.equal(s.active, 3, 'OPEN + ACKNOWLEDGED still demand attention')
  assert.equal(s.unread, 2)
  assert.equal(s.escalated, 1)
  assert.equal(s.openCritical, 1, 'an ACKNOWLEDGED critical is no longer on the badge')
  assert.deepEqual(s.bySeverity, { CRITICAL: 2, ERROR: 0, WARNING: 1, INFO: 3 })
  assert.equal(s.lastDetectedAt, NOW)
})

test('summarizeAlerts: empty set is all zeros, not a crash', () => {
  const s = summarizeAlerts([])
  assert.equal(s.total, 0)
  assert.equal(s.openCritical, 0)
  assert.equal(s.lastDetectedAt, null)
  assert.deepEqual(s.bySeverity, { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 })
})

// ── query parsing ────────────────────────────────────────────────────────────

test('parseAlertFilter: valid values through, invalid values dropped (never 500)', () => {
  const f = parseAlertFilter(new URLSearchParams(
    'severity=CRITICAL&status=OPEN&policyType=critical_false_negative&model=a/one&q=%20hi%20&unread=1&from=100&to=200'))
  assert.deepEqual(f, {
    severity: 'CRITICAL', minSeverity: undefined, policyType: 'critical_false_negative', status: 'OPEN',
    model: 'a/one', deployment: undefined, business: undefined, unread: true, q: 'hi', from: 100, to: 200,
  })

  // Garbage in a query string is an attacker or a typo, never a reason to fail the page.
  const bad = parseAlertFilter(new URLSearchParams('severity=NUCLEAR&status=WAT&policyType=made_up&from=abc&unread=maybe'))
  assert.deepEqual(bad, {
    severity: undefined, minSeverity: undefined, policyType: undefined, status: undefined,
    model: undefined, deployment: undefined, business: undefined, unread: undefined, q: undefined,
    from: undefined, to: undefined,
  })
})

test('parseAlertFilter: unread accepts both 1/0 and true/false', () => {
  assert.equal(parseAlertFilter(new URLSearchParams('unread=true')).unread, true)
  assert.equal(parseAlertFilter(new URLSearchParams('unread=false')).unread, false)
  assert.equal(parseAlertFilter(new URLSearchParams('unread=0')).unread, false)
})

// ── export ───────────────────────────────────────────────────────────────────

test('alertsToCsv: stable headers even when empty, and commas/quotes escaped', () => {
  const headers = alertsToCsv([]).split('\n')[0]
  assert.match(headers, /^id,severity,status,policy,scope,model,deployment,reason,observed,threshold,baseline/)

  const csv = alertsToCsv([alert({ id: 'SAL-9', reason: 'Agreement fell, badly, and "fast".' })])
  const line = csv.split('\n')[1]
  assert.ok(line.includes('"Agreement fell, badly, and ""fast""."'), 'commas and quotes must be escaped')
  assert.equal(alertsToCsv([]).split('\n').length, 1, 'empty export is headers only')
})

test('alertToExportRow carries evidence about the model, never model output about a customer', () => {
  const row = alertToExportRow(alert({ id: 'SAL-9', relatedBookingIds: ['b1', 'b2'] }))
  assert.equal(row.id, 'SAL-9')
  assert.equal(row.relatedBookings, 'b1 b2')
  const keys = Object.keys(row)
  // The export references evaluations by id; it never inlines what the model said about
  // anyone's property.
  for (const forbidden of ['result', 'estimate', 'photos', 'customerSafeSummary', 'internalOwnerSummary']) {
    assert.ok(!keys.includes(forbidden), `export must not carry ${forbidden}`)
  }
})

test('prettyPolicyType is human-readable', () => {
  assert.equal(prettyPolicyType('critical_false_negative'), 'Critical false negative')
})

// ── audit wiring ─────────────────────────────────────────────────────────────

test('every owner transition has a real audit action in the platform union', () => {
  // Increment 1 emits these strings; the union must actually contain them, so the route
  // never has to cast them through `as never` and lose type safety.
  for (const a of ['shadow_alert.acknowledged', 'shadow_alert.resolved', 'shadow_alert.muted',
                   'shadow_alert.unmuted', 'shadow_alert.note_added', 'shadow_alert.read']) {
    assert.ok(isShadowAlertAuditAction(a), `${a} must be a declared PlatformAuditAction`)
  }
  assert.equal(SHADOW_ALERT_AUDIT_ACTIONS.length, 6)
  assert.equal(isShadowAlertAuditAction('promotion.merged'), false, 'unrelated actions are not alert actions')
  assert.equal(isShadowAlertAuditAction('anything'), false)
})

// ── navigation ───────────────────────────────────────────────────────────────

test('nav: AI Alerts is owner-only and platform-grouped', () => {
  const item = NAV_ITEMS.find((i) => i.href === '/admin/operations/ai/alerts')
  assert.ok(item, 'the Alerts destination exists')
  assert.equal(item!.ownerOnly, true)
  assert.equal(item!.adminOnly, true)
  assert.equal(item!.group, 'platform')
  assert.ok(!item!.primary, 'must not take a mobile primary slot from real work')

  const owner = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true })
  assert.ok(owner.some((i) => i.href === '/admin/operations/ai/alerts'))
  for (const ctx of [{ role: 'admin', isOwner: false }, { role: 'manager', isOwner: false }, { role: 'crew', isOwner: false }]) {
    assert.ok(!visibleNav(NAV_ITEMS, ctx).some((i) => i.href === '/admin/operations/ai/alerts'),
      `${ctx.role} (owner=${ctx.isOwner}) must not see AI Alerts`)
  }
})

// ── authorization (the guard's DECISION) ─────────────────────────────────────

test('isPlatformOwner: only the legacy owner or a listed sub with role admin', () => {
  const env = { PLATFORM_OWNER_SUBS: 'alice' }
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'admin' }, env), true)
  assert.equal(isPlatformOwner({ sub: 'alice', role: 'admin' }, env), true)
  // Every one of these must be denied the alert surface.
  assert.equal(isPlatformOwner({ sub: 'bob', role: 'admin' }, env), false, 'an admin who is not an owner')
  assert.equal(isPlatformOwner({ sub: 'alice', role: 'manager' }, env), false, 'listed, but not admin')
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'crew' }, env), false)
  assert.equal(isPlatformOwner(null, env), false)
  // With PLATFORM_OWNER_SUBS unset (production today), only the legacy owner passes.
  assert.equal(isPlatformOwner({ sub: 'alice', role: 'admin' }, {}), false)
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'admin' }, {}), true)
})

// ── authorization + dormancy (the real route handlers) ───────────────────────

const SECRET = 'test-admin-session-secret-value'

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k]
    if (overrides[k] === undefined) delete process.env[k]
    else process.env[k] = overrides[k]!
  }
  try { await fn() } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! }
  }
}

type NextInit = ConstructorParameters<typeof NextRequest>[1]
const req = (url: string, token?: string, init?: NextInit) => {
  const r = new NextRequest(url, init)
  if (token) r.cookies.set(COOKIE_NAME, token)
  return r
}
const post = (url: string, token: string | undefined, body: unknown) =>
  req(url, token, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

test('shadow-alerts list: unauthenticated is 401 — before the flag is even consulted', async () => {
  const { GET } = await import('../app/api/admin/shadow-alerts/route')
  // Alerting ON here: a 401 proves auth runs FIRST and the flag is not what is protecting it.
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ALERTING_ENABLED: 'true' }, async () => {
    const res = await GET(req('http://localhost/api/admin/shadow-alerts'), { params: Promise.resolve({}) })
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'unauthorized' })
  })
})

test('shadow-alerts detail + action: unauthenticated is 401', async () => {
  const { GET, POST } = await import('../app/api/admin/shadow-alerts/[id]/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ALERTING_ENABLED: 'true' }, async () => {
    const params = { params: Promise.resolve({ id: 'SAL-1000' }) }
    assert.equal((await GET(req('http://localhost/api/admin/shadow-alerts/SAL-1000'), params)).status, 401)
    assert.equal((await POST(post('http://localhost/api/admin/shadow-alerts/SAL-1000', undefined, { action: 'acknowledge' }), params)).status, 401)
  })
})

test('shadow-alerts: a live NON-OWNER session is denied 403, not merely hidden', async () => {
  const { createUserSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET } = await import('../app/api/admin/shadow-alerts/route')
  const { GET: DETAIL, POST } = await import('../app/api/admin/shadow-alerts/[id]/route')

  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ALERTING_ENABLED: 'true', PLATFORM_OWNER_SUBS: undefined }, async () => {
    // A real, live session for each non-owner role. Hiding the nav item is never the control.
    for (const role of ['admin', 'manager', 'crew'] as const) {
      const token = await createUserSessionToken({ id: `not-the-owner-${role}`, role })
      const params = { params: Promise.resolve({ id: 'SAL-1000' }) }
      assert.equal((await GET(req('http://localhost/api/admin/shadow-alerts', token), { params: Promise.resolve({}) })).status, 403, `${role} list`)
      assert.equal((await DETAIL(req('http://localhost/api/admin/shadow-alerts/SAL-1000', token), params)).status, 403, `${role} detail`)
      assert.equal((await POST(post('http://localhost/api/admin/shadow-alerts/SAL-1000', token, { action: 'acknowledge' }), params)).status, 403, `${role} action`)
    }
  })
})

test('shadow-alerts: the OWNER reaches the route but the flag keeps it dormant', async () => {
  const { createSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET } = await import('../app/api/admin/shadow-alerts/route')
  const { GET: DETAIL, POST } = await import('../app/api/admin/shadow-alerts/[id]/route')

  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ALERTING_ENABLED: 'false' }, async () => {
    const token = await createSessionToken()   // the legacy owner session
    const params = { params: Promise.resolve({ id: 'SAL-1000' }) }

    // Owner passes authorization (not 401/403) — and gets an explicit "off", with no store read.
    const list = await GET(req('http://localhost/api/admin/shadow-alerts', token), { params: Promise.resolve({}) })
    assert.equal(list.status, 200)
    const body = await list.json()
    assert.equal(body.enabled, false)
    assert.equal(body.reason, 'SHADOW_ALERTING_ENABLED is off')
    assert.equal(body.alerts, undefined, 'a dormant surface returns no alert data at all')

    assert.equal((await DETAIL(req('http://localhost/api/admin/shadow-alerts/SAL-1000', token), params)).status, 200)
    // A WRITE while dormant is refused outright rather than silently no-op'd.
    const act = await POST(post('http://localhost/api/admin/shadow-alerts/SAL-1000', token, { action: 'acknowledge' }), params)
    assert.equal(act.status, 403)
    assert.deepEqual(await act.json(), { error: 'alerting disabled' })
  })
})

// ── cron authorization + dormancy ────────────────────────────────────────────

test('cron/shadow-alerts FAILS CLOSED when CRON_SECRET is unset', async () => {
  const { GET } = await import('../app/api/cron/shadow-alerts/route')
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/shadow-alerts'))
    assert.equal(res.status, 401)
  })
})

test('cron/shadow-alerts rejects a missing or wrong bearer', async () => {
  const { GET } = await import('../app/api/cron/shadow-alerts/route')
  await withEnv({ CRON_SECRET: 'sekret' }, async () => {
    assert.equal((await GET(new NextRequest('http://localhost/api/cron/shadow-alerts'))).status, 401)
    const wrong = new NextRequest('http://localhost/api/cron/shadow-alerts', { headers: { authorization: 'Bearer nope' } })
    assert.equal((await GET(wrong)).status, 401)
  })
})

test('cron/shadow-alerts: authorized but flag off ⇒ a cheap no-op that touches no store', async () => {
  const { GET } = await import('../app/api/cron/shadow-alerts/route')
  await withEnv({ CRON_SECRET: 'sekret', SHADOW_ALERTING_ENABLED: 'false' }, async () => {
    const r = new NextRequest('http://localhost/api/cron/shadow-alerts', { headers: { authorization: 'Bearer sekret' } })
    const res = await GET(r)
    assert.equal(res.status, 200)
    // No Redis is configured in tests. Reaching Redis would throw — returning cleanly
    // proves the flag check short-circuits before any I/O.
    assert.deepEqual(await res.json().then((j) => ({ ok: j.ok, enabled: j.enabled, opened: j.opened })),
      { ok: true, enabled: false, opened: 0 })
  })
})

test('the alert cron is registered on a schedule', async () => {
  const { readFileSync } = await import('node:fs')
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] }
  const cron = vercel.crons.find((c) => c.path === '/api/cron/shadow-alerts')
  assert.ok(cron, 'the evaluator must actually be scheduled — an unscheduled evaluator never runs')
  assert.equal(cron!.schedule, '*/15 * * * *')
  // It must not collide with the vision worker's own budget/cadence.
  assert.notEqual(cron!.schedule, vercel.crons.find((c) => c.path === '/api/cron/vision-shadow')!.schedule)
})
