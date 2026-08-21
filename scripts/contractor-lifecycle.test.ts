// End-to-end 1099 contractor lifecycle: application → approval → agreement →
// onboarding → verification → work → end/reopen.
//
// Every test here drives the REAL route handlers and the REAL readiness helpers
// against an in-memory store, because the guarantees being protected are decisions
// the routes make, not strings that appear in their source. Each block names the
// mutation it exists to catch.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'

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
      if (script.includes('ESIGN_ISSUE')) {
        kv.set(keys[0], { value: argv[0], expiresAt: Date.now() + Number(argv[1]) })
        result = 1
        break
      }
      if (script.includes('ESIGN_CONSUME')) {
        const rawRecord = live(keys[0])
        if (!rawRecord) { result = 0; break }
        let record: { requestedAt: number; codeHash: string; expiresAt: number; attempts: number }
        try { record = JSON.parse(rawRecord) } catch { kv.delete(keys[0]); result = 0; break }
        if (record.requestedAt !== Number(argv[0])) { result = 0; break }
        const now = Number(argv[1])
        if (record.expiresAt < now || record.attempts >= Number(argv[3])) {
          kv.delete(keys[0]); result = 0; break
        }
        if (record.codeHash === argv[2]) { kv.delete(keys[0]); result = 1; break }
        record.attempts += 1
        if (record.attempts >= Number(argv[3])) kv.delete(keys[0])
        else kv.set(keys[0], { value: JSON.stringify(record), expiresAt: record.expiresAt })
        result = 0
        break
      }
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

// The published agreement's blob is served by the same interceptor, so exercising the
// download path needs no Vercel Blob credentials.
const kvFetch = globalThis.fetch
globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (typeof url === 'string' && url.startsWith('http://agreement-blob.test/')) {
    const version = new URL(url).searchParams.get('v') ?? '1'
    return new Response(`AGREEMENT-V${version}`, { status: 200 })
  }
  return kvFetch(url as never, init as never)
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { PATCH as careersPATCH } from '../app/api/admin/careers/route'
import { POST as onboardPOST, GET as onboardGET } from '../app/api/careers/onboarding/route'
import { GET as agreementGET } from '../app/api/careers/onboarding/agreement/route'
import { POST as staffPOST } from '../app/api/admin/staff/route'
import { POST as usersPOST } from '../app/api/admin/users/route'
import { POST as agreementPOST } from '../app/api/admin/contractor-agreement/route'
import { PATCH as userPATCH } from '../app/api/admin/users/[id]/route'
import { POST as payPOST } from '../app/api/admin/pay-statements/route'
import { POST as routesPOST } from '../app/api/admin/routes/route'
import {
  getStaff, saveStaff, listStaff, staffCanAcceptAssignments, staffMayReceivePay, type Staff,
} from '../app/lib/staff'
import { getApplicant, saveApplicant, type Applicant } from '../app/lib/applicants'
import { createUser, getUserByStaffId, setUserActive } from '../app/lib/users'
import {
  createContractorOnboardingToken, createOnboardingDocumentReceipt,
} from '../app/lib/applicant-workflow'
import {
  applicantRetentionDecision, cleanupApplicantRetention, APPLICANT_RETENTION,
  applicantRetentionMustBeDryRun, runApplicantRetentionSweep,
} from '../app/lib/applicant-retention'
import { SENSITIVE_DOC_KINDS, isSensitiveDoc, CONTRACTOR_ONBOARDING_DOCS, REQUIRED_DOCS } from '../app/lib/ats-config'
import { materializeTemplate, type RouteTemplate } from '../app/lib/route-templates'
import { listRoutes, type RouteRecord } from '../app/lib/routes'
import { runDailyRouteAutomation } from '../app/lib/daily-route-automation'
import { assignCrewToBooking } from '../app/lib/booking-assignment'
import { saveBooking } from '../app/lib/bookings'
import { docCryptoReady } from '../app/lib/doc-crypto'
import { POST as uploadPOST } from '../app/api/careers/onboarding/upload/route'
import {
  buildExecutedAgreementPdf,
  createExecutedAgreement,
  consumeElectronicSignatureCode,
  ELECTRONIC_CONSENT_VERSION,
  issueElectronicSignatureCode,
} from '../app/lib/contractor-electronic-signature'
import { openDoc } from '../app/lib/doc-crypto'

const CTX = { params: Promise.resolve({} as Record<string, string>) }
const AGREEMENT_BLOB = 'http://agreement-blob.test/v1.pdf.enc'
let adminCookie = '', managerCookie = ''
let ip = 0
const nextIp = () => `10.${(ip++ >> 8) % 250}.0.${(ip % 250) + 1}`

const adminReq = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${adminCookie}` },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})
const publicReq = (url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
})
const patch = (body: unknown, cookie = adminCookie) => careersPATCH(new NextRequest('http://localhost/api/admin/careers', {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `jk_admin_session=${cookie}` },
  body: JSON.stringify(body),
}), CTX)
const json = async (r: Response) => await r.json() as Record<string, never>

// A published agreement, seeded directly so the suite never needs Blob credentials.
// `readContractorAgreementBytes` fetches blobUrl, which the harness serves.
async function publishAgreement(version: number, body = 'AGREEMENT-V' + version): Promise<void> {
  kv.set(`contractoragreement:v:${version}`, {
    value: JSON.stringify({
      version, filename: `agreement-v${version}.pdf`, contentType: 'application/pdf',
      size: body.length, sha256: 'x'.repeat(64),
      blobUrl: `${AGREEMENT_BLOB}?v=${version}`, blobPath: `tenants/t/contractor-agreements/v${version}/a.pdf.enc`,
      sealed: false, publishedBy: 'u_admin', publishedAt: 1,
    }),
  })
  kv.set('contractoragreement:counter', { value: String(version) })
  kv.set('contractoragreement:current', { value: String(version) })
}
const unpublishAgreement = () => { kv.delete('contractoragreement:current') }

async function reset() {
  kv.clear(); zsets.clear()
  adminCookie = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  managerCookie = await createUserSessionToken({ id: 'u_manager', role: 'manager' })
  await publishAgreement(1)
}

function applicantRecord(over: Partial<Applicant> = {}): Applicant {
  return {
    id: 'a'.repeat(32), applicantNumber: 'JK-A-1001', position: 'driver', name: 'Pat Contractor',
    email: 'pat@example.test', phone: '2145550101', skills: {}, scenarios: [], documents: [],
    score: { score: 0, band: 'not_qualified', components: [], strengths: [], weaknesses: [], riskFactors: [], suggestedQuestions: [], scenarioRubric: { safety: 0, customerService: 0, problemSolving: 0, honesty: 0, professionalism: 0 }, documentsComplete: true, missingDocs: [] },
    status: 'reviewed', createdAt: 1, updatedAt: 1, events: [], ...over,
  } as Applicant
}

async function approve(over: Partial<Applicant> = {}): Promise<{ applicant: Applicant; staff: Staff }> {
  const seed = applicantRecord(over)
  await saveApplicant(seed)
  const res = await patch({ id: seed.id, action: 'hire' })
  assert.equal(res.status, 200, `approval failed: ${JSON.stringify(await json(res))}`)
  const applicant = (await getApplicant(seed.id))!
  return { applicant, staff: (await getStaff(applicant.promotedStaffId!))! }
}

const ONBOARD_DOCS = ['w9', 'drivers_license', 'headshot'] as const
function onboardingDocuments(applicantId: string, requestedAt: number, over: Partial<Record<string, string>> = {}) {
  return ONBOARD_DOCS.map(kind => {
    const url = over[kind] ?? (kind === 'headshot'
      ? `https://blob.test/contractor-docs/headshot/${crypto.randomUUID()}.jpg`
      : `contractor-docs/${kind}/${crypto.randomUUID()}.pdf.enc`)
    return { kind, url, receipt: createOnboardingDocumentReceipt({ applicantId, kind: kind as never, path: url, requestedAt }) }
  })
}
const submission = (token: string, documents: unknown, signatureCode: string) => ({
  token, legalName: 'Pat Contractor LLC', taxClassification: 'individual', tinLast4: '6789',
  signatureName: 'Pat Contractor', electronicConsent: true, intentToSign: true, informationCertified: true,
  signatureCode, drivingAuthorized: true, usesPersonalVehicle: false,
  address: { line1: '1 Main St', city: 'Dallas', state: 'TX', postalCode: '75201' }, documents,
})
const tokenFor = (a: Applicant) => createContractorOnboardingToken({
  applicantId: a.id, email: a.email, requestedAt: a.contractorOnboarding!.requestedAt,
})

