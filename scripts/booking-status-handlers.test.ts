// Real-handler coverage for the status-transition boundary. The pure matrix tests prove
// policy; these tests prove the public/admin routes preserve their narrower event authority
// and actually refuse illegal writes.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

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
    case 'INCR': {
      const value = Number(kv.get(key) ?? 0) + 1
      kv.set(key, String(value))
      result = value
      break
    }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'PEXPIRE':
    case 'EXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${command}`)
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { PATCH as ADMIN_PATCH } from '../app/api/admin/bookings/[id]/route'
import { POST as CUSTOMER_CANCEL } from '../app/api/booking/[token]/cancel/route'
import { GET as CUSTOMER_VIEW } from '../app/api/booking/[token]/route'
import { createSessionToken } from '../app/api/admin/_lib/session'
import {
  getBookingByToken,
  saveBooking,
  type Booking,
  type BookingStatus,
} from '../app/lib/bookings'

const TOKEN = 'f'.repeat(64)

const booking = (status: BookingStatus): Booking => ({
  token: TOKEN,
  bookingNumber: 'JK-B-STATUS',
  customerName: 'Status Test',
  serviceType: 'moving',
  items: [],
  invoiceAmountCents: 50_000,
  depositAmountCents: 10_000,
  amountPaidCents: 0,
  availableDates: ['2026-08-01'],
  availableWindows: ['8am–10am'],
  status,
  payments: [],
  createdAt: 1,
  updatedAt: 1,
})

async function seed(status: BookingStatus, extra: Partial<Booking> = {}): Promise<void> {
  kv.clear()
  zsets.clear()
  await saveBooking({ ...booking(status), ...extra })
}

async function customerView() {
  const request = new NextRequest(`http://localhost/api/booking/${TOKEN}`)
  return CUSTOMER_VIEW(request, { params: Promise.resolve({ token: TOKEN }) })
}

async function adminPatch(body: Record<string, unknown>) {
  const session = await createSessionToken()
  const request = new NextRequest(`http://localhost/api/admin/bookings/${TOKEN}`, {
    method: 'PATCH',
    headers: {
      cookie: `jk_admin_session=${session}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return ADMIN_PATCH(request, { params: Promise.resolve({ id: TOKEN }) })
}

test('public view preserves Zelle-review status while recording the view', async () => {
  await seed('pending_zelle_verification')
  const response = await customerView()
  assert.equal(response.status, 200)
  const saved = await getBookingByToken(TOKEN)
  assert.equal(saved?.status, 'pending_zelle_verification')
  assert.ok(saved?.customerViewedAt)
})

test('public view preserves payment state that the old event whitelist did not own', async () => {
  await seed('payment_received')
  const response = await customerView()
  assert.equal(response.status, 200)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'payment_received')
})

test('public view still advances booking_created to customer_viewed', async () => {
  await seed('booking_created')
  const response = await customerView()
  assert.equal(response.status, 200)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'customer_viewed')
})

test('resending a link never downgrades recorded customer-view evidence', async () => {
  await seed('customer_viewed')
  const response = await adminPatch({ action: 'send-link' })
  assert.equal(response.status, 200)
  const saved = await getBookingByToken(TOKEN)
  assert.equal(saved?.status, 'customer_viewed')
  assert.ok(saved?.confirmationLinkSentAt)
})

test('illegal admin lifecycle transition returns 400 and writes nothing', async () => {
  await seed('completed')
  const response = await adminPatch({ action: 'mark-in-progress' })
  assert.equal(response.status, 400)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'completed')
})

test('customer cancellation refuses a refunded booking and writes nothing', async () => {
  await seed('refunded')
  const request = new NextRequest(`http://localhost/api/booking/${TOKEN}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  })
  const response = await CUSTOMER_CANCEL(request, {
    params: Promise.resolve({ token: TOKEN }),
  })
  assert.equal(response.status, 409)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'refunded')
})

// ── Closure reversal through the real admin handler ─────────────────────────

test('reopen recovers a mis-clicked Mark complete and clears completedAt', async () => {
  await seed('completed', { completedAt: 1_700_000_000_000 })
  const before = await getBookingByToken(TOKEN)
  assert.equal(before?.status, 'completed')
  assert.equal(before?.completedAt, 1_700_000_000_000, 'the stamp must exist before we assert it is cleared')

  const response = await adminPatch({ action: 'reopen', status: 'in_progress', reason: 'marked complete by mistake' })
  assert.equal(response.status, 200)
  const saved = await getBookingByToken(TOKEN)
  assert.equal(saved?.status, 'in_progress')
  assert.equal(saved?.completedAt, undefined, 'the record must stop claiming it finished')
  const event = saved?.events?.find((e) => e.action === 'booking.reopened')
  assert.ok(event, 'every reopen must leave an audit event')
  assert.equal(event?.result, 'completed → in_progress')
  assert.match(saved?.internalNotes ?? '', /REOPENED completed → in_progress/)
})

test('reopen recovers a mis-clicked Cancel and clears cancelledAt', async () => {
  // A booking that was confirmed before being cancelled by mistake: it has a real date and
  // money on file, so it satisfies the confirmed precondition on the way back.
  await seed('cancelled', {
    cancelledAt: 1_700_000_000_000,
    selectedDate: '2026-08-01',
    selectedWindow: '8am–10am',
    amountPaidCents: 10_000,
  })
  assert.equal((await getBookingByToken(TOKEN))?.cancelledAt, 1_700_000_000_000)
  const response = await adminPatch({ action: 'reopen', status: 'confirmed' })
  assert.equal(response.status, 200)
  const saved = await getBookingByToken(TOKEN)
  assert.equal(saved?.status, 'confirmed')
  assert.equal(saved?.cancelledAt, undefined)
})

test('reopen refuses a live booking and writes nothing', async () => {
  await seed('confirmed')
  const response = await adminPatch({ action: 'reopen', status: 'in_progress' })
  assert.equal(response.status, 400)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'confirmed')
})

