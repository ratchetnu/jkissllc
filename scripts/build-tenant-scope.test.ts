// ── WAVE 6B: build-time / public-render tenant scope ─────────────────────────
//
// The regression these lock down: with TENANCY_ENABLED=true, `next build` aborted
// prerendering `/` with `tenant context required for tenant-owned key family "rv:*"`,
// because React Server Components never establish a tenant context — `withTenantRoute`
// wraps API handlers, not pages, and a static prerender has no request at all.
//
// The fix must open exactly one door (public reference-tenant content) and no others.
// Every test below is about proving the door is still narrow.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  withReferenceTenantScope,
  PUBLIC_RENDER_TENANT_ID,
} from '../app/lib/platform/tenancy/public-render-scope'
import { runWithTenant, currentTenantId } from '../app/lib/platform/tenancy/context'
import { scopeKey, PLATFORM_GLOBAL_PREFIXES, isPlatformGlobal } from '../app/lib/platform/tenancy/keys'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'

const ON = { enabled: true }
const REVIEW_INDEX = 'rv:index'   // the exact key family that broke the build

// 1 ─────────────────────────────────────────────────────────────────────────────
test('the build-time review read SUCCEEDS inside the explicit reference scope', () => {
  const key = withReferenceTenantScope(() => scopeKey(REVIEW_INDEX, ON))
  assert.equal(key, `t:${DEFAULT_TENANT_ID}:${REVIEW_INDEX}`)
})

// 2 ─────────────────────────────────────────────────────────────────────────────
test('the SAME read still THROWS outside any tenant scope — fail-closed is intact', () => {
  assert.throws(() => scopeKey(REVIEW_INDEX, ON), /tenant context required/)
})

// 3 ─────────────────────────────────────────────────────────────────────────────
test('the explicit scope resolves the reference tenant "jkiss" and nothing else', () => {
  assert.equal(PUBLIC_RENDER_TENANT_ID, 'jkiss')
  assert.equal(PUBLIC_RENDER_TENANT_ID, DEFAULT_TENANT_ID)
  assert.equal(withReferenceTenantScope(() => currentTenantId()), 'jkiss')
})

// 4 ─────────────────────────────────────────────────────────────────────────────
test('a caller CANNOT override the reference tenant — the helper takes no tenant', () => {
  // The signature is the control: there is no parameter to pass a tenant through.
  assert.equal(withReferenceTenantScope.length, 1, 'exactly one arg: the callback')
  // Even handed extra arguments, the resolved tenant is unchanged.
  const sneaky = (withReferenceTenantScope as unknown as (fn: () => string | undefined, t?: string) => string | undefined)
  assert.equal(sneaky(() => currentTenantId(), 'attacker-tenant'), 'jkiss')
})

// 5 ─────────────────────────────────────────────────────────────────────────────
test('request-scoped tenant behaviour is unchanged by the helper existing', () => {
  assert.equal(runWithTenant({ tenantId: 'alpha' }, () => currentTenantId()), 'alpha')
  assert.equal(runWithTenant({ tenantId: 'alpha' }, () => scopeKey('cust:1', ON)), 't:alpha:cust:1')
  assert.equal(currentTenantId(), undefined, 'no ambient context leaks out')
})

// 6 + 7 ─────────────────────────────────────────────────────────────────────────
test('runtime tenant A resolves to A, and B to B — never to the reference tenant', () => {
  assert.equal(runWithTenant({ tenantId: 'alpha' }, () => scopeKey('rt:1', ON)), 't:alpha:rt:1')
  assert.equal(runWithTenant({ tenantId: 'bravo' }, () => scopeKey('rt:1', ON)), 't:bravo:rt:1')
  assert.notEqual(
    runWithTenant({ tenantId: 'alpha' }, () => scopeKey('rt:1', ON)),
    withReferenceTenantScope(() => scopeKey('rt:1', ON)),
  )
})

// 8 ─────────────────────────────────────────────────────────────────────────────
test('an authenticated tenant nested inside the public scope still wins', () => {
  // A page may render public chrome in reference scope and then do authenticated work;
  // the inner, more specific context must not be overwritten by the outer one.
  const inner = withReferenceTenantScope(() =>
    runWithTenant({ tenantId: 'alpha' }, () => scopeKey('cust:1', ON)),
  )
  assert.equal(inner, 't:alpha:cust:1', 'authenticated work does not inherit the reference tenant')
})

