// Three confirmed concurrency defects from the 2026-07-26 race audit, promoted from
// the discovery harness into permanent regression tests.
//
// INV-1  a concurrent edit erased a recorded Stripe payment — the invoice reverted to
//        `sent` while Stripe held the money.
// APP-1  three concurrent applicant approvals minted three crew records; two were
//        orphaned on the live roster, assignable and payable.
// APRV-1 consumeApproval advertised "single-use" but was GET → check → SET, so three
//        concurrent consumes all succeeded.
//
// Every test drives the REAL exported code path. The fake models the Lua scripts the
// app actually uses, so a CAS or an ownership release behaves as it does in Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
type Entry = { value: string; expiresAt?: number }
const kv = new Map<string, Entry>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
let failOnce: ((cmd: string, key: string) => boolean) | null = null

function live(key: string): string | null {
  const e = kv.get(key)
  if (!e) return null
  if (e.expiresAt != null && e.expiresAt <= Date.now()) { kv.delete(key); return null }
  return e.value
}

// The Lua scripts in use: lock release / renew, the booking version CAS, the
// baseline-adoption multi-key CAS, and the APRV-1 consume CAS.
function evalScript(script: string, keys: string[], args: string[]): number {
  if (/pexpire/i.test(script) && /decoded\.status/.test(script)) {   // APRV-1 consume CAS
    const raw = live(keys[0])
    if (!raw) return 0
    if (JSON.parse(raw).status !== args[1]) return 0
    kv.set(keys[0], { value: args[0], expiresAt: Date.now() + Number(args[2]) })
    return 1
  }
  if (/pexpire/i.test(script) && /ARGV\[1\]/.test(script)) {          // lock renew
    const owns = live(keys[0]) === args[0]
    if (owns) kv.set(keys[0], { value: args[0], expiresAt: Date.now() + Number(args[1]) })
    return owns ? 1 : 0
  }
  if (/decoded\.updatedAt/.test(script)) {                           // baseline CAS
    const cur = live(keys[2])
    if (!cur || Number(JSON.parse(cur).updatedAt) !== Number(args[5])) return 0
    kv.set(keys[0], { value: args[0] }); z(keys[1]).set(args[2], Number(args[1]))
    kv.set(keys[2], { value: args[3] }); z(keys[3]).set(args[4], Number(args[1]))
    return 1
  }
  if (/cjson/.test(script)) {                                        // booking version CAS
    const raw = live(keys[0])
    let cur = 0
    if (raw) { try { cur = Number(JSON.parse(raw).version) || 0 } catch { /* 0 */ } }
    if (cur !== Number(args[1])) return 0
    kv.set(keys[0], { value: args[0] })
    return 1
  }
  const owns = live(keys[0]) === args[0]                             // compare-and-delete
  if (owns) kv.delete(keys[0])
  return owns ? 1 : 0
}

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  await new Promise(r => setImmediate(r))   // real IO interleaves concurrent callers
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const command = String(cmd).toUpperCase()
  const key = args[0]
  if (failOnce?.(command, key)) { failOnce = null; throw new Error('fake redis: injected failure') }
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(key); break
    case 'SET': {
      const flags = args.slice(2).map(a => String(a).toUpperCase())
      const nx = flags.includes('NX'); const pxAt = flags.indexOf('PX')
      const ttl = pxAt >= 0 ? Number(args[2 + pxAt + 1]) : undefined
      if (nx && live(key) !== null) { result = null; break }
      kv.set(key, { value: args[1], expiresAt: ttl != null ? Date.now() + ttl : undefined })
      result = 'OK'; break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(live(key) ?? 0) + 1; kv.set(key, { value: String(n) }); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(key).delete(args[1]) ? 1 : 0; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE': case 'ZREVRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
      if (command === 'ZREVRANGE') arr.reverse()
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1); break
    }
    case 'PEXPIRE': {
      const e = kv.get(key); if (e) e.expiresAt = Date.now() + Number(args[1]); result = 1; break
    }
    case 'EXPIRE': result = 1; break
    case 'EVAL': {
      const n = Number(args[1])
      result = evalScript(String(args[0]), args.slice(2, 2 + n), args.slice(2 + n))
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import * as INV from '../app/lib/route-invoices'
import {
  claimPromotion, commitPromotion, releasePromotionClaim, promotedStaffIdFor,
  awaitPromotedStaffId, PROMOTION_KEY, generateApplicantId, saveApplicant, getApplicant,
} from '../app/lib/applicants'
import { saveStaff, listStaff, findStaffDuplicate } from '../app/lib/staff'
import * as APPROVALS from '../app/lib/platform/release/approval-store'
import { releaseBindingFingerprint } from '../app/lib/platform/release/approval'
import type { RouteInvoice } from '../app/lib/route-invoices'

const reset = () => { kv.clear(); zsets.clear(); failOnce = null }
const keysLike = (re: RegExp) => [...kv.keys()].filter(k => re.test(k) && live(k) !== null)

// ═════════════════════════════════════════════════════════════════════════════
// INV-1 — route-invoice payment vs concurrent edit
// ═════════════════════════════════════════════════════════════════════════════

async function mkInvoice(amount = 50_000): Promise<RouteInvoice> {
  const invoice: RouteInvoice = {
    token: INV.generateToken(), invoiceNumber: await INV.nextInvoiceNumber(),
    businessName: 'Acme', clientName: 'Acme',
    lines: [{ description: 'Route', amountCents: amount } as never],
    status: 'sent', amountPaidCents: 0, createdAt: 1, updatedAt: 1,
  }
  await INV.saveInvoice(invoice)
  return invoice
}
const session = (id: string, token: string) =>
  ({ id, payment_status: 'paid', metadata: { invoiceToken: token } }) as never

test('INV-1: a note edit racing payment recording cannot revert paid state', async () => {
  reset()
  const inv = await mkInvoice()

  // The edit reads FIRST (unpaid), then saves after the payment lands — the exact
  // interleaving that used to erase the payment.
  const edit = INV.mutateInvoice(inv.token, async (fresh) => {
    await new Promise(r => setTimeout(r, 10))
    fresh.notes = 'Client asked for a PO number'
    return 'edited'
  }, { onBusy: () => 'busy' })
  const payment = INV.recordStripeInvoicePayment(session('cs_1', inv.token))
  await Promise.all([edit, payment])

  const after = (await INV.getInvoiceByToken(inv.token))!
  assert.equal(after.status, 'paid', 'the payment survived the concurrent edit')
  assert.equal(after.amountPaidCents, 50_000)
  assert.equal(after.stripeSessionId, 'cs_1', 'payment identity intact')
  assert.ok(after.paidAt, 'paid timestamp intact')
  assert.equal(after.paidMethod, 'card')
  assert.equal(after.notes, 'Client asked for a PO number', 'and the edit was not lost either')
})

test('INV-1: a status edit racing payment recording cannot revert paid state', async () => {
  reset()
  const inv = await mkInvoice()
  const edit = INV.mutateInvoice(inv.token, async (fresh) => {
    await new Promise(r => setTimeout(r, 10))
    if (fresh.status === 'paid') return false          // a real editor refuses to touch a paid invoice
    fresh.status = 'draft'
    return 'edited'
  }, { onBusy: () => 'busy' })
  await Promise.all([edit, INV.recordStripeInvoicePayment(session('cs_2', inv.token))])

  const after = (await INV.getInvoiceByToken(inv.token))!
  assert.equal(after.status, 'paid')
  assert.equal(after.amountPaidCents, 50_000)
})

test('INV-1: manual payment racing the Stripe webhook converges without double credit', async () => {
  reset()
  const inv = await mkInvoice()
  const manual = INV.mutateInvoice(inv.token, (fresh) => {
    if (fresh.status === 'paid') return false
    fresh.amountPaidCents = INV.subtotalCents(fresh)
    fresh.status = 'paid'; fresh.paidAt = Date.now(); fresh.paidMethod = 'manual'
    return 'manual'
  }, { onBusy: () => 'busy' })
  await Promise.all([manual, INV.recordStripeInvoicePayment(session('cs_3', inv.token))])

  const after = (await INV.getInvoiceByToken(inv.token))!
  assert.equal(after.status, 'paid')
  assert.equal(after.amountPaidCents, 50_000, 'the amount is ASSIGNED once, never summed')
  assert.ok(after.paidMethod === 'manual' || after.paidMethod === 'card')
})

test('INV-1: a repeated Stripe session stays idempotent', async () => {
  reset()
  const inv = await mkInvoice()
  await INV.recordStripeInvoicePayment(session('cs_4', inv.token))
  const before = JSON.stringify(await INV.getInvoiceByToken(inv.token))
  await INV.recordStripeInvoicePayment(session('cs_4', inv.token))
  await INV.recordStripeInvoicePayment(session('cs_4', inv.token))
  assert.equal(JSON.stringify(await INV.getInvoiceByToken(inv.token)), before, 'replays change nothing')
})

test('INV-1: five concurrent deliveries of one session credit the amount once', async () => {
  reset()
  const inv = await mkInvoice()
  await Promise.all(Array.from({ length: 5 }, () => INV.recordStripeInvoicePayment(session('cs_5', inv.token))))
  const after = (await INV.getInvoiceByToken(inv.token))!
  assert.equal(after.amountPaidCents, 50_000, 'never additive')
  assert.equal(after.status, 'paid')
})

test('INV-1: unrelated invoices mutate concurrently and never block', async () => {
  reset()
  const [a, b] = [await mkInvoice(10_000), await mkInvoice(20_000)]
  const t0 = Date.now()
  await Promise.all([
    INV.mutateInvoice(a.token, async (f) => { await new Promise(r => setTimeout(r, 60)); f.notes = 'A'; return 'a' }, { onBusy: () => 'busy' }),
    INV.mutateInvoice(b.token, async (f) => { await new Promise(r => setTimeout(r, 60)); f.notes = 'B'; return 'b' }, { onBusy: () => 'busy' }),
  ])
  assert.ok(Date.now() - t0 < 200, 'they ran in parallel, not one after the other')
  assert.equal((await INV.getInvoiceByToken(a.token))!.notes, 'A')
  assert.equal((await INV.getInvoiceByToken(b.token))!.notes, 'B')
})

test('INV-1: an expired holder cannot delete a successor\'s invoice lease', async () => {
  reset()
  const inv = await mkInvoice()
  const key = INV.INVOICE_LOCK_KEY(inv.token)
  const slow = INV.withInvoiceLock(inv.token, async () => {
    await new Promise(r => setTimeout(r, 150))
    return 'slow'
  }, { onBusy: () => 'busy', ttlMs: 40 })
  await new Promise(r => setTimeout(r, 80))
  kv.set(key, { value: 'successor-token', expiresAt: Date.now() + 60_000 })
  assert.equal(await slow, 'slow')
  assert.equal(live(key), 'successor-token', 'the successor still holds its lease')
})

test('INV-1: a failed write releases the invoice lease', async () => {
  reset()
  const inv = await mkInvoice()
  await assert.rejects(async () => {
    await INV.withInvoiceLock(inv.token, async () => { throw new Error('boom') }, { onBusy: () => null })
  })
  assert.deepEqual(keysLike(/^rt:inv:lock:/), [], 'no orphaned lease')
  assert.equal(await INV.withInvoiceLock(inv.token, async () => 'ok', { onBusy: () => 'busy' }), 'ok')
})

test('INV-1: contention returns the caller\'s controlled result, never a throw', async () => {
  reset()
  const inv = await mkInvoice()
  kv.set(INV.INVOICE_LOCK_KEY(inv.token), { value: 'someone-else', expiresAt: Date.now() + 60_000 })
  const out = await INV.withInvoiceLock(inv.token, async () => 'ran', { onBusy: () => 'busy' })
  assert.equal(out, 'busy')
  assert.equal(live(INV.INVOICE_LOCK_KEY(inv.token)), 'someone-else', 'the holder\'s lease is untouched')
})

// ═════════════════════════════════════════════════════════════════════════════
// APP-1 — applicant approval creates duplicate crew
// ═════════════════════════════════════════════════════════════════════════════

const applicant = (id: string) => ({
  id, applicantNumber: `JK-A-${id.slice(0, 4)}`, name: 'Casey Hire', phone: '+15550123',
  email: `${id.slice(0, 6)}@example.test`, position: 'driver', status: 'interview',
  documents: [], events: [], createdAt: 1, updatedAt: 1,
} as never)

/** The hire branch of app/api/admin/careers, reduced to its promotion logic. */
async function approve(applicantId: string): Promise<string | null> {
  const a = await getApplicant(applicantId) as never as Record<string, unknown>
  if (!a) return null
  if (a.promotedStaffId) return a.promotedStaffId as string
  const committed = await promotedStaffIdFor(applicantId)
  if (committed) { a.promotedStaffId = committed; await saveApplicant(a as never); return committed }

  const claim = await claimPromotion(applicantId)
  if (!claim.won) {
    const winner = claim.staffId ?? await awaitPromotedStaffId(applicantId)
    if (winner) { a.promotedStaffId = winner; await saveApplicant(a as never) }
    return winner
  }
  let promotedId: string | null = null
  try {
    const dup = await findStaffDuplicate({ applicantId, email: a.email as string, phone: a.phone as string })
    if (dup) promotedId = dup.id
    else {
      const sid = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
      await saveStaff({
        id: sid, name: a.name as string, phone: a.phone as string, email: a.email as string,
        role: 'Driver', active: true, applicantId, onboarding: true, createdAt: 2, updatedAt: 2,
      } as never)
      promotedId = sid
    }
    await commitPromotion(applicantId, promotedId)
    a.promotedStaffId = promotedId
    await saveApplicant(a as never)
    return promotedId
  } catch (e) {
    if (!promotedId) await releasePromotionClaim(applicantId, claim.token)
    throw e
  }
}

const crewFor = async (applicantId: string) =>
  (await listStaff()).filter(s => (s as never as { applicantId?: string }).applicantId === applicantId)

test('APP-1: three concurrent approvals create exactly ONE crew record', async () => {
  reset()
  const id = generateApplicantId()
  await saveApplicant(applicant(id))

  const results = await Promise.all([approve(id), approve(id), approve(id)])
  const crew = await crewFor(id)
  assert.equal(crew.length, 1, `one crew record, got ${crew.length}`)
  assert.equal(new Set(results).size, 1, 'every caller converged on the same staff id')
  assert.equal(results[0], crew[0].id)

  const finalApplicant = await getApplicant(id) as never as { promotedStaffId?: string }
  assert.equal(finalApplicant.promotedStaffId, crew[0].id, 'the applicant points at the record that exists')
  assert.equal(await promotedStaffIdFor(id), crew[0].id, 'and so does the durable mapping')
})

test('APP-1: no orphan staff records remain', async () => {
  reset()
  const id = generateApplicantId()
  await saveApplicant(applicant(id))
  await Promise.all(Array.from({ length: 5 }, () => approve(id)))
  const crew = await crewFor(id)
  const final = await getApplicant(id) as never as { promotedStaffId?: string }
  assert.equal(crew.length, 1)
  assert.deepEqual(crew.filter(s => s.id !== final.promotedStaffId), [], 'nothing assignable was left behind')
})

test('APP-1: sequential repeat approval is idempotent', async () => {
  reset()
  const id = generateApplicantId()
  await saveApplicant(applicant(id))
  const first = await approve(id)
  const second = await approve(id)
  const third = await approve(id)
  assert.equal(second, first)
  assert.equal(third, first)
  assert.equal((await crewFor(id)).length, 1)
})

test('APP-1: different applicants approve concurrently', async () => {
  reset()
  const ids = [generateApplicantId(), generateApplicantId(), generateApplicantId()]
  for (const id of ids) await saveApplicant(applicant(id))
  const results = await Promise.all(ids.map(id => approve(id)))
  assert.equal(new Set(results).size, 3, 'three distinct crew records')
  for (const id of ids) assert.equal((await crewFor(id)).length, 1)
})

test('APP-1: claim ownership prevents cross-release', async () => {
  reset()
  const id = generateApplicantId()
  const first = await claimPromotion(id)
  assert.equal(first.won, true)
  await releasePromotionClaim(id, 'not-my-token')
  assert.equal(live(PROMOTION_KEY(id)) !== null, true, 'a foreign token cannot free the claim')
  await releasePromotionClaim(id, (first as { won: true; token: string }).token)
  assert.equal(live(PROMOTION_KEY(id)), null, 'the owner can')
})

test('APP-1: a crash BEFORE the staff save leaves no residue and permits a retry', async () => {
  reset()
  const id = generateApplicantId()
  await saveApplicant(applicant(id))
  failOnce = (cmd, key) => cmd === 'SET' && key.startsWith('staff:')
  await assert.rejects(async () => { await approve(id) })

  assert.equal((await crewFor(id)).length, 0, 'no crew record was created')
  assert.equal(live(PROMOTION_KEY(id)), null, 'and the claim was released')
  const retried = await approve(id)
  assert.ok(retried)
  assert.equal((await crewFor(id)).length, 1, 'the retry promotes exactly once')
})

test('APP-1: a crash AFTER the staff save recovers without minting a second person', async () => {
  reset()
  const id = generateApplicantId()
  await saveApplicant(applicant(id))
  // Promote, then simulate dying before the applicant record was updated.
  const staffId = await approve(id)
  const a = await getApplicant(id) as never as Record<string, unknown>
  delete a.promotedStaffId
  await saveApplicant(a as never)

  const again = await approve(id)
  assert.equal(again, staffId, 'recovered via the durable mapping')
  assert.equal((await crewFor(id)).length, 1, 'no second person')
})

test('APP-1: the durable mapping survives, and a stale claim expires rather than wedging', async () => {
  reset()
  const id = generateApplicantId()
  const claim = await claimPromotion(id) as { won: true; token: string }
  const entry = kv.get(PROMOTION_KEY(id))!
  assert.ok(entry.expiresAt, 'an in-flight claim is time-bounded')
  entry.expiresAt = Date.now() - 1                       // the claimant died
  const retry = await claimPromotion(id)
  assert.equal(retry.won, true, 'the identity is claimable again')
  await commitPromotion(id, 'staff_abc')
  assert.equal(kv.get(PROMOTION_KEY(id))!.expiresAt, undefined, 'the committed mapping is permanent')
  assert.equal(await promotedStaffIdFor(id), 'staff_abc')
  void claim
})

// ═════════════════════════════════════════════════════════════════════════════
// APRV-1 — approval consumption is a single-use atomic transition
// ═════════════════════════════════════════════════════════════════════════════

const BUSINESS = { id: 'acme', slug: 'acme' }
const BINDING = { releaseId: 'rel_1', sourceDeploymentId: 'dpl_1' }
const NOW = 5_000_000

async function makeApproval() {
  const r = await APPROVALS.createApproval({
    now: NOW, business: BUSINESS, binding: BINDING, approvedBy: 'owner', phraseVerified: true,
  } as never) as never as { ok: true; approval: { id: string } }
  return r.approval.id
}
const fp = () => releaseBindingFingerprint(BINDING as never)

test('APRV-1: three concurrent consumes produce exactly ONE success', async () => {
  reset()
  const id = await makeApproval()
  const results = await Promise.all([
    APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: fp() }),
    APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: fp() }),
    APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: fp() }),
  ])
  const won = results.filter(r => r.ok)
  assert.equal(won.length, 1, `single-use holds under concurrency, got ${won.length} successes`)
  const lost = results.filter(r => !r.ok) as never as { code: string }[]
  assert.equal(lost.length, 2)
  for (const l of lost) assert.ok(['ALREADY_CONSUMED', 'NOT_ACTIVE'].includes(l.code), `controlled conflict, got ${l.code}`)
})

