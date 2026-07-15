// Alert DELIVERY tests (Phase 5): the Slack → email → console fallback chain, the
// truthfulness of alertProviderStatus(), dedup suppression, secret redaction, the
// fail-soft guarantee (a provider throw never escapes), and prod/preview labeling.
// Providers are MOCKED via injectable IO / deps — no real Slack or email is sent.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  alert, defaultDeliver, formatAlert, alertProviderStatus, envLabel,
  type AlertPayload, type AlertProvider,
} from '../app/lib/alerts'

const CTX = { now: '2026-07-14T00:00:00.000Z', build: 'testbuild' }

// ── env sandbox ──────────────────────────────────────────────────────────────
const ALERT_ENV = ['ALERT_SLACK_WEBHOOK_URL', 'RESEND_API_KEY', 'ALERT_EMAIL_TO', 'OWNER_EMAIL', 'VERCEL_ENV', 'VERCEL_URL'] as const
function withEnv(overrides: Partial<Record<(typeof ALERT_ENV)[number], string | undefined>>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of ALERT_ENV) prev[k] = process.env[k]
  // Clear all alert-relevant env first so each case starts from a known baseline.
  for (const k of ALERT_ENV) delete process.env[k]
  for (const [k, v] of Object.entries(overrides)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const restore = () => { for (const k of ALERT_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] } }
  const out = fn()
  if (out instanceof Promise) return out.finally(restore)
  restore()
  return out
}

const basePayload: AlertPayload = formatAlert({ type: 'stripe_webhook_failed', severity: 'ERROR', errorClass: 'KVError' }, { ...CTX, environment: 'prod' })

// ── Slack configured → Slack attempted ───────────────────────────────────────
test('Slack configured → Slack is attempted and reported', async () => {
  await withEnv({ ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' }, async () => {
    let slackCalls = 0, emailCalls = 0
    const provider = await defaultDeliver(basePayload, {
      slack: async () => { slackCalls++; return true },
      email: async () => { emailCalls++; return true },
      log: () => {},
    })
    assert.equal(provider, 'slack')
    assert.equal(slackCalls, 1)
    assert.equal(emailCalls, 0)
    assert.equal(alertProviderStatus().provider, 'slack')
  })
})

// ── Email fallback configured (no Slack) → email attempted ───────────────────
test('email fallback configured (no Slack) → email is attempted and reported', async () => {
  await withEnv({ RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'owner@example.com' }, async () => {
    let slackCalls = 0, emailCalls = 0, loggedFallback = false
    const provider = await defaultDeliver(basePayload, {
      slack: async () => { slackCalls++; return true },
      email: async (_p, to) => { emailCalls++; assert.equal(to, 'owner@example.com'); return true },
      log: () => { loggedFallback = true },
    })
    assert.equal(provider, 'email')
    assert.equal(slackCalls, 0)         // Slack unset → not attempted
    assert.equal(emailCalls, 1)
    assert.equal(loggedFallback, false) // email succeeded → no console fallback
    assert.equal(alertProviderStatus().provider, 'email')
  })
})

// ── Neither configured → console only ────────────────────────────────────────
test('neither Slack nor email configured → console only', async () => {
  await withEnv({}, async () => {
    let slackCalls = 0, emailCalls = 0, logged = ''
    const provider = await defaultDeliver(basePayload, {
      slack: async () => { slackCalls++; return true },
      email: async () => { emailCalls++; return true },
      log: (line) => { logged = line },
    })
    assert.equal(provider, 'console')
    assert.equal(slackCalls, 0)
    assert.equal(emailCalls, 0)
    assert.match(logged, /\[ALERT\]/)
    const status = alertProviderStatus()
    assert.equal(status.provider, 'console')
    assert.match(status.configHint ?? '', /ALERT_SLACK_WEBHOOK_URL/)
  })
})

