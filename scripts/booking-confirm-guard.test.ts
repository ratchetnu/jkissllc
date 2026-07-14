// Premature-confirmation guard: a booking may only become `confirmed` when it is
// genuinely locked in (real date + priced/paid, no unresolved manual review). Pure
// guard tests + end-to-end through the REAL admin PATCH handler (in-memory Upstash),
// proving the admin status control can no longer silently confirm a blank/no-price
// manual_review record (the JK-B-1008 defect) and that every change is audited.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
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
import { canMarkConfirmed, saveBooking, getBookingByToken, type Booking } from '../app/lib/bookings'
import { createSessionToken } from '../app/api/admin/_lib/session'
import { NextRequest } from 'next/server'

// ── Pure guard ────────────────────────────────────────────────────────────────
const base = (o: Partial<Booking> = {}): Booking => ({ selectedDate: undefined, invoiceAmountCents: 0, amountPaidCents: 0, ...o } as Booking)

test('guard: unresolved manual_review (no price) can never be confirmed', () => {
  const g = canMarkConfirmed(base({ selectedDate: '2026-08-01', aiEstimate: { decision: 'manual_review' } as never }))
  assert.equal(g.ok, false)
  assert.match(!g.ok ? g.reason : '', /manual review/)
})

test('guard: no scheduled date blocks confirmation', () => {
  const g = canMarkConfirmed(base({ selectedDate: undefined, invoiceAmountCents: 50000 }))
  assert.equal(g.ok, false)
  assert.match(!g.ok ? g.reason : '', /service date/)
})

test('guard: a scheduled date but no priced quote or payment blocks confirmation', () => {
  const g = canMarkConfirmed(base({ selectedDate: '2026-08-01' }))
  assert.equal(g.ok, false)
  assert.match(!g.ok ? g.reason : '', /priced quote or payment/)
})

test('guard: scheduled date + a priced invoice may be confirmed', () => {
  assert.equal(canMarkConfirmed(base({ selectedDate: '2026-08-01', invoiceAmountCents: 50000 })).ok, true)
})

test('guard: scheduled date + a payment may be confirmed (no invoice required)', () => {
  assert.equal(canMarkConfirmed(base({ selectedDate: '2026-08-01', amountPaidCents: 7500 })).ok, true)
})

test('guard: a manual_review that has been PRICED (owner set an invoice) is resolved and confirmable', () => {
  assert.equal(canMarkConfirmed(base({ selectedDate: '2026-08-01', invoiceAmountCents: 130000, aiEstimate: { decision: 'manual_review' } as never })).ok, true)
})

// ── End-to-end through the real admin PATCH handler ─────────────────────────────
const TOKEN = 'c'.repeat(64)
const mk = (o: Partial<Booking> = {}): Booking => ({
  token: TOKEN, bookingNumber: 'JK-B-7008', customerName: 'Guard Test', serviceType: 'moving', items: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0, availableDates: [], availableWindows: [],
  status: 'quote_received', payments: [], source: 'online', createdAt: 1, updatedAt: 1, ...o,
}) as Booking
async function seed(o: Partial<Booking> = {}) { kv.clear(); zsets.clear(); await saveBooking(mk(o)) }
async function patch(body: Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = `jk_admin_session=${cookie}`
  const req = new NextRequest(`http://localhost/api/admin/bookings/${TOKEN}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  const res = await PATCH(req, { params: Promise.resolve({ id: TOKEN }) })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

test('JK-B-1008 repro: admin cannot set a no-date, no-price manual_review booking to confirmed (400)', async () => {
  await seed({ status: 'quote_received', aiEstimate: { decision: 'manual_review' } as never })
  const admin = await createSessionToken()
  const { status } = await patch({ action: 'update', fields: { status: 'confirmed' } }, admin)
  assert.equal(status, 400)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.status, 'quote_received')                    // status was NOT changed
  assert.ok(!(b!.events ?? []).some(e => e.action === 'status.changed'))
})

test('a valid booking (date + invoice) can be confirmed, is stamped, and is AUDITED', async () => {
  await seed({ status: 'time_verified', selectedDate: '2026-08-01', selectedWindow: '8am–10am', invoiceAmountCents: 50000 })
  const admin = await createSessionToken()
  const { status } = await patch({ action: 'update', fields: { status: 'confirmed' } }, admin)
  assert.equal(status, 200)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.status, 'confirmed')
  assert.ok(b!.confirmedAt)                                     // lifecycle timestamp stamped
  assert.ok((b!.events ?? []).some(e => e.action === 'status.changed' && /confirmed/.test(String(e.result))))
})

test('duplicate confirm is idempotent (already confirmed → no error, no duplicate event)', async () => {
  await seed({ status: 'confirmed', selectedDate: '2026-08-01', selectedWindow: '8am–10am', invoiceAmountCents: 50000, confirmedAt: 111 })
  const admin = await createSessionToken()
  const { status } = await patch({ action: 'update', fields: { status: 'confirmed' } }, admin)
  assert.equal(status, 200)
  const b = await getBookingByToken(TOKEN)
  assert.equal((b!.events ?? []).filter(e => e.action === 'status.changed').length, 0) // no-op transition
})

test('saving an AI override does NOT change the booking status (override ≠ confirm)', async () => {
  await seed({ status: 'quote_received', aiEstimate: { decision: 'manual_review', pricing: { recommendedUsd: 770 } } as never })
  const admin = await createSessionToken()
  const { status } = await patch({ action: 'ai-override', overriddenUsd: 1300, reason: 'Not cleaning out garage' }, admin)
  assert.equal(status, 200)
  const b = await getBookingByToken(TOKEN)
  assert.equal(b!.status, 'quote_received')                    // still not confirmed
})

test('AUTHZ: an unauthenticated status change is refused 401', async () => {
  await seed({ status: 'time_verified', selectedDate: '2026-08-01', invoiceAmountCents: 50000 })
  const { status } = await patch({ action: 'update', fields: { status: 'confirmed' } }) // no cookie
  assert.equal(status, 401)
})