async function prepareSigning(a: Applicant): Promise<string> {
  const token = tokenFor(a)
  const download = await agreementGET(publicReq(`/api/careers/onboarding/agreement?token=${encodeURIComponent(token)}`), CTX)
  assert.equal(download.status, 200)
  const issued = await issueElectronicSignatureCode({ applicantId: a.id, requestedAt: a.contractorOnboarding!.requestedAt })
  return issued.code
}

async function seedCompanyCountersign(applicantId: string): Promise<void> {
  const signed = (await getApplicant(applicantId))!
  signed.contractorOnboarding!.electronicSignature!.company = {
    name: 'Test Admin', title: 'Authorized Representative', actorId: 'u_admin',
    signedAt: Date.now(), sourceIp: '127.0.0.1', userAgent: 'test',
  }
  signed.contractorOnboarding!.electronicSignature!.certificateId = 'esign_test'
  signed.contractorOnboarding!.electronicSignature!.executedSha256 = 'e'.repeat(64)
  signed.documents.push({ kind: 'contractor_agreement', url: 'contractor-docs/contractor_agreement/esign_test.pdf.enc', uploadedAt: Date.now() })
  await saveApplicant(signed)
}

async function submitOnboarding(a: Applicant, countersigned = true): Promise<Response> {
  const token = tokenFor(a)
  const docs = onboardingDocuments(a.id, a.contractorOnboarding!.requestedAt)
  const code = await prepareSigning(a)
  const response = await onboardPOST(publicReq('/api/careers/onboarding', submission(token, docs, code)), CTX)
  if (response.status === 200 && countersigned) await seedCompanyCountersign(a.id)
  return response
}

// ── 1. Approval creates a BLOCKED crew record; submission never activates ──────

test('approval blocks the crew record and contractor submission never activates it', async () => {
  await reset()
  const { staff } = await approve()
  assert.equal(staff.active, false)
  assert.equal(staff.contractorStatus, 'pending_onboarding')
  assert.equal(staff.payKind, 'contractor')
  assert.equal(staffCanAcceptAssignments(staff), false)
  assert.equal(staffMayReceivePay(staff), false)

  const a = (await getApplicant('a'.repeat(32)))!
  assert.equal((await submitOnboarding(a)).status, 200)
  const submitted = (await getStaff(staff.id))!
  assert.equal(submitted.active, false, 'submission is not activation')
  assert.equal(submitted.contractorStatus, 'pending_verification')
  assert.equal(submitted.w9?.status, 'on_file')
  assert.equal(submitted.w9?.tinLast4, '6789')
  assert.equal(staffCanAcceptAssignments(submitted), false)
})

// ── 2/3/4. Assignment, templates, dispatch ────────────────────────────────────

test('a pending contractor cannot be assigned to a route and is skipped by templates', async () => {
  await reset()
  const { staff } = await approve()
  const create = await routesPOST(adminReq('/api/admin/routes', 'POST', {
    businessName: 'Acme', reportAddress: '1 Dock St', reportTime: '07:00',
    routeDate: '2026-09-01', crew: [{ staffId: staff.id }],
  }), CTX)
  assert.equal(create.status, 409, 'route creation must refuse a pending contractor')
  assert.match(String((await json(create)).error), /onboarding is verified/)

  // A recurring template names them as standing crew; generation must still leave
  // them off every route it creates.
  const now = Date.now()
  const template: RouteTemplate = {
    id: 'tpl_1', label: 'Acme daily', businessName: 'Acme',
    reportAddress: '1 Dock St', reportTime: '07:00',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    crewByWeekday: { '0': [staff.id], '1': [staff.id], '2': [staff.id], '3': [staff.id], '4': [staff.id], '5': [staff.id], '6': [staff.id] },
    active: true, createdAt: now, updatedAt: now,
  }
  const { created } = await materializeTemplate(template, '2026-09-07', 3)
  assert.ok(created.length > 0, 'the template really did generate routes')
  const generated = await listRoutes(50)
  const touched = generated.filter(r => created.includes(r.routeNumber))
  assert.equal(touched.length, created.length)
  for (const route of touched) {
    assert.equal((route.assignees ?? []).some(x => x.staffId === staff.id), false,
      `${route.routeNumber} must not carry a pending contractor`)
  }
  const roster = await listStaff()
  assert.equal(roster.filter(staffCanAcceptAssignments).length, 0, 'no pending contractor is dispatchable')
})

// ── 5. Portal users ───────────────────────────────────────────────────────────

test('a pending contractor cannot be given or re-enabled a crew portal login', async () => {
  await reset()
  const { staff } = await approve()
  const created = await usersPOST(adminReq('/api/admin/users', 'POST', {
    name: 'Pat', email: 'pat@example.test', password: 'Str0ngPassphrase!42', role: 'crew', staffId: staff.id,
  }), CTX)
  assert.equal(created.status, 409)

  await createUser({ name: 'Pat', email: 'pat2@example.test', password: 'Str0ngPassphrase!42', role: 'crew', staffId: staff.id } as never)
  const user = (await getUserByStaffId(staff.id))!
  await setUserActive(user.id, false)
  const activated = await userPATCH(adminReq(`/api/admin/users/${user.id}`, 'PATCH', { active: true }), { params: Promise.resolve({ id: user.id }) })
  assert.equal(activated.status, 409, 'reactivating a pending contractor login must be refused')
  assert.equal((await getUserByStaffId(staff.id))!.active, false, 'the login stays suspended')
})

// ── 6/7. Reopen and direct staff editing ──────────────────────────────────────