test('APRV-1: the consumed record carries the WINNER\'s timestamp only', async () => {
  reset()
  const id = await makeApproval()
  const results = await Promise.all([
    APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: fp() }),
    APPROVALS.consumeApproval(id, { now: NOW + 9999, expectedFingerprint: fp() }),
  ])
  const winner = results.find(r => r.ok) as never as { approval: { consumedAt: number } }
  const stored = await APPROVALS.getApproval(id) as never as { status: string; consumedAt: number; approvedBy: string }
  assert.equal(stored.status, 'consumed')
  assert.equal(stored.consumedAt, winner.approval.consumedAt, 'only the winner wrote')
  assert.equal(stored.approvedBy, 'owner', 'every other field is preserved')
})

test('APRV-1: sequential consume is rejected after the first', async () => {
  reset()
  const id = await makeApproval()
  assert.equal((await APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: fp() })).ok, true)
  const second = await APPROVALS.consumeApproval(id, { now: NOW + 2000, expectedFingerprint: fp() })
  assert.equal(second.ok, false)
  assert.equal((second as never as { code: string }).code, 'NOT_ACTIVE')
})

test('APRV-1: a revoked or superseded approval can never be consumed', async () => {
  reset()
  const id = await makeApproval()
  await APPROVALS.revokeApproval(id, NOW + 500)
  const r = await APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: fp() })
  assert.equal(r.ok, false)
  const stored = await APPROVALS.getApproval(id) as never as { status: string }
  assert.equal(stored.status, 'revoked', 'a failed consume mutates nothing')
})

