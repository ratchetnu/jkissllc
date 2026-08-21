// Booking-backed claims through the real admin route. These tests pin the server
// derivation boundary: a caller supplies only the booking token; customer, crew,
// revenue and job identity always come from the stored booking.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://claims-booking.test'
process.env.KV_REST_API_TOKEN = 'test-token'

const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (_url: string, init: { body?: string }) => {
  const [raw, ...args] = JSON.parse(init.body as string) as string[]
  const command = raw.toUpperCase()
  let result: unknown = null
  switch (command) {
    case 'GET': result = kv.get(args[0]) ?? null; break
    case 'MGET': result = args.map(key => kv.get(key) ?? null); break
    case 'SET': kv.set(args[0], args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(args[0]) ? 1 : 0; break
    case 'INCR': { const n = Number(kv.get(args[0]) ?? 0) + 1; kv.set(args[0], String(n)); result = n; break }
    case 'ZADD': z(args[0]).set(args[2], Number(args[1])); result = 1; break
    case 'ZREVRANGE': {
      const rows = [...z(args[0]).entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member)
      const stop = Number(args[2])
      result = rows.slice(Number(args[1]), stop === -1 ? rows.length : stop + 1)
      break
    }
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    default: result = null
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { POST as claimsPOST } from '../app/api/admin/claims/route'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { listClaims } from '../app/lib/claims'

const CTX = { params: Promise.resolve({} as Record<string, string>) }
const TOKEN = 'b'.repeat(64)
let adminCookie = ''
let managerCookie = ''
let crewCookie = ''

function request(body: Record<string, unknown>, cookie = adminCookie) {
  return claimsPOST(new NextRequest('http://localhost/api/admin/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` },
    body: JSON.stringify({
      claimType: 'property_damage', claimDate: '2026-08-14', reportedDate: '2026-08-14',
      total: '250.00', description: 'Customer reported wall damage.', ...body,
    }),
  }), CTX)
}

async function reset() {
  kv.clear(); zsets.clear()
  adminCookie = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  managerCookie = await createUserSessionToken({ id: 'u_manager', role: 'manager' })
  crewCookie = await createUserSessionToken({ id: 'u_crew', role: 'crew', staffId: 'crew-1' })
  await saveBooking({
    token: TOKEN, bookingNumber: 'JK-B-2201', status: 'completed', serviceType: 'moving',
    customerName: 'Real Customer', customerPhone: '2145550100', customerEmail: 'real@example.test',
    jobSiteAddress: '100 Real Job St', selectedDate: '2026-08-14',
    invoiceAmountCents: 60000, discountCents: 5000, amountPaidCents: 55000,
    disposalActualCents: 5000, depositAmountCents: 0,
    items: [], payments: [], availableDates: [], availableWindows: [],
    assignees: [
      { staffId: 'crew-1', name: 'Crew One', role: 'Driver', token: '1'.repeat(64), payCents: 17500 },
      { staffId: 'crew-2', name: 'Declined Crew', role: 'Helper', token: '2'.repeat(64), payCents: 99999, declinedAt: 1 },
    ],
    createdAt: 1, updatedAt: 1,
  } as unknown as Booking)
}

test('booking claim copies the server booking and ignores forged customer, crew and money fields', async () => {
  await reset()
  const res = await request({
    bookingToken: TOKEN,
    businessName: 'Forged Customer', routeToken: undefined,
    snapshot: { businessPriceCents: 1, crew: [{ staffId: 'attacker', name: 'Attacker' }] },
    bookingNumber: 'FAKE-1', customerEmail: 'attacker@example.test',
  })
  assert.equal(res.status, 200)
  const [claim] = await listClaims()
  assert.equal(claim.businessName, 'Real Customer')
  assert.equal(claim.businessKey, `booking:${TOKEN}`)
  assert.equal(claim.bookingToken, TOKEN)
  assert.equal(claim.bookingNumber, 'JK-B-2201')
  assert.equal(claim.snapshot.businessPriceCents, 55000)
  assert.equal(claim.snapshot.routePayoutCents, 17500)
  assert.equal(claim.snapshot.routeProfitCents, 32500)
  assert.deepEqual(claim.snapshot.crew.map(c => c.staffId), ['crew-1'])
  assert.deepEqual(claim.assignments, [], 'opening a claim never assigns a deduction')
})

test('manager may open a booking claim but crew may not', async () => {
  await reset()
  assert.equal((await request({ bookingToken: TOKEN }, managerCookie)).status, 200)
  assert.equal((await request({ bookingToken: TOKEN }, crewCookie)).status, 403)
  assert.equal((await listClaims()).length, 1, 'the denied request writes nothing')
})

test('booking and route identities cannot be combined and missing bookings fail closed', async () => {
  await reset()
  const mixed = await request({ bookingToken: TOKEN, routeToken: 'a'.repeat(64) })
  assert.equal(mixed.status, 400)
  assert.match((await mixed.json()).error, /one job only/)
  const missing = await request({ bookingToken: 'c'.repeat(64) })
  assert.equal(missing.status, 404)
  assert.equal((await listClaims()).length, 0)
})

test('a booking claim waits for the job outcome so its crew and money snapshot is final', async () => {
  await reset()
  const rawKey = [...kv.keys()].find(key => key.endsWith(`bk:${TOKEN}`))!
  const booking = JSON.parse(kv.get(rawKey)!) as Booking
  booking.status = 'in_progress'
  kv.set(rawKey, JSON.stringify(booking))
  const res = await request({ bookingToken: TOKEN })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /Finish the job/)
  assert.equal((await listClaims()).length, 0)
})

test('the booking and claim screens expose the joined workflow', () => {
  const bookingPage = readFileSync(new URL('../app/admin/bookings/page.tsx', import.meta.url), 'utf8')
  assert.match(bookingPage, /claims\.filter\(c => c\.bookingToken === b\.token\)/)
  assert.match(bookingPage, /bookingToken=\{b\.token\}/)
  assert.match(bookingPage, /Opening a claim never deducts pay by itself/)
  assert.match(bookingPage, /CLAIMABLE_BOOKING_STATUSES\.has\(b\.status\)/)

  const claimDetail = readFileSync(new URL('../app/admin/operations/claims/[id]/page.tsx', import.meta.url), 'utf8')
  assert.match(claimDetail, /View \{snap\.bookingNumber/)
  assert.match(claimDetail, /fromBooking \? 'Job earned' : 'Route earned'/)
})
