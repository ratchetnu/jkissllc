// Fail-closed authentication on public webhook + cron endpoints. These invoke the
// real route handlers, asserting the auth decision happens BEFORE any work (so no
// Redis/side-effects run on the rejection path). Env is saved/restored per case.
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) { prev[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]! }
  try { await fn() } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! }
  }
}

test('cron/daily rejects when CRON_SECRET is set but no bearer is presented', async () => {
  const { GET } = await import('../app/api/cron/daily/route')
  await withEnv({ CRON_SECRET: 'sekret' }, async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/daily'))
    assert.equal(res.status, 401)
  })
})

test('cron/daily FAILS CLOSED when CRON_SECRET is unset (was previously open)', async () => {
  const { GET } = await import('../app/api/cron/daily/route')
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/daily'))
    assert.equal(res.status, 401)
  })
})

test('cron/reminders FAILS CLOSED when CRON_SECRET is unset', async () => {
  const { GET } = await import('../app/api/cron/reminders/route')
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/reminders'))
    assert.equal(res.status, 401)
  })
})

test('twilio SMS webhook FAILS CLOSED with no verifying secret configured', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/sms/route')
  await withEnv({ TWILIO_AUTH_TOKEN: undefined, TWILIO_WEBHOOK_SECRET: undefined }, async () => {
    const req = new NextRequest('http://localhost/api/webhooks/twilio/sms', { method: 'POST', body: 'From=%2B18175551212&Body=hi' })
    const res = await POST(req)
    assert.equal(res.status, 503)
  })
})

test('email webhook FAILS CLOSED with no shared secret configured', async () => {
  const { POST } = await import('../app/api/webhooks/email/route')
  await withEnv({ EMAIL_WEBHOOK_SECRET: undefined }, async () => {
    const req = new NextRequest('http://localhost/api/webhooks/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'x@y.com', text: 'hi' }) })
    const res = await POST(req)
    assert.equal(res.status, 503)
  })
})
