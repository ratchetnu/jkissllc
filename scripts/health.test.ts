// Production health checks: healthy / degraded / critical-failure states, missing
// configuration handling, the public-minimal vs admin-detailed split, and NO leak
// of any secret value. Pure/hermetic (injected KV ping + env).
import assert from 'node:assert/strict'
import test from 'node:test'

import { summarize, configChecks, runHealthChecks, projectHealth, httpStatusFor } from '../app/lib/health'

const FULL_ENV = {
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_SECRETVALUE_do_not_leak',
  AI_GATEWAY_API_KEY: 'aigw_SECRETVALUE_do_not_leak',
  CRON_SECRET: 'cron_SECRETVALUE_do_not_leak',
  STRIPE_SECRET_KEY: 'sk_live_SECRETVALUE_do_not_leak',
  RESEND_API_KEY: 're_SECRETVALUE_do_not_leak',
}

test('ai_provider is "ok" via Vercel OIDC even without a static AI key (no false degraded)', () => {
  const onVercel = configChecks({ ...FULL_ENV, AI_GATEWAY_API_KEY: undefined, VERCEL: '1' })
  assert.equal(onVercel.find(c => c.name === 'ai_provider')?.status, 'ok')
  const nowhere = configChecks({ CRON_SECRET: 'x' })
  assert.equal(nowhere.find(c => c.name === 'ai_provider')?.status, 'degraded')
})

test('summarize: critical down → unhealthy; non-critical → degraded; all ok → healthy', () => {
  assert.equal(summarize([{ name: 'kv', critical: true, status: 'ok', detail: '' }]), 'healthy')
  assert.equal(summarize([{ name: 'kv', critical: true, status: 'down', detail: '' }]), 'unhealthy')
  assert.equal(summarize([{ name: 'kv', critical: true, status: 'ok', detail: '' }, { name: 'ai', critical: false, status: 'degraded', detail: '' }]), 'degraded')
})

test('configChecks reports presence only — missing config → degraded, never the value', () => {
  const present = configChecks(FULL_ENV)
  assert.ok(present.every(c => c.status === 'ok'))
  const missing = configChecks({})
  assert.ok(missing.every(c => c.status === 'degraded'))
  // No secret value appears anywhere in the checks.
  assert.ok(!JSON.stringify(present).includes('SECRETVALUE'))
})

test('runHealthChecks: HEALTHY when KV pings and config present', async () => {
  const r = await runHealthChecks({ pingKv: async () => true, env: FULL_ENV, now: () => 0, build: 'b' })
  assert.equal(r.status, 'healthy')
  assert.equal(httpStatusFor(r.status), 200)
  assert.equal(r.components.find(c => c.name === 'kv')?.status, 'ok')
})

test('runHealthChecks: DEGRADED when a non-critical dependency config is missing', async () => {
  const r = await runHealthChecks({ pingKv: async () => true, env: { CRON_SECRET: 'x' }, now: () => 0, build: 'b' })
  assert.equal(r.status, 'degraded')
  assert.equal(httpStatusFor(r.status), 200)
  assert.equal(r.components.find(c => c.name === 'storage')?.status, 'degraded')
})

test('runHealthChecks: UNHEALTHY (503) when the critical KV dependency fails', async () => {
  const r = await runHealthChecks({ pingKv: async () => false, env: FULL_ENV, now: () => 0, build: 'b' })
  assert.equal(r.status, 'unhealthy')
  assert.equal(httpStatusFor(r.status), 503)
  // A throwing ping is treated as down, not a crash.
  const r2 = await runHealthChecks({ pingKv: async () => { throw new Error('kv gone') }, env: FULL_ENV, now: () => 0, build: 'b' })
  assert.equal(r2.status, 'unhealthy')
})

test('public projection is minimal; detailed adds components; NEITHER leaks a secret value', async () => {
  const report = await runHealthChecks({ pingKv: async () => true, env: FULL_ENV, now: () => 0, build: 'b' })
  const pub = projectHealth(report, { detailed: false })
  const det = projectHealth(report, { detailed: true })
  // Public: only status/build/at — no component internals.
  assert.deepEqual(Object.keys(pub).sort(), ['at', 'build', 'status'])
  assert.equal(pub.components, undefined)
  // Detailed: component breakdown present.
  assert.ok(Array.isArray((det as { components?: unknown[] }).components))
  // No secret value in EITHER form.
  assert.ok(!JSON.stringify(pub).includes('SECRETVALUE'))
  assert.ok(!JSON.stringify(det).includes('SECRETVALUE'))
  // No connection-string-ish or token-ish content in detailed.
  assert.ok(!/sk_live|vercel_blob_rw|re_[A-Za-z0-9]/.test(JSON.stringify(det)))
})
