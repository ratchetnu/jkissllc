// Release Center — pure tests for the read-only snapshot assembler.
// Covers: graceful fallback when deployment metadata is unavailable, environment
// resolution, feature-flag redaction (booleans/static strings only — no raw env
// values), snapshot shape, and the read-only (GET-only) API contract.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { deriveBuildInfo, getReleaseSnapshot, currentRelease } from '../app/lib/release/manifest'
import { buildFlagViews, flagSummary } from '../app/lib/release/flag-view'
import { FLAG_DEFAULTS, ALL_FLAGS } from '../app/lib/platform/flags'

const here = dirname(fileURLToPath(import.meta.url))

test('deriveBuildInfo: graceful fallback when no Vercel metadata is present', () => {
  const b = deriveBuildInfo({})
  assert.equal(b.available, false, 'unavailable when no build vars')
  assert.equal(b.environment, 'local')
  assert.equal(b.commitSha, null)
  assert.equal(b.commitShort, null)
  assert.equal(b.deploymentId, null)
  assert.equal(b.deploymentUrl, null)
})

test('deriveBuildInfo: resolves environment + short commit from Vercel vars', () => {
  const b = deriveBuildInfo({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_SHA: 'a7ac3f6f7524900ae74e48d970896157197448b7',
    VERCEL_DEPLOYMENT_ID: 'dpl_123',
    VERCEL_URL: 'example.vercel.app',
  })
  assert.equal(b.available, true)
  assert.equal(b.environment, 'production')
  assert.equal(b.commitShort, 'a7ac3f6')
  assert.equal(b.commitShort?.length, 7)
  assert.equal(b.deploymentId, 'dpl_123')
})

test('deriveBuildInfo: unknown VERCEL_ENV falls back to local', () => {
  assert.equal(deriveBuildInfo({ VERCEL_ENV: 'weird' }).environment, 'local')
  assert.equal(deriveBuildInfo({ VERCEL_ENV: 'preview' }).environment, 'preview')
})

test('buildFlagViews: booleans only, matches defaults with empty env', () => {
  const views = buildFlagViews({})
  assert.equal(views.length, ALL_FLAGS.length)
  for (const v of views) {
    assert.equal(typeof v.enabled, 'boolean', `${v.name}.enabled is boolean`)
    assert.equal(typeof v.defaultEnabled, 'boolean')
    assert.equal(v.enabled, FLAG_DEFAULTS[v.name], `${v.name} resolves to its default with empty env`)
    assert.equal(v.overridden, false, `${v.name} not overridden with empty env`)
  }
})

test('buildFlagViews: detects an override and never leaks the raw env string', () => {
  // 'yes' parses to true; the raw string must never appear in the view.
  const views = buildFlagViews({ TENANCY_ENABLED: 'yes' })
  const tenancy = views.find((v) => v.name === 'TENANCY_ENABLED')!
  assert.equal(tenancy.enabled, true)
  assert.equal(tenancy.overridden, true, 'ON differs from OFF default → overridden')
  for (const v of views) {
    for (const val of Object.values(v)) {
      assert.notEqual(val, 'yes', 'no raw env string is surfaced in any field')
    }
  }
})

test('flag redaction: the serialized snapshot contains no secret env value', () => {
  const SENTINEL = 'sk_live_THIS_MUST_NEVER_APPEAR'
  const snap = getReleaseSnapshot(
    { STRIPE_SECRET_KEY: SENTINEL, ADMIN_PASSWORD: SENTINEL, AI_GATEWAY_API_KEY: SENTINEL, TENANCY_ENABLED: 'true' },
    0,
  )
  const json = JSON.stringify(snap)
  assert.ok(!json.includes(SENTINEL), 'no secret value leaks into the snapshot')
  assert.ok(!json.includes('STRIPE_SECRET_KEY'), 'no secret env name leaks either')
})

test('getReleaseSnapshot: shape + current/history split + migration summary', () => {
  const snap = getReleaseSnapshot({}, 12345)
  assert.equal(snap.generatedAt, 12345)
  assert.equal(snap.build.available, false)
  assert.ok(snap.current, 'a current release is present')
  assert.ok(!snap.history.includes(snap.current!), 'history excludes the current release')
  assert.equal(snap.migration.state, 'none_pending')
  assert.ok(snap.knownIssues.length > 0)
  const sum = flagSummary(snap.flags)
  assert.equal(sum.total, snap.flags.length)
  assert.equal(sum.enabled + sum.disabled, sum.total)
})

test('currentRelease: prefers the entry flagged current', () => {
  const r = currentRelease()
  assert.ok(r)
  assert.equal(r!.current, true)
})

test('API route is READ-ONLY: exports GET and no mutating handler', () => {
  const src = readFileSync(join(here, '../app/api/admin/release/route.ts'), 'utf8')
  assert.ok(/export const GET\b/.test(src), 'exports GET')
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(!new RegExp(`export const ${verb}\\b`).test(src), `must NOT export ${verb}`)
  }
  assert.ok(/requireAdmin/.test(src), 'gated by requireAdmin (admin-only)')
})
