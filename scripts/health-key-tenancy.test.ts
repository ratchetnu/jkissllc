// ── WAVE 6B: the health-probe key family under tenancy ───────────────────────
//
// Regression: with TENANCY_ENABLED=true, /api/health answered 503 and fired a
// CRITICAL alert on every poll. `pingKv()` writes `health:ping:{buildId}` and
// /api/health runs PRE-AUTH — no session, no tenant context — so a tenant-owned
// classification made the chokepoint fail closed and an uptime monitor concluded the
// platform was down because tenancy had been switched on.
//
// The fix allowlists exactly one prefix. These tests exist to keep that hole the size
// it is: `health:` open, everything tenant-owned still shut.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { scopeKey, isPlatformGlobal, PLATFORM_GLOBAL_PREFIXES } from '../app/lib/platform/tenancy/keys'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

const ON = { enabled: true }

test('health:ping resolves with tenancy ON and NO tenant context — the exact 503 case', () => {
  assert.equal(scopeKey('health:ping:build-abc', ON), 'health:ping:build-abc')
})

test('health:ping is never tenant-prefixed, even inside a tenant context', () => {
  // A liveness probe must not fragment per tenant: the thing under test is whether
  // the STORE answers at all, which is one fact, not one fact per tenant.
  const inA = runWithTenant({ tenantId: 'alpha' }, () => scopeKey('health:ping:b', ON))
  const inB = runWithTenant({ tenantId: 'bravo' }, () => scopeKey('health:ping:b', ON))
  assert.equal(inA, 'health:ping:b')
  assert.equal(inB, 'health:ping:b')
  assert.equal(inA, inB, 'one probe key, not one per tenant')
})

test('the probe key is keyed by BUILD, so tenants cannot collide in it', () => {
  // Two builds get two keys; two tenants on one build share the single probe key,
  // which is correct because it holds no tenant-distinguishable value.
  assert.notEqual(scopeKey('health:ping:build-1', ON), scopeKey('health:ping:build-2', ON))
})

test('health:* is the ONLY new prefix — the allowlist is exactly this set', () => {
  assert.deepEqual([...PLATFORM_GLOBAL_PREFIXES], ['opspilot:', 'platform:', 'ai:', 'rl:', 'health:'])
})

test('health: appears in the allowlist exactly once', () => {
  const occurrences = PLATFORM_GLOBAL_PREFIXES.filter((p) => p === 'health:').length
  assert.equal(occurrences, 1)
})

test('no BROADER prefix was allowlisted alongside it', () => {
  // A prefix like 'h:' or '' would silently exempt unrelated families.
  for (const p of PLATFORM_GLOBAL_PREFIXES) {
    assert.ok(p.length >= 3, `"${p}" is too broad to be a deliberate family`)
    assert.ok(p.endsWith(':'), `"${p}" must be a full key family, not a fragment`)
  }
  assert.ok(!isPlatformGlobal('healthy-tenant-data:1'), 'the guard matches the family, not a substring')
})

test('every tenant-owned family still fails closed with no context', () => {
  for (const k of ['cust:1', 'bk:t', 'rt:1', 'crew:1', 'paystmt:1', 'msg:1', 'rv:index', 'audit:log', 'aidue:index']) {
    assert.throws(() => scopeKey(k, ON), /tenant context required/, `${k} must still fail closed`)
  }
})

test('tenant-owned families are still namespaced per tenant', () => {
  assert.equal(runWithTenant({ tenantId: 'alpha' }, () => scopeKey('cust:1', ON)), 't:alpha:cust:1')
  assert.notEqual(
    runWithTenant({ tenantId: 'alpha' }, () => scopeKey('cust:1', ON)),
    runWithTenant({ tenantId: 'bravo' }, () => scopeKey('cust:1', ON)),
  )
})

test('the ai: deliberate exception is unchanged', () => {
  // ai:* stays global by an explicit, documented decision (read filtering happens in
  // scopeAiRecords). This fix must not have altered that either way.
  assert.ok(isPlatformGlobal('ai:log'))
  assert.ok(isPlatformGlobal('ai:call:1'))
  assert.ok(isPlatformGlobal('ai:cost:jkiss:2026-07-29'))
  // …while the due index moved OUT of ai: in Wave 5 and must stay tenant-owned.
  assert.ok(!isPlatformGlobal('aidue:index'))
})

test('compatibility: with tenancy OFF the probe key is byte-identical', () => {
  assert.equal(scopeKey('health:ping:b', { enabled: false }), 'health:ping:b')
})

test('health: is a Redis key family in exactly ONE place — the liveness probe', () => {
  // Guard against the family quietly acquiring real state later. Every other
  // "health" hit in the codebase is a TypeScript property name, not a key.
  const out = execFileSync('grep', ['-rEn', "['\"`]health:", 'app'], { encoding: 'utf8' })
  const keySites = out.split('\n').filter(Boolean).filter((l) => !l.includes('tenancy/keys.ts'))
  assert.equal(keySites.length, 1, `expected only lib/health.ts to build a health: key, got:\n${keySites.join('\n')}`)
  assert.ok(keySites[0].startsWith('app/lib/health.ts:'), keySites[0])
})

test('the probe stores no tenant, customer or business payload', () => {
  const src = readFileSync('app/lib/health.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function pingKv'))
  assert.match(fn, /redis\.set\(key, '1'\)/, "the probe writes the literal '1' and nothing else")
  assert.match(fn, /pexpire\(key, 10_000\)/, 'and it is short-lived')
})