test('reopening restores readiness only while verification is intact', async () => {
  await reset()
  const { staff } = await approve()
  const a = (await getApplicant('a'.repeat(32)))!
  await submitOnboarding(a)
  assert.equal((await patch({ id: a.id, action: 'verify_onboarding' })).status, 200)
  assert.equal((await getStaff(staff.id))!.contractorStatus, 'ready')

  assert.equal((await patch({ id: a.id, action: 'end_contract' })).status, 200)
  assert.equal((await patch({ id: a.id, action: 'reopen_contract' })).status, 200)
  assert.equal((await getStaff(staff.id))!.contractorStatus, 'ready', 'still verified → ready')

  await patch({ id: a.id, action: 'end_contract' })
  const revoked = (await getApplicant(a.id))!
  revoked.contractorOnboarding!.verifiedAt = undefined
  await saveApplicant(revoked)
  assert.equal((await patch({ id: a.id, action: 'reopen_contract' })).status, 200)
  const reopened = (await getStaff(staff.id))!
  assert.equal(reopened.contractorStatus, 'pending_verification', 'verification gone → back to pending')
  assert.equal(reopened.active, false)
})

test('direct staff editing cannot flip a contractor active', async () => {
  await reset()
  const { staff } = await approve()
  const res = await staffPOST(adminReq('/api/admin/staff', 'POST', { id: staff.id, name: staff.name, active: true }), CTX)
  assert.equal(res.status, 409)
  const after = (await getStaff(staff.id))!
  assert.equal(after.active, false)
  assert.equal(after.contractorStatus, 'pending_onboarding')
})

// ── 8/9. Receipts and document paths ──────────────────────────────────────────

test('onboarding rejects forged receipts and forged, stale, or cross-tenant paths', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const requestedAt = a.contractorOnboarding!.requestedAt
  const token = tokenFor(a)
  const good = onboardingDocuments(a.id, requestedAt)
  const code = await prepareSigning(a)

  const cases: Array<[string, unknown]> = [
    ['no receipt at all', good.map(d => ({ kind: d.kind, url: d.url }))],
    ['receipt for another applicant', good.map(d => ({ ...d, receipt: createOnboardingDocumentReceipt({ applicantId: 'b'.repeat(32), kind: d.kind as never, path: d.url, requestedAt }) }))],
    ['receipt from a superseded request', good.map(d => ({ ...d, receipt: createOnboardingDocumentReceipt({ applicantId: a.id, kind: d.kind as never, path: d.url, requestedAt: requestedAt - 1 }) }))],
    ['receipt bound to a different path', good.map(d => ({ ...d, receipt: createOnboardingDocumentReceipt({ applicantId: a.id, kind: d.kind as never, path: 'contractor-docs/w9/other.pdf.enc', requestedAt }) }))],
    ['cross-tenant document path', good.map(d => d.kind === 'headshot' ? d : { ...d, url: 'tenants/acme/contractor-docs/w9/x.pdf.enc' })],
    ['path traversal', good.map(d => d.kind === 'headshot' ? d : { ...d, url: '../../../etc/passwd.pdf.enc' })],
    ['arbitrary http path', good.map(d => d.kind === 'headshot' ? d : { ...d, url: 'https://evil.test/harvest.pdf' })],
  ]
  for (const [label, documents] of cases) {
    const res = await onboardPOST(publicReq('/api/careers/onboarding', submission(token, documents, code)), CTX)
    assert.equal(res.status, 400, `${label} must be refused`)
  }
  assert.equal((await getApplicant(a.id))!.contractorOnboarding?.submittedAt, undefined)
  assert.equal((await onboardPOST(publicReq('/api/careers/onboarding', submission(token, good, code)), CTX)).status, 200)
})

// ── 10/11. Encryption classification ──────────────────────────────────────────

test('every tax, agreement, and identity document stays in the sensitive (encrypted) set', () => {
  for (const kind of ['w9', 'contractor_agreement', 'insurance', 'drivers_license', 'id']) {
    assert.equal(isSensitiveDoc(kind), true, `${kind} must be encrypted at rest`)
    assert.ok((SENSITIVE_DOC_KINDS as readonly string[]).includes(kind))
  }
  assert.equal(isSensitiveDoc('headshot'), false, 'the badge photo is the only public onboarding upload')
  assert.deepEqual(REQUIRED_DOCS.driver, [], 'public applications collect nothing sensitive')
  assert.deepEqual(REQUIRED_DOCS.helper, [])
})

// ── 12/13. Retention ──────────────────────────────────────────────────────────

test('retention cleanup is dry-run by default and legal hold overrides every class', async () => {
  await reset()
  const counts = await cleanupApplicantRetention(Date.now())
  assert.equal(counts.records, 0)
  assert.equal(counts.documents, 0)

  const held = applicantRecord({
    status: 'rejected', rejectedAt: 1, legalHold: { active: true, placedAt: 1, placedBy: 'u_admin', reason: 'litigation' },
  })
  const decision = applicantRetentionDecision(held, Date.now() + 40 * 365 * 86_400_000)
  assert.deepEqual(decision, { held: true, purgeRejectedDocuments: false, purgeW9: false, purgeRecord: false })
})

test('a rejected applicant’s retention clock is stamped once and unrelated edits never move it', async () => {
  await reset()
  const seed = applicantRecord({ status: 'reviewed' })
  await saveApplicant(seed)
  assert.equal((await patch({ id: seed.id, action: 'status', value: 'rejected' })).status, 200)
  const stamped = (await getApplicant(seed.id))!.rejectedAt
  assert.ok(stamped && stamped > 0, 'rejection stamps an authoritative timestamp')

  // Unrelated edits: a note, a legal hold, a rescore. None may move the clock.
  await new Promise(r => setTimeout(r, 5))
  await patch({ id: seed.id, action: 'notes', value: 'Reviewed again later.' })
  await patch({ id: seed.id, action: 'legal_hold', value: { active: true, reason: 'audit' } })
  await patch({ id: seed.id, action: 'legal_hold', value: { active: false } })
  await patch({ id: seed.id, action: 'rescore' })
  const after = (await getApplicant(seed.id))!
  assert.equal(after.rejectedAt, stamped, 'the rejection clock is immutable')
  assert.ok(after.updatedAt > stamped, 'control: the record really was written again')
  // The document window is measured from the frozen stamp, not from the later edits.
  assert.equal(applicantRetentionDecision(after, stamped + APPLICANT_RETENTION.rejectedSensitiveDocumentMs - 1).purgeRejectedDocuments, false)
  assert.equal(applicantRetentionDecision(after, stamped + APPLICANT_RETENTION.rejectedSensitiveDocumentMs).purgeRejectedDocuments, true,
    'the deadline arrives on schedule despite the later edits')
})

test('reopening review preserves rejection history but a later rejection starts a new retention episode', async () => {
  await reset()
  const seed = applicantRecord({ status: 'reviewed' })
  await saveApplicant(seed)
  assert.equal((await patch({ id: seed.id, action: 'status', value: 'rejected' })).status, 200)
  const first = (await getApplicant(seed.id))!.rejectedAt!

  assert.equal((await patch({ id: seed.id, action: 'status', value: 'reviewed' })).status, 200)
  const reopened = (await getApplicant(seed.id))!
  assert.equal(reopened.rejectedAt, undefined, 'no active rejection clock remains while review is open')
  assert.equal(reopened.events?.filter(event => /denied|rejected/i.test(event.action)).length, 1,
    'the first rejection remains in append-only history')

  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await patch({ id: seed.id, action: 'status', value: 'rejected' })).status, 200)
  const rejectedAgain = (await getApplicant(seed.id))!
  assert.ok(rejectedAgain.rejectedAt! > first, 'the new rejection gets a fresh retention clock')
  assert.equal(rejectedAgain.events?.filter(event => /denied|rejected/i.test(event.action)).length, 2,
    'both rejection decisions remain auditable')
  assert.equal(
    applicantRetentionDecision(rejectedAgain, rejectedAgain.rejectedAt! + APPLICANT_RETENTION.rejectedSensitiveDocumentMs - 1).purgeRejectedDocuments,
    false,
    'the old rejection cannot make the new episode purge early',
  )
})