test('and the public scope does not persist after it returns', () => {
  withReferenceTenantScope(() => currentTenantId())
  assert.equal(currentTenantId(), undefined)
  assert.throws(() => scopeKey(REVIEW_INDEX, ON), /tenant context required/, 'still fail-closed afterwards')
})

// 9 ─────────────────────────────────────────────────────────────────────────────
test('parallel tenant contexts do not leak into one another', async () => {
  const results = await Promise.all([
    runWithTenant({ tenantId: 'alpha' }, async () => { await tick(); return scopeKey('bk:1', ON) }),
    withReferenceTenantScope(async () => { await tick(); return scopeKey('bk:1', ON) }),
    runWithTenant({ tenantId: 'bravo' }, async () => { await tick(); return scopeKey('bk:1', ON) }),
  ])
  assert.deepEqual(results, ['t:alpha:bk:1', 't:jkiss:bk:1', 't:bravo:bk:1'])
})

const tick = () => new Promise((r) => setTimeout(r, 5))

// 10 ────────────────────────────────────────────────────────────────────────────
test('a throw inside the scope restores the prior context (no stuck reference tenant)', () => {
  assert.throws(() => withReferenceTenantScope(() => { throw new Error('render failed') }), /render failed/)
  assert.equal(currentTenantId(), undefined, 'context unwound on the error path')
  assert.throws(() => scopeKey(REVIEW_INDEX, ON), /tenant context required/)
})

test('a throw inside a NESTED scope restores the OUTER tenant, not undefined', () => {
  const after = runWithTenant({ tenantId: 'alpha' }, () => {
    try { withReferenceTenantScope(() => { throw new Error('boom') }) } catch { /* handled */ }
    return currentTenantId()
  })
  assert.equal(after, 'alpha')
})

// 11 ────────────────────────────────────────────────────────────────────────────
test('async render paths (metadata/sitemap shapes) work inside the scope', async () => {
  const key = await withReferenceTenantScope(async () => {
    await tick()
    return scopeKey(REVIEW_INDEX, ON)
  })
  assert.equal(key, `t:jkiss:${REVIEW_INDEX}`)
})

test('nested async reads inside one scope all resolve to the reference tenant', async () => {
  const keys = await withReferenceTenantScope(async () => {
    const a = scopeKey('rv:index', ON)
    await tick()
    const b = scopeKey('rv:tok', ON)
    return [a, b]
  })
  assert.deepEqual(keys, ['t:jkiss:rv:index', 't:jkiss:rv:tok'])
})

// 12 ────────────────────────────────────────────────────────────────────────────
test('NO tenant-owned key family was reclassified as platform-global', () => {
  assert.deepEqual([...PLATFORM_GLOBAL_PREFIXES], ['opspilot:', 'platform:', 'ai:', 'rl:', 'health:'],
    'rv: was NOT globalised; health: is the one deliberate pre-auth-infra addition (Wave 6B)')
  assert.ok(!isPlatformGlobal('rv:index'), 'reviews are still tenant-owned')
  assert.ok(!isPlatformGlobal('rv:some-token'))
})

test('compatibility: with tenancy OFF the scope is byte-identical to today', () => {
  const off = { enabled: false }
  assert.equal(withReferenceTenantScope(() => scopeKey(REVIEW_INDEX, off)), REVIEW_INDEX)
  assert.equal(scopeKey(REVIEW_INDEX, off), REVIEW_INDEX)
})

// ── The original build failure, as a unit-level regression ──────────────────────
test('REGRESSION: the homepage review read no longer throws with tenancy on', async () => {
  // Mirrors app/components/home/Reviews.tsx: the read is performed inside the scope.
  const readAsHomepageDoes = () => withReferenceTenantScope(async () => scopeKey('rv:index', ON))
  await assert.doesNotReject(readAsHomepageDoes)
  // And the un-wrapped form — the code as it was when the build broke — still fails.
  assert.throws(() => scopeKey('rv:index', ON), /tenant context required/)
})

test('REGRESSION: only public review surfaces adopted the scope', async () => {
  // A guard against the helper spreading into authenticated/tenant-specific code.
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('grep', ['-rl', 'withReferenceTenantScope', 'app'], { encoding: 'utf8' })
  const users = out.split('\n').filter(Boolean)
    .filter((f) => !f.includes('platform/tenancy/public-render-scope'))
    .sort()
  assert.deepEqual(users, [
    'app/components/home/Reviews.tsx',
    'app/reviews/page.tsx',
  ], 'if this list grows, the new call site must be a deliberate PUBLIC reference-tenant surface')
})
