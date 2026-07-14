// Outbound SMS send helper: StatusCallback attachment, Messaging Service routing,
// opt-out + suppression short-circuits (no Twilio call), failure surfacing, and the
// guarantee that the callback URL leaks no secret or customer data.
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOutboundSmsParams, sendSmsDetailed, withSmsSuppressed } from '../app/lib/sms'
import { notifyOwnerNewSubmission } from '../app/lib/booking-notify'
import { redis } from '../app/lib/redis'
import type { Booking } from '../app/lib/bookings'

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) { prev[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]! }
  try { await fn() } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! }
  }
}

const BASE_ENV = {
  PUBLIC_BASE_URL: 'https://www.jkissllc.com',
  NEXT_PUBLIC_SITE_URL: undefined,
  TWILIO_MESSAGING_SERVICE_SID: 'MGtestservice',
  TWILIO_FROM: undefined,
  TWILIO_WEBHOOK_SECRET: 'supersecretwebhookvalue',
}

// ── StatusCallback attachment + routing ─────────────────────────────────────
test('StatusCallback is attached to a normal outbound send, via the status webhook route', async () => {
  await withEnv(BASE_ENV, async () => {
    const p = buildOutboundSmsParams('+15550001111', 'Hello there')
    assert.equal(p.get('StatusCallback'), 'https://www.jkissllc.com/api/webhooks/twilio/status?key=supersecretwebhookvalue')
    assert.equal(p.get('MessagingServiceSid'), 'MGtestservice')   // Messaging Service routing preserved
    assert.equal(p.get('From'), null)
    assert.equal(p.get('To'), '+15550001111')
    assert.equal(p.get('Body'), 'Hello there')
  })
})

test('callback URL carries the shared webhook secret (for auth) but no customer data', async () => {
  await withEnv(BASE_ENV, async () => {
    const cb = buildOutboundSmsParams('+15550001111', 'Hello there').get('StatusCallback')!
    assert.ok(cb.includes('key=supersecretwebhookvalue'), 'webhook secret present as ?key so the status webhook can authenticate')
    assert.ok(!cb.includes('5550001111'), 'no customer phone in URL')
    assert.ok(!/AC[0-9a-f]/i.test(cb), 'no account SID / auth-token material in URL')
  })
})

test('callback URL omits the ?key when no webhook secret is configured', async () => {
  await withEnv({ ...BASE_ENV, TWILIO_WEBHOOK_SECRET: undefined }, async () => {
    assert.equal(buildOutboundSmsParams('+15550001111', 'hi').get('StatusCallback'), 'https://www.jkissllc.com/api/webhooks/twilio/status')
  })
})

test('From number is used when no Messaging Service SID is set', async () => {
  await withEnv({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: undefined, TWILIO_FROM: '+18170000000' }, async () => {
    const p = buildOutboundSmsParams('+15550001111', 'hi')
    assert.equal(p.get('From'), '+18170000000')
    assert.equal(p.get('MessagingServiceSid'), null)
    assert.equal(p.get('StatusCallback'), 'https://www.jkissllc.com/api/webhooks/twilio/status?key=supersecretwebhookvalue')
  })
})

test('no base URL configured → no StatusCallback attached (fails safe, does not invent)', async () => {
  await withEnv({ PUBLIC_BASE_URL: undefined, NEXT_PUBLIC_SITE_URL: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MGx' }, async () => {
    const p = buildOutboundSmsParams('+15550001111', 'hi')
    assert.equal(p.get('StatusCallback'), null)
    assert.equal(p.get('MessagingServiceSid'), 'MGx')   // message still sends
  })
})

// ── opt-out / suppression / isTest never call Twilio ────────────────────────
async function withNoFetch(fn: (calls: () => number) => Promise<void>) {
  const orig = globalThis.fetch
  let n = 0
  ;(globalThis as { fetch: typeof fetch }).fetch = (async () => { n++; return { ok: false, status: 599, json: async () => ({}) } as unknown as Response }) as typeof fetch
  try { await fn(() => n) } finally { (globalThis as { fetch: typeof fetch }).fetch = orig }
}

const CONFIGURED = {
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_API_KEY_SID: 'SKtest', TWILIO_API_KEY_SECRET: 'secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest', PUBLIC_BASE_URL: 'https://www.jkissllc.com',
}

test('opted-out recipient is skipped — no Twilio call', async () => {
  const origGet = redis.get
  ;(redis as { get: typeof redis.get }).get = (async (k: string) => (k.includes('optout') ? '1' : null)) as typeof redis.get
  try {
    await withEnv(CONFIGURED, async () => {
      await withNoFetch(async (calls) => {
        const r = await sendSmsDetailed('+15550001111', 'hi')
        assert.equal(r.ok, false)
        assert.match((r as { error: string }).error, /opted out/i)
        assert.equal(calls(), 0, 'Twilio fetch must not be called for an opted-out number')
      })
    })
  } finally { (redis as { get: typeof redis.get }).get = origGet }
})

test('suppressed automated run does not call Twilio', async () => {
  await withEnv(CONFIGURED, async () => {
    await withNoFetch(async (calls) => {
      const r = await withSmsSuppressed(() => sendSmsDetailed('+15550001111', 'hi'))
      assert.equal(r.ok, false)
      assert.equal(calls(), 0)
    })
  })
})

test('isTest booking notification does not call Twilio (caller-level suppression)', async () => {
  await withEnv(CONFIGURED, async () => {
    await withNoFetch(async (calls) => {
      const res = await notifyOwnerNewSubmission({ isTest: true } as Booking)
      assert.deepEqual(res, { sent: false, deduped: false })
      assert.equal(calls(), 0)
    })
  })
})

// ── failures are surfaced to the caller (so the ledger records them) ────────
test('a Twilio rejection is surfaced (not swallowed) so callers can ledger it', async () => {
  const origGet = redis.get
  ;(redis as { get: typeof redis.get }).get = (async () => null) as typeof redis.get
  try {
    await withEnv(CONFIGURED, async () => {
      const orig = globalThis.fetch
      ;(globalThis as { fetch: typeof fetch }).fetch = (async () => ({ ok: false, status: 400, json: async () => ({ message: 'Invalid To', code: 21211 }) } as unknown as Response)) as typeof fetch
      try {
        const r = await sendSmsDetailed('+15550001111', 'hi')
        assert.equal(r.ok, false)
        assert.equal((r as { error: string }).error, 'Invalid To')
        assert.equal((r as { code?: number }).code, 21211)
      } finally { (globalThis as { fetch: typeof fetch }).fetch = orig }
    })
  } finally { (redis as { get: typeof redis.get }).get = origGet }
})
