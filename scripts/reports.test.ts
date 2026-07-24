// Wave G — reporting surface: catalog, safe CSV export, pure builders, authorization.
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-admin-session-secret-0123456789'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { REPORT_CATALOG, getReportDef, toCsv, MAX_EXPORT_ROWS, type ReportRow } from '../app/lib/reports/catalog'
import { revenueDailyRows, claimsGroupRows, filterRowsByDate, parseReportDate } from '../app/lib/reports/build'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { createUserSessionToken, requirePermission, COOKIE_NAME } from '../app/api/admin/_lib/session'
import type { Role } from '../app/lib/rbac'

// ── Catalog ───────────────────────────────────────────────────────────────────

test('catalog: unique ids, non-empty columns, resolvable; no P&L/net-profit report', () => {
  const ids = REPORT_CATALOG.map(r => r.id)
  assert.equal(new Set(ids).size, ids.length, 'report ids are unique')
  for (const r of REPORT_CATALOG) {
    assert.ok(r.columns.length > 0, `${r.id} has columns`)
    assert.equal(getReportDef(r.id)?.id, r.id)
    assert.ok(!/p&l|profit|net.?income/i.test(`${r.id} ${r.title}`), `${r.id} must not claim to be a P&L`)
  }
  assert.equal(getReportDef('nope'), undefined)
})

// ── CSV: formula-injection + delimiter escaping + cents + row cap ─────────────

test('toCsv neutralizes formula injection and escapes delimiters', () => {
  const cols = [{ key: 'label', label: 'Business', kind: 'text' as const }, { key: 'totalCents', label: 'Gross', kind: 'cents' as const }]
  const rows: ReportRow[] = [
    { label: '=SUM(A1:A9)', totalCents: 5125 },       // formula → must be neutralized
    { label: 'Acme, Inc "HQ"', totalCents: 100 },     // comma + quote → must be RFC-4180 quoted
    { label: '@cmd', totalCents: 0 },
  ]
  const out = toCsv(cols, rows)
  assert.ok(!('error' in out))
  const csv = (out as { csv: string }).csv
  assert.ok(csv.includes("'=SUM(A1:A9)"), 'leading = is prefixed with a quote')
  assert.ok(csv.includes("'@cmd"), 'leading @ is prefixed')
  assert.ok(csv.includes('"Acme, Inc ""HQ"""'), 'comma+quote cell is RFC-4180 escaped')
  assert.ok(csv.includes('51.25'), 'cents formatted to dollars')
  assert.equal(csv.split('\n')[0], 'Business,Gross', 'header row')
})

test('toCsv refuses an oversized export', () => {
  const cols = [{ key: 'label', label: 'X', kind: 'text' as const }]
  const rows: ReportRow[] = Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => ({ label: String(i) }))
  const out = toCsv(cols, rows)
  assert.deepEqual(out, { error: 'too_large' })
})

// ── Pure builders ─────────────────────────────────────────────────────────────

test('revenueDailyRows + date filter (inclusive window)', () => {
  const analytics = { revenue: { series: [{ date: '2026-03-01', amountCents: 100 }, { date: '2026-03-15', amountCents: 200 }, { date: '2026-03-31', amountCents: 300 }] } }
  const rows = revenueDailyRows(analytics)
  assert.equal(rows.length, 3)
  assert.deepEqual(filterRowsByDate(rows, 'date', '2026-03-10', '2026-03-20').map(r => r.amountCents), [200])
  assert.equal(filterRowsByDate(rows, 'date').length, 3) // no bounds → all
})

test('claimsGroupRows maps only report-safe fields', () => {
  const rows = claimsGroupRows([{ label: 'Acme', claimCount: 3, totalCents: 900, recoveredCents: 400, outstandingCents: 500 }])
  assert.deepEqual(rows[0], { label: 'Acme', claimCount: 3, totalCents: 900, recoveredCents: 400, outstandingCents: 500 })
})

test('parseReportDate accepts ISO dates, rejects junk', () => {
  assert.equal(parseReportDate('2026-03-10'), '2026-03-10')
  assert.equal(parseReportDate('nope'), undefined)
  assert.equal(parseReportDate(null), undefined)
  assert.equal(parseReportDate('2026-3-1'), undefined)
})

// ── Authorization (reports:view gates readers + export) ───────────────────────

async function reqAs(role: Role, tenantId?: string): Promise<NextRequest> {
  const token = await createUserSessionToken({ id: role === 'admin' ? 'owner' : `u_${role}`, role, tenantId })
  return new NextRequest('http://localhost/api/admin/reports/export', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
}
const allowed = (x: unknown) => !(x instanceof NextResponse)

test('reports:view gates every report reader/export: admin+manager ok, crew 403, anon 401', async () => {
  assert.ok(allowed(await requirePermission(await reqAs('admin'), 'reports:view')))
  assert.ok(allowed(await requirePermission(await reqAs('manager'), 'reports:view')))
  assert.equal((await requirePermission(await reqAs('crew'), 'reports:view') as NextResponse).status, 403)
  assert.equal((await requirePermission(new NextRequest('http://localhost/api/admin/reports/export'), 'reports:view') as NextResponse).status, 401)
})

test('claims report reader is reconciled to reports:view; claims:manage stays admin/manager for management', async () => {
  // A manager holds BOTH reports:view (report read) and claims:manage (management), so the
  // reconciliation doesn't grant new access — it makes the read path a *report* permission.
  assert.ok(allowed(await requirePermission(await reqAs('manager'), 'reports:view')))
  assert.ok(allowed(await requirePermission(await reqAs('manager'), 'claims:manage')))
})

test('signed session binds the tenant (cross-tenant isolation basis)', async () => {
  const who = await requirePermission(await reqAs('admin', 'acme'), 'reports:view')
  assert.equal((who as { tenantId: string }).tenantId, 'acme')
})

// ── Registry pin ──────────────────────────────────────────────────────────────

test('reporting capability is full, gated reports:view', () => {
  const r = CAPABILITY_REGISTRY['reporting']
  assert.equal(r.status, 'full')
  assert.ok(r.requiredPermissions.includes('reports:view'))
})
