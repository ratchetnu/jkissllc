// Production health checks: healthy / degraded / critical-failure states, missing
// configuration handling, the public-minimal vs admin-detailed split, and NO leak
// of any secret value. Pure/hermetic (injected KV ping + env).
import assert from 'node:assert/strict'
import test from 'node:test'

import { summarize, configChecks, runHealthChecks, projectHealth, httpStatusFor } from '../app/lib/health'
import { twilioConfigured } from '../app/lib/sms'
import { completionUploadReadiness } from '../app/lib/job-assignment'

const FULL_ENV = {
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_SECRETVALUE_do_not_leak',
  AI_GATEWAY_API_KEY: 'aigw_SECRETVALUE_do_not_leak',
  CRON_SECRET: 'cron_SECRETVALUE_do_not_leak',
  STRIPE_SECRET_KEY: 'sk_live_SECRETVALUE_do_not_leak',
  STRIPE_WEBHOOK_SECRET: 'whsec_SECRETVALUE_do_not_leak',
  RESEND_API_KEY: 're_SECRETVALUE_do_not_leak',
  TWILIO_ACCOUNT_SID: 'ACSECRETVALUE_do_not_leak',
  TWILIO_AUTH_TOKEN: 'twtok_SECRETVALUE_do_not_leak',
  TWILIO_FROM: '+15555550123',
  BLOB_STORE_ID: 'store_FAKEIDdoNotLeak',
}

test('ai_provider is "ok" via Vercel OIDC even without a static AI key (no false degraded)', () => {
  // The original intent stands: an OIDC-authenticated Gateway needs no static key, so
  // its absence must not read as degraded. What changed is WHICH variable proves that.
  //
  // This used to pass `VERCEL: '1'`, conflating "Vercel injects an OIDC token" with
  // "the VERCEL variable is set". Only the first is a credential; the second is set on
  // every Vercel runtime unconditionally, which made the component incapable of ever
  // reporting degraded — and it duly stayed green through an outage where every call
  // returned 402. VERCEL_OIDC_TOKEN is still accepted, so the no-false-degraded
  // guarantee this test was written for is intact.
  const onVercel = configChecks({ ...FULL_ENV, AI_GATEWAY_API_KEY: undefined, VERCEL: '1', VERCEL_OIDC_TOKEN: 'oidc-token' })
  assert.equal(onVercel.find(c => c.name === 'ai_provider')?.status, 'ok')

  // …but being on Vercel, alone, is not a credential.
  const vercelOnly = configChecks({ ...FULL_ENV, AI_GATEWAY_API_KEY: undefined, VERCEL_OIDC_TOKEN: undefined, VERCEL: '1' })
  assert.equal(vercelOnly.find(c => c.name === 'ai_provider')?.status, 'degraded')

  const nowhere = configChecks({ CRON_SECRET: 'x' })
  assert.equal(nowhere.find(c => c.name === 'ai_provider')?.status, 'degraded')
})

test('tenancy health exposes a named profile and rejects unsafe flag combinations', () => {
  const off = configChecks(FULL_ENV).find(c => c.name === 'tenancy_profile')
  assert.equal(off?.status, 'ok')
  assert.match(off?.detail ?? '', /single_tenant/)
  const unsafe = configChecks({ ...FULL_ENV, TENANCY_DUAL_WRITE: 'true' }).find(c => c.name === 'tenancy_profile')
  assert.equal(unsafe?.status, 'degraded')
  assert.match(unsafe?.detail ?? '', /migration/)
  const migration = configChecks({ ...FULL_ENV, TENANCY_DUAL_WRITE: 'true', TENANCY_DARK_LAUNCH: 'true' }).find(c => c.name === 'tenancy_profile')
  assert.equal(migration?.status, 'ok')
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
  assert.ok(missing.filter(c => c.name !== 'tenancy_profile').every(c => c.status === 'degraded'))
  assert.equal(missing.find(c => c.name === 'tenancy_profile')?.status, 'ok')
  // No secret value appears anywhere in the checks.
  assert.ok(!JSON.stringify(present).includes('SECRETVALUE'))
})

// ── Provider/capability separation (readiness must not over-report) ──────────