test('a legacy rejected record is backfilled once from its rejection event, not from updatedAt', async () => {
  await reset()
  const rejectedAt = Date.now() - 100 * 86_400_000
  const legacy = applicantRecord({
    id: 'c'.repeat(32), applicantNumber: 'JK-A-1099', status: 'rejected', updatedAt: Date.now(),
    events: [{ at: rejectedAt, actor: 'admin', action: 'Status → Denied' }],
  })
  await saveApplicant(legacy)
  await cleanupApplicantRetention(Date.now())
  const backfilled = (await getApplicant(legacy.id))!
  assert.equal(backfilled.rejectedAt, rejectedAt, 'derived from the append-only event, not the mutable updatedAt')
  assert.equal(JSON.parse(live(`app:${legacy.id}`)!).rejectedAt, rejectedAt,
    'the legacy clock is actually persisted, not merely synthesized during reads')
})

test('daily route automation never contacts or penalizes contractors who are not ready', async () => {
  const runFor = async (contractorStatus: Staff['contractorStatus'], active: boolean) => {
    const route = {
      token: `route-${contractorStatus}`, routeNumber: 'JK-R-1900', status: 'assigned',
      businessName: 'Test Business', reportAddress: '123 Test St', reportTime: '8:00 AM',
      routeDate: '2020-01-01', createdAt: 1, updatedAt: 1,
      assignees: [{ staffId: 'staff-1', name: 'Pat Contractor', phone: '2145550101', token: 'a'.repeat(64) }],
    } as RouteRecord
    const person = {
      id: 'staff-1', name: 'Pat Contractor', active, contractorStatus,
      createdAt: 1, updatedAt: 1,
    } as Staff
    let alerts = 0
    let saves = 0
    const counts = await runDailyRouteAutomation(Date.UTC(2026, 7, 21, 15), {
      getAutomationSettings: async () => ({ confirmationReminders: true, morningReminders: true }),
      listRoutes: async () => [route],
      listStaff: async () => [person],
      withRouteLock: async (_token, run) => run(),
      getRouteByToken: async () => route,
      alertOwnerRouteEvent: async () => { alerts++ },
      sendSms: async () => true,
      saveRoute: async () => { saves++ },
    })
    return { counts, alerts, saves, route }
  }

  for (const status of ['pending_onboarding', 'pending_verification', 'ended'] as const) {
    const blocked = await runFor(status, false)
    assert.equal(blocked.alerts, 0, `${status} must not generate a no-response alert`)
    assert.equal(blocked.saves, 0, `${status} must not receive automation stamps`)
    assert.equal(blocked.route.assignees?.[0].noResponseAlertedAt, undefined)
  }

  const ready = await runFor('ready', true)
  assert.equal(ready.alerts, 1, 'control: a ready contractor follows normal automation')
  assert.equal(ready.saves, 1)
  assert.equal(ready.counts.routeNoResponse, 1)
})

test('daily retention remains report-only unless deletion is explicitly enabled and the request is not dry-run', async () => {
  assert.equal(applicantRetentionMustBeDryRun(false, undefined), true)
  assert.equal(applicantRetentionMustBeDryRun(false, 'false'), true)
  assert.equal(applicantRetentionMustBeDryRun(false, 'TRUE'), true)
  assert.equal(applicantRetentionMustBeDryRun(false, 'true'), false)
  assert.equal(applicantRetentionMustBeDryRun(true, 'true'), true)

  const observed: boolean[] = []
  const cleanup = async (_now: number, dryRun: boolean) => {
    observed.push(dryRun)
    return { scanned: 0 }
  }
  assert.equal((await runApplicantRetentionSweep(1, false, undefined, cleanup)).dryRun, true)
  assert.equal((await runApplicantRetentionSweep(2, false, 'true', cleanup)).dryRun, false)
  assert.equal((await runApplicantRetentionSweep(3, true, 'true', cleanup)).dryRun, true)
  assert.deepEqual(observed, [true, false, true], 'the cron-facing wrapper passes the enforced mode to cleanup')
})

// ── 14/15/16. Agreement pinning, download authorization, verification ─────────

test('replacing the published agreement never changes an already-issued request', async () => {
  await reset()
  const { applicant } = await approve()
  assert.equal(applicant.contractorOnboarding?.agreementVersion, 1)

  await publishAgreement(2)                                    // counsel publishes a revision
  const unchanged = (await getApplicant(applicant.id))!
  assert.equal(unchanged.contractorOnboarding?.agreementVersion, 1, 'the outstanding request keeps v1')

  const download = await agreementGET(publicReq(`/api/careers/onboarding/agreement?token=${encodeURIComponent(tokenFor(unchanged))}`), CTX)
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'AGREEMENT-V1', 'they receive the version they were asked to sign')

  // A NEW request (resend) re-pins to whatever is current now. This harness has no
  // mail transport, so the resend reports 502 — and must STILL have superseded the
  // old request rather than silently leaving the contractor on v1.
  const resend = await patch({ id: applicant.id, action: 'resend_onboarding' })
  assert.equal(resend.status, 502, 'a failed send is reported, never swallowed')
  const repinned = (await getApplicant(applicant.id))!
  assert.equal(repinned.contractorOnboarding?.agreementVersion, 2)
  assert.equal(repinned.contractorOnboarding?.delivery, 'failed')
  assert.ok(repinned.contractorOnboarding?.deliveryAttemptedAt, 'the failed attempt is timestamped')
  assert.notEqual(repinned.contractorOnboarding?.requestedAt, unchanged.contractorOnboarding?.requestedAt,
    'the previous token is superseded')
})

test('the agreement download authorizes exactly one applicant, request, and relationship', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const requestedAt = a.contractorOnboarding!.requestedAt

  const ok = await agreementGET(publicReq(`/api/careers/onboarding/agreement?token=${encodeURIComponent(tokenFor(a))}`), CTX)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('Cache-Control'), 'private, no-store')

  const rejected: Array<[string, string]> = [
    ['another applicant', createContractorOnboardingToken({ applicantId: 'b'.repeat(32), email: a.email, requestedAt })],
    ['another identity', createContractorOnboardingToken({ applicantId: a.id, email: 'someone@else.test', requestedAt })],
    ['a superseded request', createContractorOnboardingToken({ applicantId: a.id, email: a.email, requestedAt: requestedAt - 1 })],
    ['an expired token', createContractorOnboardingToken({ applicantId: a.id, email: a.email, requestedAt, now: Date.now() - 8 * 24 * 60 * 60_000 })],
    ['a tampered signature', `${tokenFor(a)}x`],
    ['no token', ''],
  ]
  for (const [label, token] of rejected) {
    const res = await agreementGET(publicReq(`/api/careers/onboarding/agreement?token=${encodeURIComponent(token)}`), CTX)
    assert.equal(res.status, 404, `${label} must not download the agreement`)
  }

  // Ending the relationship kills the download too.
  await submitOnboarding(a)
  await patch({ id: a.id, action: 'verify_onboarding' })
  assert.equal((await patch({ id: a.id, action: 'end_contract' })).status, 200)
  const ended = await agreementGET(publicReq(`/api/careers/onboarding/agreement?token=${encodeURIComponent(tokenFor(a))}`), CTX)
  assert.equal(ended.status, 404, 'an ended contractor cannot download the agreement')
})

