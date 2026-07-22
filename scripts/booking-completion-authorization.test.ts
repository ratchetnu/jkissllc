// Crew booking-completion authorization — behavioral, against the REAL route
// handlers, an in-memory Upstash fake, and a genuinely signed crew session.
//
// WHY THIS FILE EXISTS. `POST /api/portal/jobs/[id]` with `action: 'complete'`
// shipped without an assignment check: `recordBookingCompletion` took no staffId,
// so any authenticated crew principal holding a booking token could stamp
// completion photos, a note, and `jobCompletedAt` onto a job that was not theirs.
// The booking token is the CUSTOMER's link key — it is not a crew credential, and
// a crew member who was removed from (or declined) a job keeps the token they
// already saw. accept / decline / clock_in / clock_out all guarded this correctly;
// only `complete` did not.
//
// The unit suite could not catch it: the gap was in the ROUTE↔orchestrator seam,
// not in any pure function. So these drive the handler.
import assert from 'node:assert/strict'
import test from 'node:test'

// Must be set before any handler runs; redis.ts + the session signer read env lazily.
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
// Bind this "deployment" to the Preview Blob store, so the store-pinning half of
// the photo policy is exercised end to end and not just as a pure function.
process.env.BLOB_STORE_ID = 'store_Ulabe9q3GBD8ZYQh'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (String(cmd).toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREVRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1); break
    }
    case 'EXPIRE': case 'PEXPIRE': result = 1; break
    // The booking compare-and-swap. Mirrors lib/bookings.CAS_SCRIPT: write only if
    // the stored record's `version` still matches what the caller loaded.
    case 'EVAL': {
      const [, , casKey, payload, expected] = args as unknown as string[]
      const raw = kv.get(casKey)
      let current = 0
      if (raw) { try { current = Number((JSON.parse(raw) as { version?: number }).version ?? 0) } catch { current = 0 } }
      if (current === Number(expected)) { kv.set(casKey, payload); result = 1 } else { result = 0 }
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { saveBooking, getBookingByToken, type Booking } from '../app/lib/bookings'
import type { JobAssignee } from '../app/lib/job-assignment'
import { POST as jobPOST, GET as jobGET } from '../app/api/portal/jobs/[id]/route'
import { POST as assignmentPOST } from '../app/api/admin/bookings/[id]/assignment/route'

const PREVIEW_PHOTO = 'https://ulabe9q3gbd8zyqh.public.blob.vercel-storage.com/proof.jpg'
const PROD_PHOTO = 'https://wk8dojzb2q1lu5sv.public.blob.vercel-storage.com/other-store.jpg'
const FOREIGN_PHOTO = 'https://evil.example.com/tracker.gif'

const crewCookie = (staffId: string) => createUserSessionToken({ id: `u_${staffId}`, role: 'crew', staffId })
const adminCookie = () => createUserSessionToken({ id: 'u_admin', role: 'admin' })

const assignee = (staffId: string, o: Partial<JobAssignee> = {}): JobAssignee => ({
  staffId, name: staffId, token: `jt_${staffId}`, confirmedAt: 1_800_000_000_000, ...o,
})

let seq = 0
async function seedBooking(assignees: JobAssignee[]): Promise<string> {
  seq += 1
  // Booking tokens are 64-hex (lib/bookings.generateToken); getBookingByToken
  // rejects anything else outright, so the fixture must look like the real thing.
  const token = seq.toString(16).padStart(64, 'a')
  await saveBooking({
    token,
    bookingNumber: `JK-B-9${seq.toString().padStart(3, '0')}`,
    status: 'confirmed',
    serviceType: 'moving',
    customerName: 'Test Customer',
    items: [], payments: [], availableDates: [], availableWindows: [],
    amountPaidCents: 0, depositAmountCents: 0, invoiceAmountCents: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
    assignees,
  } as unknown as Booking)
  return token
}

const CTX = (id: string) => ({ params: Promise.resolve({ id }) })

function post(id: string, body: unknown, cookie: string): NextRequest {
  return new NextRequest(`http://localhost/api/portal/jobs/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` },
    body: JSON.stringify(body),
  })
}

const complete = (id: string, cookie: string, extra: Record<string, unknown> = {}) =>
  jobPOST(post(id, { action: 'complete', photos: [PREVIEW_PHOTO], note: 'done', ...extra }, cookie), CTX(id))

// ── The assigned crew member CAN complete their own job ──────────────────────
test('an assigned crew member completes their own job and the proof persists', async () => {
  const id = await seedBooking([assignee('crewA')])
  const res = await complete(id, await crewCookie('crewA'))
  assert.equal(res.status, 200)

  const after = await getBookingByToken(id)
  assert.deepEqual(after?.completionPhotos, [PREVIEW_PHOTO])
  assert.equal(after?.completionNote, 'done')
  assert.equal(after?.jobCompletedBy, 'crew')
  assert.ok(after?.jobCompletedAt, 'completion is stamped')
})

