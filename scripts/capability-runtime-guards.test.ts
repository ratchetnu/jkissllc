// ── Runtime enforcement, at the routes and at the send paths ────────────────
//
// The distinction this file exists to prove: hiding a button is not a control. An
// optional capability that is only enforced in the UI is enforced nowhere, because
// the route is still reachable with curl.
//
// It also proves the other half of the deal — that a business which runs NO optional
// integrations can still do its work. A refusal must always name the alternative,
// because "we do not take cards" is a product fact, not an outage.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
// No STRIPE_SECRET_KEY, no TWILIO_*, no RESEND_API_KEY: a Supercharged-shaped
// deployment. With no explicit owner choice, each adapter infers "not in use".

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [command, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (command.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'INCR': { const v = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(v)); result = v; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const values = [...z(key)].sort((a, b) => a[1] - b[1]).map(([m]) => m)
      if (command.toUpperCase() === 'ZREVRANGE') values.reverse()
      const start = Number(args[1]); const stop = Number(args[2])
      result = values.slice(start, stop === -1 ? undefined : stop + 1)
      break
    }
    case 'PEXPIRE':
    case 'EXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${command}`)
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { GET as CAPS_GET, PATCH as CAPS_PATCH } from '../app/api/admin/capabilities/route'
import { createSessionToken, createUserSessionToken } from '../app/api/admin/_lib/session'
import { sendSmsDetailed } from '../app/lib/sms'
import { emailRaw } from '../app/lib/booking-emails'
import { requireCardPayments } from '../app/lib/stripe'
import { CapabilityUnavailableError, capabilityErrorBody, GUARDED_ENTRY_POINTS } from '../app/lib/platform/capabilities/guard'

const url = 'http://localhost/api/admin/capabilities'
const req = async (method: 'GET' | 'PATCH', token: string, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { cookie: `jk_admin_session=${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

// ── Provider actions fail closed when the capability is not ready ────────────

test('outbound SMS refuses with a STABLE code, and names the alternative', async () => {
  const r = await sendSmsDetailed('+15555550123', 'hello')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.capabilityCode, 'capability_disabled')
  // A product fact, not an outage — and it points somewhere useful.
  assert.match(r.ok === false ? r.error : '', /turned off|admin|portal/i)
})

test('email refuses with a STABLE code, and points at manual delivery', async () => {
  const r = await emailRaw({ to: ['a@example.com'], subject: 's', html: 'h' })
  assert.equal(r.ok, false)
  assert.equal(r.capabilityCode, 'capability_disabled')
  assert.match(r.error ?? '', /manually|turned off/i)
})

test('starting a card payment throws a TYPED refusal, not a generic error', async () => {
  await assert.rejects(
    () => requireCardPayments(),
    (e: unknown) => {
      assert.ok(e instanceof CapabilityUnavailableError)
      assert.equal(e.capability, 'payments-stripe')
      assert.equal(e.code, 'capability_disabled')
      // 409 = "this business does not do that" (a configuration answer the caller
      // can act on), NOT 503 = "it is meant to work and does not".
      assert.equal(e.httpStatus, 409)
      return true
    },
  )
})

test('a refusal body carries a code and variable NAMES — never a value', async () => {
  try { await requireCardPayments() } catch (e) {
    const body = capabilityErrorBody(e as CapabilityUnavailableError)
    assert.equal(body.code, 'capability_disabled')
    assert.equal(body.capability, 'payments-stripe')
    assert.equal(JSON.stringify(body).includes('sk_'), false)
  }
})

test('every entry point the platform CLAIMS is guarded exists', async () => {
  const { readFileSync } = await import('node:fs')
  for (const path of GUARDED_ENTRY_POINTS) {
    assert.ok(readFileSync(path, 'utf8').length > 0, `${path} does not exist`)
  }
})

// ── Route authorization ──────────────────────────────────────────────────────

test('an UNAUTHENTICATED capability read is refused', async () => {
  const res = await CAPS_GET(new NextRequest(url, { method: 'GET' }), { params: Promise.resolve({}) } as never)
  assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`)
})

test('an UNAUTHENTICATED capability change is refused', async () => {
  const res = await CAPS_PATCH(
    new NextRequest(url, { method: 'PATCH', body: JSON.stringify({ capabilities: { 'sms-delivery': { selection: 'enabled' } } }) }),
    { params: Promise.resolve({}) } as never,
  )
  assert.ok(res.status === 401 || res.status === 403)
})

test('a CREW session cannot read or change capability configuration', async () => {
  const token = await createUserSessionToken({ id: 'crew-1', role: 'crew', staffId: 'staff-1' })
  assert.equal((await CAPS_GET(await req('GET', token), { params: Promise.resolve({}) } as never)).status, 403)
  assert.equal((await CAPS_PATCH(await req('PATCH', token, { capabilities: { 'sms-delivery': { selection: 'enabled' } } }), { params: Promise.resolve({}) } as never)).status, 403)
})

test('a MANAGER cannot change capability configuration — settings:manage is admin-only', async () => {
  const token = await createUserSessionToken({ id: 'mgr-1', role: 'manager' })
  const res = await CAPS_PATCH(await req('PATCH', token, { capabilities: { 'sms-delivery': { selection: 'enabled' } } }), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 403)
})