test('onboarding cannot be requested at all while no agreement is published', async () => {
  await reset()
  unpublishAgreement()
  const seed = applicantRecord({ id: 'd'.repeat(32), applicantNumber: 'JK-A-1100' })
  await saveApplicant(seed)
  const res = await patch({ id: seed.id, action: 'hire' })
  assert.equal(res.status, 409)
  const body = await json(res)
  assert.equal(body.reason, 'agreement_not_published')

  // The crew record still exists and is BLOCKED — approval is never half-active.
  const after = (await getApplicant(seed.id))!
  assert.ok(after.promotedStaffId)
  const staff = (await getStaff(after.promotedStaffId!))!
  assert.equal(staff.active, false)
  assert.equal(staff.contractorStatus, 'pending_onboarding')
  assert.equal(after.contractorOnboarding, undefined, 'no request was issued')
})

test('verification refuses an unpinned agreement or a missing executed agreement', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  await submitOnboarding(a)

  const missingExecuted = (await getApplicant(a.id))!
  missingExecuted.documents = missingExecuted.documents.filter(d => d.kind !== 'contractor_agreement')
  await saveApplicant(missingExecuted)
  const noAgreement = await patch({ id: a.id, action: 'verify_onboarding' })
  assert.equal(noAgreement.status, 409)
  assert.match(String((await json(noAgreement)).error), /contractor_agreement/)
  assert.equal((await getStaff(applicant.promotedStaffId!))!.contractorStatus, 'pending_verification')

  const unpinned = (await getApplicant(a.id))!
  unpinned.documents = (await getApplicant(a.id))!.documents
  unpinned.contractorOnboarding!.agreementVersion = undefined
  await saveApplicant(unpinned)
  const notPinned = await patch({ id: a.id, action: 'verify_onboarding' })
  assert.equal(notPinned.status, 409)
  assert.equal((await json(notPinned)).reason, 'agreement_not_pinned')
})

// ── 17/18. Existing active legacy crew ────────────────────────────────────────

test('approval never silently deactivates an active legacy crew member', async () => {
  await reset()
  const now = Date.now()
  await saveStaff({
    id: 'legacy-1', name: 'Dana Legacy', phone: '2145550101', role: 'Driver',
    active: true, createdAt: now, updatedAt: now,
  } as Staff)
  const seed = applicantRecord({ id: 'e'.repeat(32), applicantNumber: 'JK-A-1200', phone: '2145550101' })
  await saveApplicant(seed)

  const res = await patch({ id: seed.id, action: 'hire' })
  assert.equal(res.status, 409)
  const body = await json(res)
  assert.equal(body.reason, 'crew_link_confirmation_required')

  const untouched = (await getStaff('legacy-1'))!
  assert.equal(untouched.active, true, 'the live roster is untouched')
  assert.equal(untouched.contractorStatus, undefined)
  assert.equal(staffCanAcceptAssignments(untouched), true, 'they keep working')
  const applicant = (await getApplicant(seed.id))!
  assert.equal(applicant.status, 'reviewed', 'the application is unchanged until an admin decides')
  assert.equal(applicant.promotedStaffId, undefined)
  assert.equal(applicant.pendingCrewLink?.staffId, 'legacy-1')
})

test('an already verified active crew member links without interruption', async () => {
  await reset()
  const now = Date.now()
  await saveStaff({
    id: 'verified-1', name: 'Sam Verified', phone: '2145550111', role: 'Driver',
    active: true, w9: { status: 'verified' }, createdAt: now, updatedAt: now,
  } as Staff)
  const seed = applicantRecord({ id: 'f'.repeat(32), applicantNumber: 'JK-A-1300', phone: '2145550111' })
  await saveApplicant(seed)
  assert.equal((await patch({ id: seed.id, action: 'hire' })).status, 200)
  const linked = (await getStaff('verified-1'))!
  assert.equal(linked.active, true)
  assert.equal(linked.contractorStatus, 'ready')
  assert.equal(staffCanAcceptAssignments(linked), true)
})

test('concurrent link confirmations link exactly one crew record', async () => {
  await reset()
  const now = Date.now()
  await saveStaff({
    id: 'legacy-2', name: 'Rae Legacy', phone: '2145550122', role: 'Helper',
    active: true, createdAt: now, updatedAt: now,
  } as Staff)
  await createUser({ name: 'Rae', email: 'rae@example.test', password: 'Str0ngPassphrase!42', role: 'crew', staffId: 'legacy-2', active: true } as never)
  const seed = applicantRecord({ id: 'ab'.repeat(16), applicantNumber: 'JK-A-1400', phone: '2145550122', position: 'helper' })
  await saveApplicant(seed)
  assert.equal((await patch({ id: seed.id, action: 'hire' })).status, 409)

  const results = await Promise.all([
    patch({ id: seed.id, action: 'confirm_crew_link' }),
    patch({ id: seed.id, action: 'confirm_crew_link' }),
    patch({ id: seed.id, action: 'confirm_crew_link' }),
  ])
  assert.equal(results.filter(r => r.status === 200).length >= 1, true)
  const roster = await listStaff()
  assert.equal(roster.filter(s => s.applicantId === seed.id).length, 1, 'exactly one crew record is linked')
  const paused = (await getStaff('legacy-2'))!
  assert.equal(paused.active, false, 'confirmed: they are paused for onboarding')
  assert.equal(paused.contractorStatus, 'pending_onboarding')
  assert.equal((await getUserByStaffId('legacy-2'))!.active, false, 'their portal login is suspended too')
  const applicant = (await getApplicant(seed.id))!
  assert.equal(applicant.status, 'hired')
  assert.equal(applicant.pendingCrewLink, undefined)
})

test('a manager can neither confirm a crew link, countersign, nor verify onboarding', async () => {
  await reset()
  const { applicant } = await approve()
  for (const action of ['confirm_crew_link', 'countersign_onboarding', 'verify_onboarding', 'resend_onboarding', 'end_contract', 'reopen_contract']) {
    assert.equal((await patch({ id: applicant.id, action }, managerCookie)).status, 403, `${action} is admin-only`)
  }
})

// ── Pay ───────────────────────────────────────────────────────────────────────

test('ordinary pay is blocked until verification and permitted again after the relationship ends', async () => {
  await reset()
  const { applicant, staff } = await approve()
  const a = (await getApplicant(applicant.id))!
  await submitOnboarding(a)
  const blocked = await payPOST(adminReq('/api/admin/pay-statements', 'POST', {
    staffId: staff.id, periodStart: '2026-08-03', periodEnd: '2026-08-09',
  }), CTX)
  assert.equal(blocked.status, 409)

  const ended = (await getStaff(staff.id))!
  ended.contractorStatus = 'ended'
  ended.active = false
  await saveStaff(ended)
  const finalPay = await payPOST(adminReq('/api/admin/pay-statements', 'POST', {
    staffId: staff.id, periodStart: '2026-08-03', periodEnd: '2026-08-09',
  }), CTX)
  assert.notEqual(finalPay.status, 409, 'an ended contractor may still receive final/historical pay')
})

