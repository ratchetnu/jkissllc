// End-to-end through the REAL admin booking route handler: proves the sandbox
// outbound guard on `approve-final`. A SANDBOX (isTest) record's "Approve & Send"
// must set the invoice + timeline but NEVER reach an SMS/email provider, while a
// real booking's send still hits the provider. No network, no real data: Upstash is
// an in-memory fetch stub and the Twilio REST call is a spy that records the attempt.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
// Twilio "configured" so a REAL send would actually attempt the provider call.
process.env.TWILIO_ACCOUNT_SID = 'ACtest'
process.env.TWILIO_AUTH_TOKEN = 'twilio-secret'
process.env.TWILIO_FROM = '+15550000000'
delete process.env.RESEND_API_KEY // email path stays off — we probe the SMS provider only

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
let providerCalls: string[] = [] // every non-Upstash (provider) fetch URL

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url === UPSTASH) {
    const [cmd, ...args] = JSON.parse(init.body as string) as string[]
    const key = args[0]
    let result: unknown = null
    switch (cmd.toUpperCase()) {
      case 'GET': result = kv.get(key) ?? null; break
      case 'SET': kv.set(key, args[1]); result = 'OK'; break // covers SET … NX PX (lock acquire) too
      case 'DEL': kv.delete(key); result = 1; break
      case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
      case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
      case 'ZREM': z(key).delete(args[1]); result = 1; break
      case 'PEXPIRE': case 'EXPIRE': result = 1; break
      default: throw new Error(`fake redis: unhandled ${cmd}`)
    }
    return { ok: true, json: async () => ({ result }) }
  }
  // Any other host = an outbound provider call (Twilio here). Record + fake success.
  providerCalls.push(url)
  return { ok: true, status: 200, json: async () => ({ sid: 'SMtest', status: 'queued' }) }
}) as unknown as typeof fetch

// Static imports are safe: lib/redis reads env + global fetch lazily inside call().
import { PATCH } from '../app/api/admin/bookings/[id]/route'
import { saveBooking, getBookingByToken, type Booking } from '../app/lib/bookings'
import { createSessionToken, createUserSessionToken } from '../app/api/admin/_lib/session'
import { NextRequest } from 'next/server'

const TOKEN = 'a'.repeat(64)

const mkBooking = (o: Partial<Booking> = {}): Booking => ({
  token: TOKEN, bookingNumber: 'JK-B-9001', customerName: 'Sandbox Tester',
  customerPhone: '+15551234567', serviceType: 'moving', items: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
  availableDates: ['2026-08-01'], availableWindows: ['8am–10am'],
  status: 'booking_created', payments: [], source: 'online',
  aiEstimate: { decision: 'manual_review' } as never,
  createdAt: 1, updatedAt: 1,
  ...o,
}) as Booking

async function seed(o: Partial<Booking> = {}) {
  kv.clear(); zsets.clear(); providerCalls = []
  await saveBooking(mkBooking(o))
}

async function patch(body: Record<string, unknown>, cookie: string) {
  const req = new NextRequest(`http://localhost/api/admin/bookings/${TOKEN}`, {
    method: 'PATCH',
    headers: { cookie: `jk_admin_session=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await PATCH(req, { params: Promise.resolve({ id: TOKEN }) })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

// ── Sandbox: Approve & Send is SIMULATED — no provider call ───────────────────
test('sandbox Approve & Send: sets invoice + timeline but never contacts a provider', async () => {
  await seed({ isTest: true })
  const admin = await createSessionToken()
  const { status, json } = await patch({ action: 'approve-final', send: true, amount: 350 }, admin)

  assert.equal(status, 200)
  assert.equal(json.simulated, true)                       // controlled test-record response
  assert.equal(providerCalls.length, 0)                    // ← NO email/SMS provider was called
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.invoiceAmountCents, 35000)               // owner-entered price recorded
  assert.ok(b!.confirmationLinkSentAt)                     // send is stamped (duplicate-send guard armed)
  assert.ok(b!.events?.some(e => e.action === 'ai.quote_simulated'))  // audit trail flags the simulation
})

// ── Sandbox: duplicate-send protection still 409s the second send ─────────────
test('sandbox duplicate Approve & Send is refused (409) — idempotency intact', async () => {
  await seed({ isTest: true })
  const admin = await createSessionToken()
  await patch({ action: 'approve-final', send: true, amount: 350 }, admin)   // first send (simulated)
  providerCalls = []
  const second = await patch({ action: 'approve-final', send: true, amount: 350 }, admin)
  assert.equal(second.status, 409)
  assert.equal(providerCalls.length, 0)
})

// ── Sandbox: Approve Only succeeds and delivers nothing ───────────────────────
test('sandbox Approve Only: succeeds, records the price, sends nothing', async () => {
  await seed({ isTest: true })
  const admin = await createSessionToken()
  const { status, json } = await patch({ action: 'approve-final', send: false, amount: 350 }, admin)
  assert.equal(status, 200)
  assert.ok(json.confirmLink)                              // approve-only returns the link, doesn't send
  assert.equal(providerCalls.length, 0)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.invoiceAmountCents, 35000)
  assert.ok(!b!.confirmationLinkSentAt)                    // nothing was sent
})

// ── Real booking: production send path unchanged (provider IS called) ─────────
test('real (non-test) Approve & Send: production path still contacts the provider', async () => {
  await seed({ isTest: false })
  const admin = await createSessionToken()
  const { status, json } = await patch({ action: 'approve-final', send: true, amount: 350 }, admin)
  assert.equal(status, 200)
  assert.notEqual(json.simulated, true)
  assert.equal(providerCalls.length, 1)                    // ← the real Twilio send fired
  assert.ok(providerCalls[0].includes('api.twilio.com'))
})

// ── Authorization: only admin may approve/send ────────────────────────────────
test('non-admin (manager) Approve & Send is refused 403 — no provider call', async () => {
  await seed({ isTest: true })
  const manager = await createUserSessionToken({ id: 'mgr', role: 'manager' })
  const { status } = await patch({ action: 'approve-final', send: true, amount: 350 }, manager)
  assert.equal(status, 403)
  assert.equal(providerCalls.length, 0)
})