test('an ADMIN can read, and the response is value-free', async () => {
  const token = await createSessionToken()
  const res = await CAPS_GET(await req('GET', token), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.capabilities))
  const sms = body.capabilities.find((c: { id: string }) => c.id === 'sms-delivery')
  assert.equal(sms.state, 'disabled')
  assert.equal(sms.code, 'capability_disabled')
  assert.equal(sms.enabled, false)
  // Names, never values.
  const blob = JSON.stringify(body)
  assert.ok(!/sk_live|sk_test|AC[0-9a-f]{16}|re_[A-Za-z0-9]/.test(blob))
})

test('a FORGED tenant id in the body is ignored — the tenant is server-resolved', async () => {
  const token = await createSessionToken()
  const res = await CAPS_PATCH(
    await req('PATCH', token, {
      // A client naming another business must not be able to address it.
      tenantId: 'some-other-business',
      businessId: 'some-other-business',
      capabilities: { 'sms-delivery': { selection: 'enabled' } },
    }),
    { params: Promise.resolve({}) } as never,
  )
  assert.equal(res.status, 200)
  // The write landed on the SERVER-RESOLVED tenant (the reference tenant), and
  // nothing was written under the id the client named.
  assert.ok([...kv.keys()].some(k => k.endsWith('settings:capabilities')))
  assert.ok(![...kv.keys()].some(k => k.includes('some-other-business')), 'a client-named tenant was addressed')
})

test('an impossible configuration is refused with 409 and named errors', async () => {
  const token = await createSessionToken()
  const res = await CAPS_PATCH(await req('PATCH', token, { capabilities: { 'audit-logs': { selection: 'disabled' } } }), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.ok(body.errors.some((e: { code: string }) => e.code === 'capability_mandatory'))
})

test('a pasted secret in credentialRef is refused by the ROUTE, not just the store', async () => {
  const token = await createSessionToken()
  const res = await CAPS_PATCH(
    await req('PATCH', token, { capabilities: { 'sms-delivery': { selection: 'enabled', credentialRef: 'AC0123 my auth token' } } }),
    { params: Promise.resolve({}) } as never,
  )
  assert.equal(res.status, 409)
  assert.ok(!JSON.stringify([...kv.values()]).includes('AC0123'))
})

// ── The other half: the business can still do its work ──────────────────────

test('turning SMS ON makes the refusal say SETUP REQUIRED, not "turned off"', async () => {
  const token = await createSessionToken()
  const res = await CAPS_PATCH(await req('PATCH', token, { capabilities: { 'sms-delivery': { selection: 'enabled' } } }), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 200)
  const r = await sendSmsDetailed('+15555550123', 'hello')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.capabilityCode, 'capability_setup_required')

  // …and the health/readiness view names the variables still missing.
  const view = await (await CAPS_GET(await req('GET', token), { params: Promise.resolve({}) } as never)).json()
  const sms = view.capabilities.find((c: { id: string }) => c.id === 'sms-delivery')
  assert.equal(sms.code, 'capability_setup_required')
  assert.ok(sms.missingVars.length > 0)
  assert.ok(sms.missingVars.every((v: string) => /^[A-Z]/.test(v)), 'variable NAMES only')

  // Put it back so later assertions read a clean "not in use".
  await CAPS_PATCH(await req('PATCH', token, { capabilities: { 'sms-delivery': { selection: 'disabled' } } }), { params: Promise.resolve({}) } as never)
})

test('core capabilities stay ready on a deployment with NO optional integrations', async () => {
  const token = await createSessionToken()
  const view = await (await CAPS_GET(await req('GET', token), { params: Promise.resolve({}) } as never)).json()
  const byId = Object.fromEntries(view.capabilities.map((c: { id: string; code: string }) => [c.id, c.code]))
  for (const id of ['bookings', 'invoicing', 'payments', 'messaging', 'notifications', 'routes', 'reporting', 'contractor-compensation']) {
    assert.equal(byId[id], 'capability_ready', `${id} must work without Stripe, Twilio or Resend`)
  }
})

test('the manual alternatives are the ones a business would actually reach for', async () => {
  const token = await createSessionToken()
  const view = await (await CAPS_GET(await req('GET', token), { params: Promise.resolve({}) } as never)).json()
  const byId = Object.fromEntries(view.capabilities.map((c: { id: string; code: string }) => [c.id, c.code]))
  // No card processor → the payment LEDGER is still live, so cash/check/Zelle can be
  // recorded and an invoice can be marked paid.
  assert.equal(byId['payments'], 'capability_ready')
  assert.equal(byId['payments-stripe'], 'capability_disabled')
  // No SMS → messaging records and the crew/customer portals are still live.
  assert.equal(byId['messaging'], 'capability_ready')
  assert.equal(byId['crew-portal'], 'capability_ready')
  assert.equal(byId['customer-portal'], 'capability_ready')
  // No email → notification records still exist; delivery is what is off.
  assert.equal(byId['notifications'], 'capability_ready')
  assert.equal(byId['email-delivery'], 'capability_disabled')
})