// ── Onboarding surface ────────────────────────────────────────────────────────

test('the onboarding page loads only for a live request and offers the agreement first', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const view = await onboardGET(publicReq(`/api/careers/onboarding?token=${encodeURIComponent(tokenFor(a))}`), CTX)
  assert.equal(view.status, 200)
  const payload = await json(view) as unknown as { contractor: { requiredDocuments: { kind: string }[]; agreementVersion: number; consentVersion: string } }
  const kinds = payload.contractor.requiredDocuments.map(d => d.kind)
  assert.ok(kinds.includes('w9'))
  assert.equal(kinds.includes('contractor_agreement'), false, 'Operion generates the executed agreement; the contractor never uploads one')
  assert.equal(payload.contractor.agreementVersion, 1)
  assert.equal(payload.contractor.consentVersion, ELECTRONIC_CONSENT_VERSION)
  assert.equal(kinds.includes('ss_card'), false, 'a Social Security card is never requested')
  assert.deepEqual(
    CONTRACTOR_ONBOARDING_DOCS.driver.map(d => d.kind).filter(k => k === 'ss_card'), [],
  )
})

test('contractor signing records consent, identity evidence, and blocks activation until countersigned', async () => {
  await reset()
  const { applicant, staff } = await approve()
  const a = (await getApplicant(applicant.id))!
  assert.equal((await submitOnboarding(a, false)).status, 200)
  const signed = (await getApplicant(a.id))!
  const evidence = signed.contractorOnboarding?.electronicSignature
  assert.equal(evidence?.consentVersion, ELECTRONIC_CONSENT_VERSION)
  assert.equal(evidence?.contractor.email, 'pat@example.test')
  assert.equal(evidence?.contractor.agreementVersion, 1)
  assert.match(evidence?.contractor.sourceIp ?? '', /^10\./)
  assert.equal(signed.documents.some(d => d.kind === 'contractor_agreement'), false,
    'the contractor cannot forge or upload the final executed agreement')
  assert.equal((await patch({ id: a.id, action: 'resend_onboarding' })).status, 409,
    'a resend cannot supersede an agreement after the contractor has signed it')

  const premature = await patch({ id: a.id, action: 'verify_onboarding' })
  assert.equal(premature.status, 409)
  assert.equal((await json(premature)).reason, 'company_signature_missing')
  assert.equal((await getStaff(staff.id))!.active, false)

  const noIntent = await patch({ id: a.id, action: 'countersign_onboarding' })
  assert.equal(noIntent.status, 400)
})

test('the signing route requires viewing, consent, intent, certification, and the emailed code', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const token = tokenFor(a)
  const docs = onboardingDocuments(a.id, a.contractorOnboarding!.requestedAt)
  const unviewedCode = await issueElectronicSignatureCode({ applicantId: a.id, requestedAt: a.contractorOnboarding!.requestedAt })
  const unviewed = await onboardPOST(publicReq('/api/careers/onboarding', submission(token, docs, unviewedCode.code)), CTX)
  assert.equal(unviewed.status, 409, 'the exact agreement must be downloaded before signature')

  const code = await prepareSigning(a)
  const valid = submission(token, docs, code)
  const wrongCode = code === '000000' ? '999999' : '000000'
  for (const [label, body] of [
    ['electronic consent', { ...valid, electronicConsent: false }],
    ['intent to sign', { ...valid, intentToSign: false }],
    ['information certification', { ...valid, informationCertified: false }],
    ['emailed code format', { ...valid, signatureCode: '99999' }],
    ['emailed code value', { ...valid, signatureCode: wrongCode }],
  ] as const) {
    const response = await onboardPOST(publicReq('/api/careers/onboarding', body), CTX)
    assert.equal(response.status, 400, `${label} cannot be omitted`)
  }
  assert.equal((await getApplicant(a.id))!.contractorOnboarding?.electronicSignature, undefined)
  assert.equal((await onboardPOST(publicReq('/api/careers/onboarding', valid), CTX)).status, 200,
    'validation failures do not consume the otherwise-valid code')
})

test('one-time signing codes expire by use and lock after five wrong attempts', async () => {
  await reset()
  const { applicant } = await approve()
  const requestedAt = applicant.contractorOnboarding!.requestedAt
  const first = await issueElectronicSignatureCode({ applicantId: applicant.id, requestedAt })
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: first.code }), true)
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: first.code }), false,
    'a code is one-use even when replayed immediately')

  const second = await issueElectronicSignatureCode({ applicantId: applicant.id, requestedAt })
  const wrong = second.code === '000000' ? '999999' : '000000'
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: wrong }), false)
  }
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: second.code }), false,
    'the correct code cannot be used after the attempt limit')
})

test('signing codes are request-bound, expire server-side, and enforce attempts under concurrency', async () => {
  await reset()
  const { applicant } = await approve()
  const requestedAt = applicant.contractorOnboarding!.requestedAt

  const current = await issueElectronicSignatureCode({ applicantId: applicant.id, requestedAt })
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt: requestedAt - 1, code: current.code }), false)
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: current.code }), true,
    'a stale browser request must not revoke the current code')

  const expired = await issueElectronicSignatureCode({ applicantId: applicant.id, requestedAt })
  const key = `app:esign:otp:${applicant.id}`
  const expiredRecord = JSON.parse(kv.get(key)!.value) as { expiresAt: number }
  expiredRecord.expiresAt = Date.now() - 1
  kv.set(key, { value: JSON.stringify(expiredRecord) })
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: expired.code }), false)

  const raced = await issueElectronicSignatureCode({ applicantId: applicant.id, requestedAt })
  const wrong = raced.code === '000000' ? '999999' : '000000'
  await Promise.all(Array.from({ length: 20 }, () => consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: wrong })))
  assert.equal(await consumeElectronicSignatureCode({ applicantId: applicant.id, requestedAt, code: raced.code }), false,
    'parallel guesses cannot exceed the five-attempt limit')
})

test('contractor signing ignores forged identity, agreement, and executed-document fields', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const token = tokenFor(a)
  const code = await prepareSigning(a)
  const documents = [
    ...onboardingDocuments(a.id, a.contractorOnboarding!.requestedAt),
    { kind: 'contractor_agreement', url: 'https://evil.test/forged.pdf', receipt: 'forged' },
  ]
  const response = await onboardPOST(publicReq('/api/careers/onboarding', {
    ...submission(token, documents, code),
    email: 'attacker@evil.test', agreementVersion: 99, agreementSha256: 'f'.repeat(64),
    signedAt: 1, sourceIp: '1.2.3.4', executedAgreementUrl: 'https://evil.test/executed.pdf',
  }), CTX)
  assert.equal(response.status, 200)
  const stored = (await getApplicant(a.id))!
  const signature = stored.contractorOnboarding!.electronicSignature!.contractor
  assert.equal(signature.email, 'pat@example.test')
  assert.equal(signature.agreementVersion, 1)
  assert.notEqual(signature.agreementSha256, 'f'.repeat(64))
  assert.notEqual(signature.signedAt, 1)
  assert.notEqual(signature.sourceIp, '1.2.3.4')
  assert.equal(stored.documents.some(doc => doc.kind === 'contractor_agreement'), false)
})