test('APRV-1: a fingerprint mismatch is refused and leaves state unchanged', async () => {
  reset()
  const id = await makeApproval()
  const before = JSON.stringify(await APPROVALS.getApproval(id))
  const r = await APPROVALS.consumeApproval(id, { now: NOW + 1000, expectedFingerprint: 'a-different-release' })
  assert.equal(r.ok, false)
  assert.equal(JSON.stringify(await APPROVALS.getApproval(id)), before, 'CAS failure leaves the record byte-identical')
})

test('APRV-1: approval creation concurrency remains safe', async () => {
  reset()
  const results = await Promise.all([
    APPROVALS.createApproval({ now: NOW, business: BUSINESS, binding: BINDING, approvedBy: 'owner', phraseVerified: true } as never),
    APPROVALS.createApproval({ now: NOW, business: BUSINESS, binding: BINDING, approvedBy: 'owner', phraseVerified: true } as never),
    APPROVALS.createApproval({ now: NOW, business: BUSINESS, binding: BINDING, approvedBy: 'owner', phraseVerified: true } as never),
  ])
  const ok = results.filter(r => (r as { ok: boolean }).ok) as never as { approval: { id: string }; reused: boolean }[]
  assert.ok(new Set(ok.map(r => r.approval.id)).size <= 1, 'at most one approval identity')
  assert.ok(ok.filter(r => !r.reused).length <= 1, 'at most one create')
})
