// Write-inertness + redaction gate for the owner-only Production payroll dry-run
// endpoint (app/api/admin/tenant-migration/payroll-plan). The property that matters:
// this surface can READ Production payroll but can never WRITE it, and it never emits
// a name, an amount, or a raw id. Both are asserted directly here.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { NextRequest } from 'next/server'
import { redisRO } from '../app/lib/redis'
import { buildRedactedPlanReport } from '../app/lib/tenant-migration/payroll-plan-report'
import { POST } from '../app/api/admin/tenant-migration/payroll-plan/route'
import type { Business } from '../app/lib/businesses'
import type { Staff } from '../app/lib/staff'

const ROUTE_SRC = path.join(process.cwd(), 'app', 'api', 'admin', 'tenant-migration', 'payroll-plan', 'route.ts')

test('redisRO exposes ONLY read methods — it is write-incapable at the surface', () => {
  assert.deepEqual(Object.keys(redisRO).sort(), ['get', 'zrevrange'])
  const anyRO = redisRO as unknown as Record<string, unknown>
  for (const w of ['set', 'del', 'zadd', 'zrem', 'incr', 'expire', 'pexpire', 'hincrby', 'eval', 'setNxPx']) {
    assert.equal(anyRO[w], undefined, `redisRO must not expose ${w}`)
  }
})

test('the route source contains no reachable mutation and no apply switches', () => {
  const src = readFileSync(ROUTE_SRC, 'utf8')
  const FORBIDDEN = [
    /saveStaff/, /saveBusiness/, /ensureBusinessStableId/,
    /redis\.(set|del|zadd|zrem|incr|expire|pexpire|hincrby|eval|setNxPx)\b/,
    /TENANT_MIGRATION_CONFIRM/, /TENANT_MIGRATION_PROD_OVERRIDE/,
    /\bapply\s*\(/, /assertMayMutate/,
  ]
  for (const re of FORBIDDEN) assert.ok(!re.test(src), `route must not reference ${re}`)
  // And it must go through the read-only client + the owner + flag gates.
  assert.match(src, /redisRO/)
  assert.match(src, /requirePlatformOwner/)
  assert.match(src, /isEnabled\('OPERION_PAYROLL_REKEY_DRYRUN'\)/)
})

test('disabled by default: POST returns 404 (inert) with the flag unset', async () => {
  delete process.env.OPERION_PAYROLL_REKEY_DRYRUN
  const req = new NextRequest('http://localhost/api/admin/tenant-migration/payroll-plan', { method: 'POST' })
  const res = await POST(req)
  assert.equal(res.status, 404)
})

test('report totals: additive-only, nothing legacy removed', () => {
  const businesses = [{ key: 'acme roofing', name: 'Acme Roofing' }] as Business[]
  const staff = [
    { id: 'staff_a', name: 'Ana', payByBusiness: { 'acme roofing': 20000 } },
  ] as unknown as Staff[]

  const r = buildRedactedPlanReport(businesses, staff, { host: 'test-host', commit: 'deadbeef', now: '2026-01-01T00:00:00.000Z' })
  assert.equal(r.totals.mintIdsProposed, 1)
  assert.equal(r.totals.overridesToAdd, 1)
  assert.equal(r.totals.proposedWrites, 2)
  assert.equal(r.totals.legacyOverridesScanned, 1)
  assert.equal(r.totals.legacyOverridesUntouched, r.totals.legacyOverridesScanned)
  assert.equal(r.invariants.legacyUntouchedEqualsScanned, true)
  assert.equal(r.invariants.onlyAdditiveWrites, true)

  const empty = buildRedactedPlanReport([], [])
  assert.equal(empty.totals.noop, true)
  assert.equal(empty.totals.proposedWrites, 0)
})

test('redaction: no name, amount, or raw id ever crosses the boundary', () => {
  const businesses = [{ key: 'sysco', name: 'Sysco', stableId: 'biz_fixed' }] as Business[]
  const staff = [
    // legacy 18000 vs an existing stableId twin 15000 → value_conflict (money that disagrees).
    { id: 'staff_secret_XYZ', name: 'Jane Doe', payByBusiness: { sysco: 18000, biz_fixed: 15000 } },
  ] as unknown as Staff[]

  const r = buildRedactedPlanReport(businesses, staff, { host: 'test-host' })
  assert.equal(r.skips.byReason.value_conflict, 1)
  assert.equal(r.skips.sample[0].reason, 'value_conflict')

  const blob = JSON.stringify(r)
  for (const secret of ['Jane', 'Doe', 'Sysco', 'sysco', 'staff_secret_XYZ', 'biz_fixed', '18000', '15000']) {
    assert.ok(!blob.includes(secret), `redacted report leaked "${secret}"`)
  }
})