test('an ended relationship cannot be countersigned', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  assert.equal((await submitOnboarding(a, false)).status, 200)
  const ended = (await getApplicant(a.id))!
  ended.contractEndedAt = Date.now()
  await saveApplicant(ended)
  const response = await patch({ id: a.id, action: 'countersign_onboarding', value: {
    signatureName: 'J Kiss Owner', title: 'Owner', intent: true,
  } })
  assert.equal(response.status, 409)
  assert.equal((await getApplicant(a.id))!.contractorOnboarding!.electronicSignature!.company, undefined)
})

test('execution certificate preserves the original PDF and refuses a hash mismatch', async () => {
  const source = await PDFDocument.create()
  source.addPage([612, 792])
  const templateBytes = Buffer.from(await source.save())
  const templateSha256 = createHash('sha256').update(templateBytes).digest('hex')
  const common = {
    templateBytes, templateSha256, agreementVersion: 3, applicantNumber: 'JK-A-1900', certificateId: 'esign_test_certificate',
    contractor: {
      name: 'José Ñuñez-Wąs', email: 'pat@example.test', signedAt: 1_785_000_000_000,
      sourceIp: '203.0.113.10', userAgent: 'test', agreementVersion: 3,
      agreementSha256: templateSha256, requestedAt: 1_784_999_000_000,
    },
    company: {
      name: 'J Kiss Owner', title: 'Authorized Representative', actorId: 'u_admin',
      signedAt: 1_785_000_100_000, sourceIp: '203.0.113.20', userAgent: 'test',
    },
  }
  const executed = await buildExecutedAgreementPdf(common)
  assert.equal(executed.subarray(0, 5).toString(), '%PDF-')
  assert.equal((await PDFDocument.load(executed)).getPageCount(), 2, 'the certificate is appended; the original page remains')
  const extracted = spawnSync('pdftotext', ['-', '-'], { input: executed, encoding: 'utf8' })
  assert.equal(extracted.status, 0, extracted.stderr)
  assert.match(extracted.stdout, /Signed by: José Ñuñez-Wąs/,
    'the sealed legal record preserves the signer’s exact Unicode name')
  await assert.rejects(() => buildExecutedAgreementPdf({ ...common, templateSha256: '0'.repeat(64) }), /HASH_MISMATCH/)
})

test('executed-agreement storage seams receive ciphertext and reject version/hash mismatches', async () => {
  await reset()
  const source = await PDFDocument.create()
  source.addPage([612, 792])
  const templateBytes = Buffer.from(await source.save())
  const templateSha256 = createHash('sha256').update(templateBytes).digest('hex')
  kv.set('contractoragreement:v:1', { value: JSON.stringify({
    version: 1, filename: 'agreement.pdf', contentType: 'application/pdf', size: templateBytes.length,
    sha256: templateSha256, blobUrl: 'http://agreement-blob.test/custom.pdf', blobPath: 'custom.pdf.enc',
    sealed: false, publishedBy: 'u_admin', publishedAt: 1,
  }) })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === 'http://agreement-blob.test/custom.pdf') return new Response(templateBytes)
    return originalFetch(url as never, init as never)
  }) as typeof fetch
  try {
    const applicant = applicantRecord({ contractorOnboarding: {
      requestedAt: 1, agreementVersion: 1, electronicSignature: {
        consentVersion: ELECTRONIC_CONSENT_VERSION,
        contractor: {
          name: 'José Ñuñez-Wąs', email: 'pat@example.test', signedAt: Date.now(), sourceIp: '127.0.0.1',
          userAgent: 'test', agreementVersion: 1, agreementSha256: templateSha256, requestedAt: 1,
        },
      },
    } as never })
    let stored: Buffer | undefined
    const executed = await createExecutedAgreement({ applicant, company: {
      name: 'J Kiss Owner', title: 'Owner', actorId: 'u_admin', signedAt: Date.now(), sourceIp: '127.0.0.1', userAgent: 'test',
    }, store: async (_path, bytes) => { stored = Buffer.from(bytes) } })
    assert.ok(stored)
    assert.notEqual(stored.subarray(0, 5).toString(), '%PDF-')
    const plaintext = openDoc(stored)
    assert.equal(plaintext.subarray(0, 5).toString(), '%PDF-')
    assert.equal(createHash('sha256').update(plaintext).digest('hex'), executed.executedSha256)

    applicant.contractorOnboarding!.electronicSignature!.contractor.agreementSha256 = 'f'.repeat(64)
    await assert.rejects(() => createExecutedAgreement({ applicant, company: {
      name: 'J Kiss Owner', title: 'Owner', actorId: 'u_admin', signedAt: Date.now(), sourceIp: '127.0.0.1', userAgent: 'test',
    }, store: async () => {} }), /AGREEMENT_VERSION_MISMATCH/)
  } finally { globalThis.fetch = originalFetch }
})

test('agreement publication rejects structurally invalid PDFs before storage', async () => {
  await reset()
  const response = await agreementPOST(adminReq('/api/admin/contractor-agreement', 'POST', {
    filename: 'broken.pdf', file: `data:application/pdf;base64,${Buffer.from('%PDF-not-a-real-document').toString('base64')}`,
  }), CTX)
  assert.equal(response.status, 400)
  assert.match(String((await json(response)).error), /damaged|cannot be read/i)
  assert.equal(live('contractoragreement:counter'), '1', 'invalid publication never advances the version')
})

