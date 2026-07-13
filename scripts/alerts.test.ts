// Structured operational alerting: safe formatting, redaction of anything
// sensitive, dedup/rate-limit, provider-failure fallback. Pure/hermetic —
// injectable dedup + delivery, no network.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  alert, formatAlert, redactString, dedupKey, alertProviderStatus,
  type AlertPayload, type AlertProvider,
} from '../app/lib/alerts'

const CTX = { now: '2026-07-13T00:00:00.000Z', build: 'testbuild' }

test('formatAlert emits only safe fields + timestamp + build', () => {
  const p = formatAlert({ type: 'final_analysis_failed', severity: 'CRITICAL', booking: 'JK-B-1042', route: '/api/cron/ai-jobs', errorClass: 'provider_unavailable', retryCount: 5, correlationId: 'req_abc' }, CTX)
  assert.equal(p.severity, 'CRITICAL')
  assert.equal(p.booking, 'JK-B-1042')
  assert.equal(p.build, 'testbuild')
  assert.equal(p.at, CTX.now)
  assert.equal(p.retryCount, 5)
})

test('redaction strips tokens, secrets, URLs, emails, and truncates', () => {
  assert.match(redactString('photo https://abc.public.blob.vercel-storage.com/x.jpg here'), /\[redacted\]/)
  assert.match(redactString('key sk_live_abcdefghijklmnop'), /\[redacted\]/)
  assert.match(redactString('token 0123456789abcdef0123456789abcdef'), /\[redacted\]/)
  assert.match(redactString('email jane@example.com'), /\[redacted\]/)
  assert.ok(!redactString('x'.repeat(500)).includes('x'.repeat(300)))  // truncated
})

test('formatAlert redacts leaky message + meta (never customer/payment/token data)', () => {
  const p = formatAlert({
    type: 'payment_failed', severity: 'ERROR',
    message: 'refund failed for card https://dashboard.stripe.com/pi_123 token sk_live_XXXXXXXXXXXXXXXX',
    meta: { photoUrl: 'https://abc.public.blob.vercel-storage.com/p.jpg', amount: 12000, retry: true },
  }, CTX)
  assert.ok(!/stripe\.com/.test(p.message))
  assert.ok(!/sk_live/.test(p.message))
  assert.ok(!/blob\.vercel/.test(JSON.stringify(p.meta)))
  assert.equal(p.meta?.amount, 12000)   // safe numeric kept
  assert.equal(p.meta?.retry, true)
})

test('dedupKey ignores volatile fields, groups by signature', () => {
  const a = dedupKey({ type: 'x', severity: 'ERROR', booking: 'JK-B-1', route: '/r' })
  const b = dedupKey({ type: 'x', severity: 'ERROR', booking: 'JK-B-1', route: '/r', retryCount: 9, correlationId: 'zzz' })
  assert.equal(a, b)
  assert.notEqual(a, dedupKey({ type: 'x', severity: 'CRITICAL', booking: 'JK-B-1', route: '/r' }))
})

test('alert dedups a storm: first fires, repeats suppressed within the window', async () => {
  const seen = new Set<string>()
  const sent: AlertPayload[] = []
  const deps = {
    now: () => 0,
    shouldSend: async (key: string) => { if (seen.has(key)) return false; seen.add(key); return true },
    deliver: async (p: AlertPayload): Promise<AlertProvider> => { sent.push(p); return 'slack' },
  }
  const input = { type: 'final_analysis_failed', severity: 'CRITICAL' as const, booking: 'JK-B-9' }
  const first = await alert(input, deps)
  const second = await alert(input, deps)
  const third = await alert(input, deps)
  assert.equal(first.sent, true)
  assert.equal(second.deduped, true)
  assert.equal(third.deduped, true)
  assert.equal(sent.length, 1)   // one failing worker → exactly one alert
})

test('alert is fail-soft: a throwing provider never throws, reports not-sent', async () => {
  const deps = { now: () => 0, shouldSend: async () => true, deliver: async (): Promise<AlertProvider> => { throw new Error('slack down') } }
  const r = await alert({ type: 'x', severity: 'ERROR' }, deps)
  assert.equal(r.sent, false)   // swallowed, no throw
})

test('provider status reports console fallback + the one config step when unconfigured', () => {
  const prevSlack = process.env.ALERT_SLACK_WEBHOOK_URL, prevResend = process.env.RESEND_API_KEY
  delete process.env.ALERT_SLACK_WEBHOOK_URL; delete process.env.RESEND_API_KEY
  const s = alertProviderStatus()
  assert.equal(s.provider, 'console')
  assert.match(s.configHint ?? '', /ALERT_SLACK_WEBHOOK_URL/)
  process.env.ALERT_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/x'
  assert.equal(alertProviderStatus().provider, 'slack')
  // restore
  if (prevSlack) process.env.ALERT_SLACK_WEBHOOK_URL = prevSlack; else delete process.env.ALERT_SLACK_WEBHOOK_URL
  if (prevResend) process.env.RESEND_API_KEY = prevResend
})
