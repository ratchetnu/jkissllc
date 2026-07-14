// Inbound Twilio SMS webhook: HELP/INFO keyword support, signature verification, and
// STOP/START regression. Keyword logic is tested purely; the route is exercised for
// the auth boundary (HELP happy-path + invalid signature) which returns before Redis.
import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { classifyInboundKeyword, helpTwiml, HELP_REPLY } from '../app/lib/sms-keywords'
import { verifyTwilioSignature } from '../app/lib/twilio-webhook'

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) { prev[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]! }
  try { await fn() } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! }
  }
}

// ── keyword classification ──────────────────────────────────────────────────
test('HELP (exact) classifies as help', () => { assert.equal(classifyInboundKeyword('HELP'), 'help') })
test('help (lowercase) classifies as help', () => { assert.equal(classifyInboundKeyword('help'), 'help') })
test('INFO classifies as help', () => { assert.equal(classifyInboundKeyword('INFO'), 'help') })
test('help with surrounding whitespace is normalized', () => { assert.equal(classifyInboundKeyword('  Help  '), 'help') })
test('unknown keyword classifies as none (normal message)', () => { assert.equal(classifyInboundKeyword('when are you coming?'), 'none') })
test('empty body classifies as none', () => { assert.equal(classifyInboundKeyword(''), 'none') })
test('undefined body classifies as none (no crash)', () => { assert.equal(classifyInboundKeyword(undefined), 'none') })

// ── STOP / START regression: the HELP addition must not reclassify them ─────
test('STOP still classifies as stop (regression)', () => { assert.equal(classifyInboundKeyword('STOP'), 'stop') })
test('UNSUBSCRIBE still classifies as stop (regression)', () => { assert.equal(classifyInboundKeyword('unsubscribe'), 'stop') })
test('START still classifies as start (regression)', () => { assert.equal(classifyInboundKeyword('START'), 'start') })
test('UNSTOP still classifies as start (regression)', () => { assert.equal(classifyInboundKeyword('unstop'), 'start') })

// ── HELP reply TwiML ────────────────────────────────────────────────────────
test('helpTwiml is valid TwiML with the configured support copy and STOP notice', () => {
  const xml = helpTwiml()
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?><Response><Message>.*<\/Message><\/Response>$/)
  assert.ok(xml.includes(HELP_REPLY))
  assert.match(HELP_REPLY, /Reply STOP to opt out/)
  assert.ok(!/token|secret|http|admin/i.test(HELP_REPLY), 'HELP reply must not expose internal details')
})

// ── signature verification ──────────────────────────────────────────────────
test('verifyTwilioSignature accepts a correct signature and rejects tampering', () => {
  const url = 'https://www.jkissllc.com/api/webhooks/twilio/sms'
  const params = { Body: 'HELP', From: '+18175551212' }
  withEnvSync({ TWILIO_AUTH_TOKEN: 'test_token' }, () => {
    let data = url
    for (const k of Object.keys(params).sort()) data += k + (params as Record<string, string>)[k]
    const good = crypto.createHmac('sha1', 'test_token').update(Buffer.from(data, 'utf-8')).digest('base64')
    assert.equal(verifyTwilioSignature(url, params, good), true)
    assert.equal(verifyTwilioSignature(url, params, good + 'x'), false)
    assert.equal(verifyTwilioSignature(url, params, null), false)
  })
})
test('verifyTwilioSignature fails closed when no auth token is configured', () => {
  withEnvSync({ TWILIO_AUTH_TOKEN: undefined }, () => {
    assert.equal(verifyTwilioSignature('https://x/y', { a: '1' }, 'anything'), false)
  })
})

// ── route: HELP happy path (returns before Redis) ───────────────────────────
test('POST HELP returns the HELP TwiML when the signature is valid', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/sms/route')
  await withEnv({ TWILIO_AUTH_TOKEN: 'test_token', TWILIO_WEBHOOK_SECRET: undefined, PUBLIC_BASE_URL: 'https://www.jkissllc.com' }, async () => {
    const url = 'https://www.jkissllc.com/api/webhooks/twilio/sms'
    const params = { Body: 'HELP' }
    let data = url
    for (const k of Object.keys(params).sort()) data += k + (params as Record<string, string>)[k]
    const sig = crypto.createHmac('sha1', 'test_token').update(Buffer.from(data, 'utf-8')).digest('base64')
    const req = new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: 'Body=HELP' })
    const res = await POST(req)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(text.includes(HELP_REPLY))
  })
})

// ── route: invalid signature is rejected (before any work) ──────────────────
test('POST with an invalid signature is rejected 403', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/sms/route')
  await withEnv({ TWILIO_AUTH_TOKEN: 'test_token', TWILIO_WEBHOOK_SECRET: undefined, PUBLIC_BASE_URL: 'https://www.jkissllc.com' }, async () => {
    const req = new NextRequest('https://www.jkissllc.com/api/webhooks/twilio/sms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bogus' }, body: 'Body=HELP' })
    const res = await POST(req)
    assert.equal(res.status, 403)
  })
})

// ── either/or auth: adding the auth token must not break existing ?key auth ──
test('with BOTH secret and token set, a valid ?key alone authenticates (no signature)', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/sms/route')
  await withEnv({ TWILIO_AUTH_TOKEN: 'test_token', TWILIO_WEBHOOK_SECRET: 'shhh', PUBLIC_BASE_URL: 'https://www.jkissllc.com' }, async () => {
    const req = new NextRequest('https://www.jkissllc.com/api/webhooks/twilio/sms?key=shhh', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'Body=HELP' })
    const res = await POST(req)
    assert.equal(res.status, 200)
    assert.ok((await res.text()).includes(HELP_REPLY))
  })
})
test('with BOTH set, wrong key AND bad signature is rejected 403', async () => {
  const { POST } = await import('../app/api/webhooks/twilio/sms/route')
  await withEnv({ TWILIO_AUTH_TOKEN: 'test_token', TWILIO_WEBHOOK_SECRET: 'shhh', PUBLIC_BASE_URL: 'https://www.jkissllc.com' }, async () => {
    const req = new NextRequest('https://www.jkissllc.com/api/webhooks/twilio/sms?key=wrong', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bogus' }, body: 'Body=HELP' })
    const res = await POST(req)
    assert.equal(res.status, 403)
  })
})

// synchronous env helper for pure-function cases
function withEnvSync(overrides: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) { prev[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]! }
  try { fn() } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! }
  }
}