// ── The bug this file was written for ────────────────────────────────────────
test('an authenticated but UNASSIGNED crew member cannot complete another booking', async () => {
  const id = await seedBooking([assignee('crewA')])
  const before = await getBookingByToken(id)

  const res = await complete(id, await crewCookie('crewB'))
  assert.equal(res.status, 404, 'a job you are not on must be indistinguishable from absent')
  assert.equal((await res.json()).error, 'not_assigned')

  const after = await getBookingByToken(id)
  assert.equal(after?.completionPhotos, undefined, 'no photo may be attached by a stranger')
  assert.equal(after?.completionNote, undefined)
  assert.equal(after?.jobCompletedAt, undefined, 'the job must not be stamped complete')
  assert.equal(after?.version, before?.version, 'the record must not be written at all')
})

test('a DECLINED crew member cannot complete the job they turned down', async () => {
  const id = await seedBooking([assignee('crewA', { declinedAt: Date.now() })])
  const res = await complete(id, await crewCookie('crewA'))
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'not_assigned')

  const after = await getBookingByToken(id)
  assert.equal(after?.jobCompletedAt, undefined)
})

test('a REMOVED crew member cannot keep completing the job with the token they kept', async () => {
  // The realistic path: they were on the job, saw the booking token in the portal
  // feed, and were then unassigned. The token is still in their hands.
  const id = await seedBooking([assignee('crewA'), assignee('crewB')])
  const cookieA = await crewCookie('crewA')
  assert.equal((await complete(id, cookieA)).status, 200, 'allowed while assigned')

  // Dispatch removes them.
  const removed = await getBookingByToken(id)
  removed!.assignees = (removed!.assignees ?? []).filter(a => a.staffId !== 'crewA')
  await saveBooking(removed!)

  const res = await complete(id, cookieA, { photos: [], note: 'sneaking back in' })
  assert.equal(res.status, 404)
  const after = await getBookingByToken(id)
  assert.equal(after?.completionNote, 'done', 'the note from when they WERE on the job stands; the new one is refused')
})

// ── Reading is gated the same way ────────────────────────────────────────────
test('an unassigned crew member cannot even read the job', async () => {
  const id = await seedBooking([assignee('crewA')])
  const req = new NextRequest(`http://localhost/api/portal/jobs/${id}`, {
    headers: { cookie: `jk_admin_session=${await crewCookie('crewB')}` },
  })
  assert.equal((await jobGET(req, CTX(id))).status, 404)
})

// ── The photo policy holds at the route boundary ─────────────────────────────
test('a foreign-host photo URL is refused even from a properly assigned crew member', async () => {
  const id = await seedBooking([assignee('crewA')])
  const res = await complete(id, await crewCookie('crewA'), { photos: [FOREIGN_PHOTO, PREVIEW_PHOTO] })
  assert.equal(res.status, 200)
  const after = await getBookingByToken(id)
  assert.deepEqual(after?.completionPhotos, [PREVIEW_PHOTO], 'only the Blob URL is persisted')
})

test('a URL from the OTHER environment’s Blob store is refused (Preview cannot write a Production URL)', async () => {
  const id = await seedBooking([assignee('crewA')])
  const res = await complete(id, await crewCookie('crewA'), { photos: [PROD_PHOTO] })
  assert.equal(res.status, 200)
  const after = await getBookingByToken(id)
  assert.equal(after?.completionPhotos, undefined, 'a cross-store URL never lands on the record')
})

// ── The admin path is preserved ──────────────────────────────────────────────
test('an admin can still record completion without being on the crew list', async () => {
  const id = await seedBooking([assignee('crewA')])
  const req = new NextRequest(`http://localhost/api/admin/bookings/${id}/assignment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${await adminCookie()}` },
    body: JSON.stringify({ action: 'record_completion', photos: [PREVIEW_PHOTO], note: 'owner recorded' }),
  })
  const res = await assignmentPOST(req, CTX(id))
  assert.equal(res.status, 200, 'the owner is authorized by permission, not by assignment')

  const after = await getBookingByToken(id)
  assert.equal(after?.jobCompletedBy, 'admin')
  assert.deepEqual(after?.completionPhotos, [PREVIEW_PHOTO])
})

// ── Flag off means absent ────────────────────────────────────────────────────
test('with BOOKING_ASSIGNMENT_ENABLED off the crew completion surface 404s', async () => {
  const id = await seedBooking([assignee('crewA')])
  process.env.BOOKING_ASSIGNMENT_ENABLED = 'false'
  try {
    assert.equal((await complete(id, await crewCookie('crewA'))).status, 404)
    const after = await getBookingByToken(id)
    assert.equal(after?.jobCompletedAt, undefined, 'nothing is written with the flag off')
  } finally {
    process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
  }
})
