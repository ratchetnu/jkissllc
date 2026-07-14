// FULL-LIFECYCLE end-to-end through the REAL route handlers (admin PATCH + customer
// verify), in-memory Upstash, no network, no real comms: an online manual_review
// Book Now request → owner prices it → customer verifies the service date → deposit
// paid → CONFIRMED — asserting the guard, the invoice, and the audit trail at every
// step. This is the create→confirm path that no single test covered before.
import assert from 'node:assert/strict'
import test, { before } from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
let providerCalls = 0
globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) { providerCalls++; return { ok: true, status: 200, json: async () => ({}) } }
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (cmd.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { PATCH } from '../app/api/admin/bookings/[id]/route'
import { POST as VERIFY } from '../app/api/booking/[token]/verify/route'
import { saveBooking, getBookingByToken, type Booking } from '../app/lib/bookings'
import { createSessionToken } from '../app/api/admin/_lib/session'
import { NextRequest } from 'next/server'

const TOKEN = 'e'.repeat(64)
const DATE = '2026-08-01'
const WINDOW = '8am–10am'
const events = async () => ((await getBookingByToken(TOKEN))!.events ?? []).map(e => e.action)

async function adminPatch(body: Record<string, unknown>, cookie: string) {
  const req = new NextRequest(`http://localhost/api/admin/bookings/${TOKEN}`, {
    method: 'PATCH', headers: { cookie: `jk_admin_session=${cookie}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await PATCH(req, { params: Promise.resolve({ id: TOKEN }) })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}
async function customerVerify(body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/booking/${TOKEN}/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await VERIFY(req, { params: Promise.resolve({ token: TOKEN }) })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

// Stage 0 — an online Book Now request the AI routed to manual_review (no items),
// scheduling options offered, NO customer contact on file (so nothing can be sent).
before(async () => {
  await saveBooking({
    token: TOKEN, bookingNumber: 'JK-B-8000', customerName: 'E2E Customer', serviceType: 'junk_removal' as never,
    items: [], invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
    availableDates: [DATE], availableWindows: [WINDOW], status: 'quote_received', payments: [],
    source: 'online', aiEstimate: { decision: 'manual_review', pricing: { recommendedUsd: 770 } } as never,
    createdAt: 1, updatedAt: 1,
  } as Booking)
})

test('stage 1 — premature confirm is BLOCKED (no date, no price yet)', async () => {
  const admin = await createSessionToken()
  const { status } = await adminPatch({ action: 'update', fields: { status: 'confirmed' } }, admin)
  assert.equal(status, 400)
  assert.equal((await getBookingByToken(TOKEN))!.status, 'quote_received')
})

test('stage 2 — owner sets the manual price (Approve Only): invoice recorded, workflow advances', async () => {
  const admin = await createSessionToken()
  const { status } = await adminPatch({ action: 'approve-final', amount: 1300, send: false }, admin)
  assert.equal(status, 200)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.invoiceAmountCents, 130000)                 // owner-entered price
  assert.equal(providerCalls, 0)                              // Approve Only sent nothing
  assert.ok((b!.events ?? []).some(e => e.action === 'ai.owner_approved'))
})

test('stage 3 — customer verifies the service date + window (time_verified, not yet confirmed)', async () => {
  const { status } = await customerVerify({ selectedDate: DATE, selectedWindow: WINDOW, agreementAccepted: true })
  assert.equal(status, 200)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.selectedDate, DATE)
  assert.ok(b!.customerTimeVerifiedAt)
  assert.equal(b!.status, 'time_verified')                    // scheduled but unpaid → not confirmed
})

test('stage 4 — deposit recorded → booking becomes CONFIRMED and the transition is audited', async () => {
  const admin = await createSessionToken()
  const { status } = await adminPatch({ action: 'record-payment', amount: 260, type: 'deposit', method: 'cash' }, admin)
  assert.equal(status, 200)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.status, 'confirmed')
  assert.ok(b!.confirmedAt)
  assert.ok(b!.amountPaidCents > 0)
  assert.ok((b!.events ?? []).some(e => e.action === 'booking.confirmed'))   // confirmation is NOT silent
})

test('stage 5 — the full audit trail is present and no customer comms were sent', async () => {
  const acts = await events()
  for (const a of ['ai.owner_approved', 'booking.confirmed'] as const) assert.ok(acts.includes(a), `missing event: ${a}`)
  assert.equal(providerCalls, 0)                              // whole lifecycle: zero email/SMS provider calls
})