// ── Dedup: a storm is suppressed within the window ───────────────────────────
test('duplicate alert within the window is suppressed (dedup)', async () => {
  const seen = new Set<string>()
  const sent: AlertPayload[] = []
  const deps = {
    now: () => 0,
    shouldSend: async (key: string) => { if (seen.has(key)) return false; seen.add(key); return true },
    deliver: async (p: AlertPayload): Promise<AlertProvider> => { sent.push(p); return 'slack' },
  }
  const input = { type: 'cron_job_failed', severity: 'CRITICAL' as const, worker: 'daily' }
  const first = await alert(input, deps)
  const second = await alert(input, deps)
  assert.equal(first.sent, true)
  assert.equal(second.deduped, true)
  assert.equal(sent.length, 1)   // one failing worker → exactly one alert
})

// ── Redaction: secret-like fields never reach the payload ────────────────────
test('sensitive/secret fields are redacted from the payload', () => {
  const p = formatAlert({
    type: 'stripe_webhook_failed', severity: 'ERROR',
    message: 'charge failed sk_live_ABCDEFGHIJKLMNOP for https://dashboard.stripe.com/pi_123',
    meta: { session: 'https://abc.public.blob.vercel-storage.com/x', paymentIntent: 'pi_1', amount: 4200 },
  }, { ...CTX, environment: 'prod' })
  const blob = JSON.stringify(p)
  assert.ok(!/sk_live/.test(blob))
  assert.ok(!/stripe\.com/.test(p.message))
  assert.ok(!/blob\.vercel/.test(blob))
  assert.equal(p.meta?.amount, 4200)   // safe numeric preserved
})

// ── Fail-soft: a provider throw never escapes; the failure is logged ─────────
test('provider send failure does not throw and logs a delivery failure', async () => {
  await withEnv({ ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' }, async () => {
    let logged = ''
    // defaultDeliver: a throwing slack sender falls through to the console record.
    const provider = await defaultDeliver(basePayload, {
      slack: async () => { throw new Error('slack down') },
      log: (line) => { logged = line },
    })
    assert.equal(provider, 'console')     // fell through, did not throw
    assert.match(logged, /\[ALERT\]/)
  })
  // alert(): a throwing deliver is swallowed and reported as not-sent.
  const r = await alert({ type: 'x', severity: 'ERROR' }, {
    now: () => 0, shouldSend: async () => true,
    deliver: async (): Promise<AlertProvider> => { throw new Error('boom') },
  })
  assert.equal(r.sent, false)
})

// ── Prod vs preview labeling ─────────────────────────────────────────────────
test('environment labeling is correct for prod vs preview', () => {
  withEnv({ VERCEL_ENV: 'production' }, () => {
    assert.equal(envLabel(), 'prod')
    assert.equal(formatAlert({ type: 't', severity: 'INFO' }, CTX).environment, 'prod')
  })
  withEnv({ VERCEL_ENV: 'preview' }, () => {
    assert.equal(envLabel(), 'preview')
    assert.equal(formatAlert({ type: 't', severity: 'INFO' }, CTX).environment, 'preview')
  })
  withEnv({ VERCEL_URL: 'something.vercel.app' }, () => {
    assert.equal(envLabel(), 'preview')   // no VERCEL_ENV but on a Vercel URL → preview
  })
  withEnv({}, () => { assert.equal(envLabel(), 'local') })
})

// ── Payload carries the required operational context ─────────────────────────
test('payload carries environment, correlation id, timestamp, and safe summary', () => {
  const withId = formatAlert({ type: 'cron_job_failed', severity: 'CRITICAL', worker: 'reminders', correlationId: 'evt_123' }, { ...CTX, environment: 'prod' })
  assert.equal(withId.environment, 'prod')
  assert.equal(withId.correlationId, 'evt_123')
  assert.equal(withId.at, CTX.now)
  assert.equal(withId.worker, 'reminders')
  // No correlation id supplied → one is generated (never empty).
  const generated = formatAlert({ type: 'cron_job_failed', severity: 'CRITICAL', worker: 'daily' }, { ...CTX, environment: 'preview' })
  assert.ok(generated.correlationId.length > 0)
  assert.match(generated.correlationId, /^cid_/)
})