test('crew agreement publication derives its owner from the applicant link', () => {
  const source = readFileSync(new URL('../app/lib/contractor-onboarding-documents.ts', import.meta.url), 'utf8')
  assert.match(source, /const staffId = input\.applicant\.promotedStaffId/)
  assert.doesNotMatch(source, /input:\s*\{[\s\S]{0,240}?staffId:\s*string/,
    'a caller cannot redirect an executed agreement to a different crew owner')
})

test('signing and countersigning UI has accessible, non-blocking states', () => {
  const contractor = readFileSync(new URL('../app/careers/onboarding/page.tsx', import.meta.url), 'utf8')
  const admin = readFileSync(new URL('../app/admin/careers/page.tsx', import.meta.url), 'utf8')
  for (const [label, source] of [['contractor', contractor], ['admin', admin]] as const) {
    assert.match(source, /role="alert"/, `${label} signing errors are announced`)
    assert.match(source, /disabled=\{busy/, `${label} signing action prevents double submission`)
  }
  assert.match(contractor, /htmlFor=/)
  assert.doesNotMatch(contractor, /window\.confirm|\bconfirm\(/)
  const countersignSection = admin.slice(admin.indexOf('countersign_onboarding'), admin.indexOf('verify_onboarding'))
  assert.doesNotMatch(countersignSection, /window\.confirm|\bconfirm\(/)
})

// ── Gaps closed after mutation testing ────────────────────────────────────────
// Each of these was written because a mutation SURVIVED the first pass: the
// behaviour was correct, but nothing proved it.

test('booking assignment refuses a pending contractor and accepts a verified one', async () => {
  await reset()
  process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
  try {
    const { applicant, staff } = await approve()
    const booking = { token: 'bk_contractor', bookingNumber: 'JK-B-9001', name: 'Cust', phone: '2145550000', service: 'junk', createdAt: Date.now(), updatedAt: Date.now(), status: 'confirmed' } as never
    await saveBooking(booking)
    const pending = await assignCrewToBooking('bk_contractor', staff.id, { actorId: 'u_admin', actorRole: 'admin' } as never)
    assert.equal(pending.ok, false, 'a pending contractor is not assignable')
    assert.equal((pending as { error: string }).error, 'inactive_staff')

    const a = (await getApplicant(applicant.id))!
    await submitOnboarding(a)
    assert.equal((await patch({ id: a.id, action: 'verify_onboarding' })).status, 200)
    const ready = await assignCrewToBooking('bk_contractor', staff.id, { actorId: 'u_admin', actorRole: 'admin' } as never)
    // The booking fixture is deliberately minimal, so the call may still fail on
    // booking-shape grounds — but never again on READINESS, which is the gate here.
    assert.notEqual((ready as { error?: string }).error, 'inactive_staff',
      'a verified contractor is no longer blocked by the readiness gate')
  } finally { delete process.env.BOOKING_ASSIGNMENT_ENABLED }
})

test('automated route reminders never dispatch to a pending or ended contractor', async () => {
  await reset()
  const { applicant, staff } = await approve()
  // The cron builds its dispatchable set from exactly this predicate; prove the set
  // excludes every non-ready state and includes a verified contractor.
  const dispatchable = async () => new Set((await listStaff(1000)).filter(staffCanAcceptAssignments).map(s => s.id))
  assert.equal((await dispatchable()).has(staff.id), false, 'pending_onboarding is never dispatched')

  const a = (await getApplicant(applicant.id))!
  await submitOnboarding(a)
  assert.equal((await dispatchable()).has(staff.id), false, 'pending_verification is never dispatched')

  await patch({ id: a.id, action: 'verify_onboarding' })
  assert.equal((await dispatchable()).has(staff.id), true, 'a verified contractor is dispatched normally')

  await patch({ id: a.id, action: 'end_contract' })
  assert.equal((await dispatchable()).has(staff.id), false, 'an ended contractor is never dispatched again')
})

test('a forged document path is refused even when its receipt matches', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const requestedAt = a.contractorOnboarding!.requestedAt
  const token = tokenFor(a)
  const code = await prepareSigning(a)
  // The receipt is minted for the forged path itself, so ONLY the path validator can
  // reject these. This is what makes the check independent of receipt binding.
  for (const forged of [
    'tenants/acme/contractor-docs/w9/x.pdf.enc',   // another tenant
    '../../../etc/passwd.pdf.enc',                  // traversal
    'random-bucket/w9/x.pdf.enc',                   // arbitrary prefix
    'contractor-docs/w9/x.exe.enc',                 // disallowed extension
  ]) {
    const documents = onboardingDocuments(a.id, requestedAt).map(d =>
      d.kind === 'w9'
        ? { kind: 'w9', url: forged, receipt: createOnboardingDocumentReceipt({ applicantId: a.id, kind: 'w9', path: forged, requestedAt }) }
        : d)
    const res = await onboardPOST(publicReq('/api/careers/onboarding', submission(token, documents, code)), CTX)
    assert.equal(res.status, 400, `${forged} must be refused by path validation`)
  }
})

test('retention deletion stays off unless it is explicitly enabled', async () => {
  await reset()
  // A rejected applicant whose document window closed long ago: the only thing
  // standing between it and deletion is the dry-run default.
  const longAgo = Date.now() - 10 * 365 * 86_400_000
  const doomed = applicantRecord({
    id: 'bc'.repeat(16), applicantNumber: 'JK-A-1500', status: 'rejected', rejectedAt: longAgo,
    documents: [{ kind: 'w9', url: 'contractor-docs/w9/old.pdf.enc', uploadedAt: longAgo }],
  })
  await saveApplicant(doomed)

  const decision = applicantRetentionDecision((await getApplicant(doomed.id))!, Date.now())
  assert.equal(decision.purgeRejectedDocuments, true, 'control: it IS past its deadline')
  assert.equal(decision.purgeRecord, true)

  const reported = await cleanupApplicantRetention(Date.now())          // default arg
  assert.ok(reported.records >= 1, 'the default run REPORTS what it would delete')
  assert.ok(await getApplicant(doomed.id), 'the default run deletes nothing')

  const cron = await import('../app/api/cron/daily/route')
  assert.ok(cron, 'cron module loads')
  // The cron only passes dryRun=false when the env switch is literally 'true'.
  assert.notEqual(process.env.APPLICANT_RETENTION_DELETE_ENABLED, 'true', 'destructive retention is off by default')
})

test('a sensitive onboarding upload refuses to store anything when encryption is unavailable', async () => {
  await reset()
  const { applicant } = await approve()
  const a = (await getApplicant(applicant.id))!
  const token = tokenFor(a)
  const file = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`

  // Break ONLY the document key — a malformed DOC_ENCRYPTION_KEY is a configuration
  // error that doc-crypto refuses to paper over. The session secret stays intact so
  // the onboarding token still verifies and the request reaches the crypto check.
  const explicit = process.env.DOC_ENCRYPTION_KEY
  process.env.DOC_ENCRYPTION_KEY = 'not-a-valid-key'
  try {
    assert.equal(docCryptoReady(), false, 'control: encryption really is unavailable')
    const res = await uploadPOST(publicReq('/api/careers/onboarding/upload', { token, kind: 'w9', file }), CTX)
    assert.equal(res.status, 503, 'a W-9 is never stored unencrypted')
    assert.match(String((await json(res)).error), /temporarily unavailable/)
  } finally {
    if (explicit === undefined) delete process.env.DOC_ENCRYPTION_KEY
    else process.env.DOC_ENCRYPTION_KEY = explicit
  }
  assert.equal(docCryptoReady(), true, 'encryption restored for the rest of the suite')
})

test('readiness is decided by contractor status, not by the legacy active flag alone', async () => {
  await reset()
  // Defence in depth: if a record ever carries a pending status while still flagged
  // active — a hand-edited or partially migrated row — the readiness gate must still
  // refuse it. `active` alone is not the contractor decision.
  const now = Date.now()
  const inconsistent = {
    id: 'inconsistent-1', name: 'Half Migrated', phone: '2145559999', role: 'Driver',
    active: true, contractorStatus: 'pending_verification' as const, createdAt: now, updatedAt: now,
  } as Staff
  await saveStaff(inconsistent)
  assert.equal(staffCanAcceptAssignments(inconsistent), false, 'pending status wins over active=true')
  assert.equal(staffMayReceivePay(inconsistent), false)

  const create = await routesPOST(adminReq('/api/admin/routes', 'POST', {
    businessName: 'Acme', reportAddress: '1 Dock St', reportTime: '07:00',
    routeDate: '2026-09-02', crew: [{ staffId: inconsistent.id }],
  }), CTX)
  assert.equal(create.status, 409, 'the route API refuses it too')

  const booking = { token: 'bk_inconsistent', bookingNumber: 'JK-B-9002', name: 'Cust', phone: '2145550000', service: 'junk', createdAt: now, updatedAt: now, status: 'confirmed' } as never
  await saveBooking(booking)
  process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
  try {
    const assigned = await assignCrewToBooking('bk_inconsistent', inconsistent.id, { actorId: 'u_admin', actorRole: 'admin' } as never)
    assert.equal(assigned.ok, false, 'booking assignment refuses it as well')
    assert.equal((assigned as { error: string }).error, 'inactive_staff')
  } finally { delete process.env.BOOKING_ASSIGNMENT_ENABLED }
})