test('reopen refuses a target outside the allowlist and writes nothing', async () => {
  await seed('completed')
  const response = await adminPatch({ action: 'reopen', status: 'refunded' })
  assert.equal(response.status, 400)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'completed')
})

test('reopen requires an explicit target — it never guesses', async () => {
  await seed('completed')
  const response = await adminPatch({ action: 'reopen' })
  assert.equal(response.status, 400)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'completed')
})

test('the ordinary status control still refuses to reopen a closed booking', async () => {
  await seed('completed')
  const response = await adminPatch({ action: 'status', fields: { status: 'in_progress' } })
  assert.equal(response.status, 400)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'completed')
})

test('reopen cannot bypass the confirmed precondition', async () => {
  // An unresolved manual review with no date, price or payment: the status action refuses
  // to confirm it, and reopen must refuse for the same reason rather than routing around it.
  await seed('cancelled', {
    cancelledAt: 1_700_000_000_000,
    invoiceAmountCents: 0,
    amountPaidCents: 0,
    availableDates: [],
    aiEstimate: { decision: 'manual_review' } as never,
  })
  const response = await adminPatch({ action: 'reopen', status: 'confirmed' })
  assert.equal(response.status, 400)
  const saved = await getBookingByToken(TOKEN)
  assert.equal(saved?.status, 'cancelled', 'nothing may be written when the guard refuses')
  assert.equal(saved?.cancelledAt, 1_700_000_000_000, 'the closure stamp must survive a refused reopen')
})

test('reopen to a non-confirmed target is unaffected by the confirmed guard', async () => {
  await seed('cancelled', { cancelledAt: 1_700_000_000_000, aiEstimate: { decision: 'manual_review' } as never })
  const response = await adminPatch({ action: 'reopen', status: 'booking_created' })
  assert.equal(response.status, 200)
  assert.equal((await getBookingByToken(TOKEN))?.status, 'booking_created')
})
