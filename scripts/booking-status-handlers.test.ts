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

async function seed(status: BookingStatus): Promise<void> {
  kv.clear()
  zsets.clear()
  await saveBooking(booking(status))
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