test('payments_webhook is its own capability: a chargeable Stripe with no webhook secret is NOT ok', () => {
  const noWebhook = configChecks({ ...FULL_ENV, STRIPE_WEBHOOK_SECRET: undefined })
  // Card payments still work…
  assert.equal(noWebhook.find(c => c.name === 'payments')?.status, 'ok')
  // …but the backstop is dead and must say so — this is the case that was silently 'ok'.
  const wh = noWebhook.find(c => c.name === 'payments_webhook')
  assert.equal(wh?.status, 'degraded')
  assert.match(wh?.detail ?? '', /STRIPE_WEBHOOK_SECRET/)
  // Both present → ok.
  assert.equal(configChecks(FULL_ENV).find(c => c.name === 'payments_webhook')?.status, 'ok')
  // Stripe absent entirely → still degraded (fail-closed), with the accurate reason.
  const noStripe = configChecks({ ...FULL_ENV, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined })
  assert.equal(noStripe.find(c => c.name === 'payments_webhook')?.status, 'degraded')
  assert.match(noStripe.find(c => c.name === 'payments_webhook')?.detail ?? '', /Stripe not configured/)
})

test('sms mirrors the real Twilio send predicate — a partial Twilio never reads as ok', () => {
  const ok = (env: Record<string, string | undefined>) =>
    configChecks(env).find(c => c.name === 'sms')?.status
  assert.equal(ok(FULL_ENV), 'ok')
  // Account SID alone cannot send.
  assert.equal(ok({ ...FULL_ENV, TWILIO_AUTH_TOKEN: undefined }), 'degraded')
  // No sender (neither a from-number nor a messaging service) cannot send.
  assert.equal(ok({ ...FULL_ENV, TWILIO_FROM: undefined }), 'degraded')
  // API-key auth is an equally valid pair.
  assert.equal(ok({ ...FULL_ENV, TWILIO_AUTH_TOKEN: undefined, TWILIO_API_KEY_SID: 'SKx', TWILIO_API_KEY_SECRET: 'shh' }), 'ok')
  // A messaging service is an equally valid sender.
  assert.equal(ok({ ...FULL_ENV, TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MGx' }), 'ok')
})

test('twilioConfigured is the SAME predicate the send path uses (cannot drift)', () => {
  // sms.ts must delegate to this exact function, so readiness and sending agree.
  assert.equal(twilioConfigured(FULL_ENV), true)
  assert.equal(twilioConfigured({}), false)
  assert.equal(twilioConfigured({ TWILIO_ACCOUNT_SID: 'ACx' }), false)
})

test('completion_uploads is its own capability: a Blob token with no store binding is NOT ok', () => {
  const noStore = configChecks({ ...FULL_ENV, BLOB_STORE_ID: undefined })
  // The Blob token is still there, so plain storage stays ok…
  assert.equal(noStore.find(c => c.name === 'storage')?.status, 'ok')
  // …but crew completion proof cannot be accepted, and readiness must say so.
  // This is the case that read `storage: ok` while uploads failed closed in the field.
  const cu = noStore.find(c => c.name === 'completion_uploads')
  assert.equal(cu?.status, 'degraded')
  assert.match(cu?.detail ?? '', /BLOB_STORE_ID/)
  assert.equal(configChecks(FULL_ENV).find(c => c.name === 'completion_uploads')?.status, 'ok')
  // Whitespace-only is not a binding (mirrors the upload route's trim()).
  assert.equal(configChecks({ ...FULL_ENV, BLOB_STORE_ID: '   ' }).find(c => c.name === 'completion_uploads')?.status, 'degraded')
})

test('completion_uploads uses the SAME predicate the upload route calls (cannot drift)', () => {
  assert.equal(completionUploadReadiness('store_x').ready, true)
  assert.equal(completionUploadReadiness(undefined).ready, false)
  assert.equal(completionUploadReadiness('  ').ready, false)
})

test('the store id is a config identifier, but readiness still never returns it', () => {
  const det = configChecks(FULL_ENV).find(c => c.name === 'completion_uploads')?.detail ?? ''
  assert.ok(!det.includes('store_FAKEIDdoNotLeak'), 'detail must name the variable, never the value')
})

test('email/sms/payments stay separated by provider — one outage does not mask another', () => {
  const emailOnly = configChecks({ ...FULL_ENV, RESEND_API_KEY: undefined })
  assert.equal(emailOnly.find(c => c.name === 'email')?.status, 'degraded')
  assert.equal(emailOnly.find(c => c.name === 'sms')?.status, 'ok')
  assert.equal(emailOnly.find(c => c.name === 'payments')?.status, 'ok')
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
