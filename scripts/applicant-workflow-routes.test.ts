// Route-level guarantees for the applicant workflow.
//
// applicant-workflow.test.ts covers the pure predicates; this file drives the REAL
// route handlers so the guards that live in the routes — not in the predicates —
// are pinned too. Each test here was written against a specific mutation that the
// predicate-level suite could not detect:
//
//   • archive is a decide-level action (the predicate gates only reject/hire)
//   • recommendation:hire is refused at the route before it reaches the predicate
//   • a document without a valid signed receipt is dropped from the submission
//   • an applicant response must match the CURRENT information request
//   • DELETE is non-destructive
//   • a repeat applicant is flagged against their prior application
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://applicant-routes.test'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://applicant-routes.test'
type Entry = { value: string; expiresAt?: number }
const kv = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
function live(k: string): string | null {
  const e = kv.get(k)
  if (!e) return null
  if (e.expiresAt != null && e.expiresAt <= Date.now()) { kv.delete(k); return null }
  return e.value
}

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  await new Promise(r => setImmediate(r))
  const [raw, ...args] = JSON.parse(init.body as string) as string[]
  const command = String(raw).toUpperCase()
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(args[0]); break
    case 'MGET': result = args.map(live); break
    case 'DEL': result = kv.delete(args[0]) ? 1 : 0; break
    case 'INCR': { const n = Number(live(args[0]) ?? 0) + 1; kv.set(args[0], { value: String(n) }); result = n; break }
    case 'ZADD': z(args[0]).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(args[0]).delete(args[1]) ? 1 : 0; break
    case 'ZREVRANGE': {
      const members = [...z(args[0]).entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
      const stop = Number(args[2])
      result = members.slice(Number(args[1]), stop === -1 ? members.length : stop + 1)
      break
    }
    case 'SET': {
      const flags = args.slice(2).map(a => String(a).toUpperCase())
      const px = flags.indexOf('PX')
      const ttl = px >= 0 ? Number(args[2 + px + 1]) : undefined
      if (flags.includes('NX') && live(args[0]) !== null) { result = null; break }
      kv.set(args[0], { value: args[1], expiresAt: ttl != null ? Date.now() + ttl : undefined })
      result = 'OK'
      break
    }
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    case 'EVAL': {
      const script = String(args[0])
      const keyCount = Number(args[1])
      const keys = args.slice(2, 2 + keyCount)
      const argv = args.slice(2 + keyCount)
      if (script.includes('KEYS[4]') && /redis\.call\('(set|zadd)'/.test(script)) {   // COMMIT_APPLICATION
        // Honour the writes the script ACTUALLY contains rather than a hand-written
        // copy of them: a fake that always performs all four writes cannot tell you
        // when one is deleted from the Lua, which is exactly the regression this
        // transaction exists to prevent.
        if (live(keys[3]) !== argv[4]) { result = 0; break }
        if (script.includes("redis.call('set', KEYS[1], ARGV[1])")) kv.set(keys[0], { value: argv[0] })
        if (script.includes("redis.call('set', KEYS[2], ARGV[2])")) kv.set(keys[1], { value: argv[1] })
        if (script.includes("redis.call('zadd', KEYS[3], ARGV[3], ARGV[2])")) z(keys[2]).set(argv[1], Number(argv[2]))
        if (script.includes("redis.call('set', KEYS[4], ARGV[4]")) kv.set(keys[3], { value: argv[3], expiresAt: Date.now() + Number(argv[5]) })
        result = 1
        break
      }
      const key = keys[0], token = argv[0], owned = live(key) === token          // kv-lock scripts
      if (/pexpire/i.test(script)) {
        if (owned) { kv.set(key, { value: token, expiresAt: Date.now() + Number(argv[1]) }); result = 1 } else result = 0
      } else if (/set/i.test(script) && argv.length >= 2) {
        if (owned) { kv.set(key, { value: argv[1] }); result = 1 } else result = 0
      } else {
        if (owned) kv.delete(key)
        result = owned ? 1 : 0
      }
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { PATCH as careersPATCH, DELETE as careersDELETE } from '../app/api/admin/careers/route'
import { POST as applyPOST } from '../app/api/careers/apply/route'
import { POST as updatePOST } from '../app/api/careers/update/route'
import { POST as usersPOST } from '../app/api/admin/users/route'
import { getApplicant, listApplicants, saveApplicant, type Applicant } from '../app/lib/applicants'
import { createApplicantInformationToken } from '../app/lib/applicant-workflow'
import { getStaff } from '../app/lib/staff'
import { getUserByStaffId } from '../app/lib/users'

const CTX = { params: Promise.resolve({} as Record<string, string>) }
let adminCookie = '', managerCookie = ''
let clientIp = 1

const patch = (body: unknown, cookie: string) => careersPATCH(new NextRequest('http://localhost/api/admin/careers', {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` },
  body: JSON.stringify(body),
}), CTX)
const createCrewLogin = (staffId: string) => usersPOST(new NextRequest('http://localhost/api/admin/users', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${adminCookie}` },
  body: JSON.stringify({
    email: 'pat.crew@example.test', name: 'Pat Contractor', role: 'crew', staffId,
    password: 'StrongPass123!',
  }),
}), CTX)

// Public routes are rate limited per IP; each call gets its own so the limiter never
// masks the behaviour under test.
const publicPost = (handler: typeof applyPOST, path: string, body: unknown) => handler(new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${Math.floor(clientIp / 250)}.${(clientIp++ % 250) + 1}` },
  body: JSON.stringify(body),
}), CTX)

const draftId = () => `draft-${crypto.randomUUID()}`
function application(submissionKey: string, over: Record<string, unknown> = {}) {
  return {
    submissionKey, position: 'helper', name: 'Pat Applicant', email: 'pat@example.test', phone: '2145550101',
    age21plus: true, reliableTransport: true, canLiftHeavy: true, smartphone: true,
    availableStart: 'ASAP', availableDays: ['Mon'], experienceSummary: 'Warehouse work.',
    skills: {}, scenarios: [], ...over,
  }
}

async function reset() {
  kv.clear(); zsets.clear()
  adminCookie = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  managerCookie = await createUserSessionToken({ id: 'u_manager', role: 'manager' })
  // Approval will not issue an onboarding request without a published,
  // counsel-approved agreement, so every fixture starts with one on file.
  // scripts/contractor-lifecycle.test.ts covers the unpublished case directly.
  kv.set('contractoragreement:v:1', { value: JSON.stringify({
    version: 1, filename: 'agreement-v1.pdf', contentType: 'application/pdf', size: 12,
    sha256: 'x'.repeat(64), blobUrl: 'http://agreement-blob.test/v1.pdf.enc',
    blobPath: 'contractor-agreements/v1/a.pdf.enc', sealed: false,
    publishedBy: 'u_admin', publishedAt: 1,
  }) })
  kv.set('contractoragreement:counter', { value: '1' })
  kv.set('contractoragreement:current', { value: '1' })
}

async function submit(over: Record<string, unknown> = {}): Promise<Response> {
  return publicPost(applyPOST, '/api/careers/apply', application(draftId(), over))
}

async function seed(): Promise<Applicant> {
  const res = await submit()
  assert.equal(res.status, 200, 'seed application must be accepted')
  return (await listApplicants())[0]
}

test('archiving an applicant is a decide-level action a manager cannot take', async () => {
  await reset()
  const a = await seed()
  const denied = await patch({ id: a.id, action: 'status', value: 'archived' }, managerCookie)
  assert.equal(denied.status, 403, 'a manager must not archive')
  assert.equal((await getApplicant(a.id))?.status, 'new', 'the record is untouched')

  const allowed = await patch({ id: a.id, action: 'status', value: 'interview' }, managerCookie)
  assert.equal(allowed.status, 200, 'reviewers still move the non-terminal workflow')

  const archived = await patch({ id: a.id, action: 'status', value: 'archived' }, adminCookie)
  assert.equal(archived.status, 200)
  const stored = await getApplicant(a.id)
  assert.equal(stored?.status, 'archived')
  assert.ok(stored?.archivedAt, 'archiving stamps the audit timestamp')
})

test('recommendation can never be the path that hires an applicant', async () => {
  await reset()
  const a = await seed()
  const res = await patch({ id: a.id, action: 'recommendation', value: 'hire' }, adminCookie)
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Approve → Contractor\/Crew/)
  assert.equal((await getApplicant(a.id))?.status, 'new', 'no hire leaked through the recommendation path')
})

test('approval links a blocked crew record; verification activates it; ending and reopening stay coherent', async () => {
  await reset()
  const a = await seed()
  const approved = await patch({ id: a.id, action: 'hire' }, adminCookie)
  assert.equal(approved.status, 200)
  const hired = (await approved.json()).applicant as Applicant
  assert.ok(hired.promotedStaffId)

  const pending = await getStaff(hired.promotedStaffId!)
  assert.equal(pending?.active, false)
  assert.equal(pending?.onboarding, true)
  assert.equal(pending?.contractorStatus, 'pending_onboarding')
  assert.equal((await createCrewLogin(hired.promotedStaffId!)).status, 409, 'portal access waits for verification')

  // Verification refuses an incomplete file, so stand in a COMPLETE submission:
  // the pinned agreement plus the executed agreement, W-9, licence, and badge photo.
  const record = (await getApplicant(a.id))!
  record.contractorOnboarding = {
    ...(record.contractorOnboarding ?? { requestedAt: Date.now(), delivery: 'sent' }),
    agreementVersion: record.contractorOnboarding?.agreementVersion ?? 1,
    submittedAt: Date.now(),
    electronicSignature: {
      consentVersion: '2026-08-20-v1', consentedAt: Date.now(),
      contractor: {
        name: record.name, email: record.email, signedAt: Date.now(), sourceIp: '127.0.0.1', userAgent: 'test',
        agreementVersion: record.contractorOnboarding?.agreementVersion ?? 1,
        agreementSha256: 'a'.repeat(64), requestedAt: record.contractorOnboarding?.requestedAt ?? Date.now(),
      },
      company: {
        name: 'Test Admin', title: 'Authorized Representative', actorId: 'u_admin',
        signedAt: Date.now(), sourceIp: '127.0.0.1', userAgent: 'test',
      },
      certificateId: 'esign_fixture', executedSha256: 'b'.repeat(64),
    },
  }
  record.documents = (['w9', 'contractor_agreement', 'drivers_license', 'headshot'] as const)
    .map(kind => ({ kind, url: `contractor-docs/${kind}/${crypto.randomUUID()}.pdf.enc`, uploadedAt: Date.now() }))
  await saveApplicant(record)
  const verified = await patch({ id: a.id, action: 'verify_onboarding' }, adminCookie)
  assert.equal(verified.status, 200)
  const ready = await getStaff(hired.promotedStaffId!)
  assert.equal(ready?.active, true)
  assert.equal(ready?.onboarding, false)
  assert.equal(ready?.contractorStatus, 'ready')
  assert.equal(ready?.w9?.status, 'verified')
  assert.equal((await createCrewLogin(hired.promotedStaffId!)).status, 200)
  assert.equal((await getUserByStaffId(hired.promotedStaffId!))?.active, true)

  assert.equal((await patch({ id: a.id, action: 'end_contract' }, adminCookie)).status, 200)
  const ended = await getStaff(hired.promotedStaffId!)
  assert.equal(ended?.active, false)
  assert.equal(ended?.contractorStatus, 'ended')
  assert.equal((await getUserByStaffId(hired.promotedStaffId!))?.active, false, 'ending suspends portal access')

  assert.equal((await patch({ id: a.id, action: 'reopen_contract' }, adminCookie)).status, 200)
  const reopened = await getStaff(hired.promotedStaffId!)
  assert.equal(reopened?.active, true)
  assert.equal(reopened?.contractorStatus, 'ready')
  assert.equal((await getUserByStaffId(hired.promotedStaffId!))?.active, true, 'verified reopen restores portal access')
})

test('pre-approval document fields are never persisted, even when forged', async () => {
  await reset()
  const res = await submit({ documents: [{ kind: 'ss_card', url: 'https://evil.test/harvest.jpg' }] })
  assert.equal(res.status, 200)
  const stored = (await listApplicants())[0]
  assert.deepEqual(stored.documents, [], 'the public application cannot place a document into the record')
})

test('committing an application writes the applicant-number reverse index', async () => {
  await reset()
  const a = await seed()
  assert.equal(live(`app:num:${a.applicantNumber.toUpperCase()}`), a.id, 'the number resolves back to the record')
  assert.equal(z('app:index').size, 1)
})

test('a repeat applicant is flagged against their prior application', async () => {
  await reset()
  const first = await seed()
  assert.equal((await submit()).status, 200)
  // Both records can share a millisecond, so the index order is not a reliable
  // discriminator — pick the repeat application by id.
  const all = await listApplicants()
  assert.equal(all.length, 2)
  const repeat = all.find(x => x.id !== first.id)!
  assert.deepEqual(repeat.duplicateApplicantNumbers, [first.applicantNumber])
  assert.deepEqual(first.duplicateApplicantNumbers, [], 'the original has nothing prior to flag')
})

test('an applicant response only satisfies the CURRENT information request', async () => {
  await reset()
  const a = await seed()
  const requestedAt = Date.now()
  const record = (await getApplicant(a.id))!
  record.status = 'information_requested'
  record.informationRequest = { message: 'Send a clearer license photo.', requestedAt, delivery: 'sent' }
  await saveApplicant(record)

  const stale = createApplicantInformationToken({ applicantId: a.id, email: record.email, requestedAt: requestedAt - 5_000 })
  const staleRes = await publicPost(updatePOST as typeof applyPOST, '/api/careers/update', { token: stale, response: 'stale answer' })
  assert.equal(staleRes.status, 404, 'a superseded request link is dead')
  assert.equal((await getApplicant(a.id))?.informationResponse, undefined)

  const current = createApplicantInformationToken({ applicantId: a.id, email: record.email, requestedAt })
  const ok = await publicPost(updatePOST as typeof applyPOST, '/api/careers/update', { token: current, response: 'Here is a clearer photo.' })
  assert.equal(ok.status, 200)
  const answered = await getApplicant(a.id)
  assert.equal(answered?.informationResponse?.message, 'Here is a clearer photo.')
  assert.equal(answered?.status, 'reviewed')
  assert.equal((await listApplicants()).length, 1, 'the response updated the original application')
})

test('applications are retained: DELETE never destroys a record', async () => {
  await reset()
  const a = await seed()
  const res = await careersDELETE(new NextRequest(`http://localhost/api/admin/careers?id=${a.id}`, {
    method: 'DELETE', headers: { cookie: `jk_admin_session=${adminCookie}` },
  }), CTX)
  assert.equal(res.status, 409)
  assert.ok(await getApplicant(a.id), 'the record survives for audit')
  assert.equal((await listApplicants()).length, 1)
})
