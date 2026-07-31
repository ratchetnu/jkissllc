// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5 — the retail customer record.
//
// These exercise real behaviour against a live KV emulator: real bookings, real
// payments, real identity indexes, real tenant contexts. The one thing they pin by
// source is the RBAC matrix, because that IS the artifact.
//
// The properties that matter, and why:
//   • name is NEVER an identifier — two people share a name far more often than a
//     phone number, and a bad merge joins one person's money to another's;
//   • email/phone disagreement FAILS CLOSED to `conflict` rather than preferring
//     a side (which is what `customers.findCustomerId` does, correctly, for a
//     different question);
//   • a booking with no identifiers is explicitly unlinked, never guessed;
//   • the join is tenant-scoped — a customer in one tenant cannot see another's;
//   • truncation and unreadable records are REPORTED, so "no history" and "we
//     stopped looking" stay distinguishable.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
// Run the WHOLE file with tenancy on. `scopeKey` no-ops when the flag is off, so a
// suite that left it off would be asserting isolation the transform never applied —
// green, and proving nothing. `cust:` and `bk:` are both outside
// PLATFORM_GLOBAL_PREFIXES, so both are tenant-owned and get scoped.
process.env.TENANCY_ENABLED = 'true'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 8500 + (process.pid % 150)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { saveBooking, type Booking, type Payment } from '../app/lib/bookings'
import { upsertCustomer } from '../app/lib/customers'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { redis } from '../app/lib/redis'
import { resolveCustomerLink, linksTo } from '../app/lib/customer-link'
import { buildCustomerTimeline } from '../app/lib/customer-timeline'
import { can } from '../app/lib/rbac'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(() => fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {}))

const TEN = 'jkiss'
const OTHER = 'supercharged'
let seq = 0

const pay = (over: Partial<Payment> = {}): Payment => ({
  id: `p_${++seq}`, type: 'deposit', method: 'stripe', status: 'confirmed',
  amountCents: 10_000, feeCents: 0, totalChargedCents: 10_000, netCents: 10_000,
  createdAt: 1_700_000_000_000, confirmedAt: 1_700_000_000_000, ...over,
} as Payment)

const mkBooking = (over: Partial<Booking> = {}): Booking => ({
  token: `tok${++seq}`.padEnd(16, '0'),
  bookingNumber: `JK-B-${1000 + seq}`,
  customerName: 'Sam Retail',
  serviceType: 'junk_removal',
  items: [], availableDates: [], availableWindows: [],
  invoiceAmountCents: 20_000, depositAmountCents: 0, amountPaidCents: 0,
  status: 'confirmed', payments: [], events: [],
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  ...over,
} as unknown as Booking)

const seed = (t: string, b: Booking) => runWithTenant({ tenantId: t }, () => saveBooking(b))
const mkCustomer = (t: string, name: string, email?: string, phone?: string) =>
  runWithTenant({ tenantId: t }, async () => (await upsertCustomer({ name, email, phone, tenantId: t })).customer)
const resolve = (t: string, email?: string, phone?: string) =>
  runWithTenant({ tenantId: t }, () => resolveCustomerLink({ email, phone }, redis))
const timeline = (t: string, id: string, opts = {}) =>
  runWithTenant({ tenantId: t }, () => buildCustomerTimeline(id, opts))

// ── Determinism of the join ──────────────────────────────────────────────────

test('LINK: matching name alone NEVER links — identity is email or phone only', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com', '8175550101')
  assert.ok(c.id)
  // Same name, no shared identifier at all.
  const link = await resolve(TEN, undefined, undefined)
  assert.equal(link.kind, 'unlinked')
  assert.equal(link.kind === 'unlinked' && link.reason, 'no_identifier')

  // And a DIFFERENT person with the same name does not resolve to them either.
  const other = await resolve(TEN, 'notsam@example.com', '8175559999')
  assert.equal(other.kind, 'unlinked')
  assert.equal(other.kind === 'unlinked' && other.reason, 'no_customer_record')
})

test('LINK: email and phone agreeing reports basis email+phone', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com', '8175550101')
  const link = await resolve(TEN, 'sam@example.com', '8175550101')
  assert.equal(link.kind, 'linked')
  assert.equal(link.kind === 'linked' && link.customerId, c.id)
  assert.equal(link.kind === 'linked' && link.basis, 'email+phone')
  assert.equal(link.kind === 'linked' && link.provenance, 'derived', 'the link is never presented as stored')
})

test('LINK: only one identifier resolvable reports THAT basis', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com', '8175550101')
  const byEmail = await resolve(TEN, 'sam@example.com', '8175559999')
  assert.equal(byEmail.kind === 'linked' && byEmail.basis, 'email')
  assert.equal(byEmail.kind === 'linked' && byEmail.customerId, c.id)

  const byPhone = await resolve(TEN, 'nobody@example.com', '8175550101')
  assert.equal(byPhone.kind === 'linked' && byPhone.basis, 'phone')
  assert.equal(byPhone.kind === 'linked' && byPhone.customerId, c.id)
})

test('LINK: email and phone pointing at DIFFERENT customers fails closed', async () => {
  const a = await mkCustomer(TEN, 'Person A', 'a@example.com')
  const b = await mkCustomer(TEN, 'Person B', undefined, '8175550202')
  assert.notEqual(a.id, b.id)

  const link = await resolve(TEN, 'a@example.com', '8175550202')
  assert.equal(link.kind, 'conflict', 'never silently prefers one side')
  assert.equal(link.kind === 'conflict' && link.emailCustomerId, a.id)
  assert.equal(link.kind === 'conflict' && link.phoneCustomerId, b.id)
  // And it attributes to NEITHER.
  assert.equal(linksTo(link, a.id), false)
  assert.equal(linksTo(link, b.id), false)
})

test('LINK: normalization is applied — case, spacing and punctuation do not split identity', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'Sam@Example.COM', '(817) 555-0101')
  const link = await resolve(TEN, '  sam@example.com ', '817-555-0101')
  assert.equal(link.kind === 'linked' && link.customerId, c.id)
})

test('LINK: a too-short phone is not an identifier', async () => {
  await mkCustomer(TEN, 'Sam Retail', 'sam@example.com', '8175550101')
  const link = await resolve(TEN, undefined, '12345')
  assert.equal(link.kind, 'unlinked')
  assert.equal(link.kind === 'unlinked' && link.reason, 'no_identifier')
})

// ── Tenancy ──────────────────────────────────────────────────────────────────

test('TENANCY: an identical email in another tenant resolves to a DIFFERENT customer', async () => {
  const mine = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com', '8175550101')
  const theirs = await mkCustomer(OTHER, 'Sam Retail', 'sam@example.com', '8175550101')
  assert.notEqual(mine.id, theirs.id, 'the same identity in two tenants is two records')

  const a = await resolve(TEN, 'sam@example.com')
  const b = await resolve(OTHER, 'sam@example.com')
  assert.equal(a.kind === 'linked' && a.customerId, mine.id)
  assert.equal(b.kind === 'linked' && b.customerId, theirs.id)
})

test('TENANCY: a timeline cannot reach another tenant’s bookings', async () => {
  const mine = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  await mkCustomer(OTHER, 'Sam Retail', 'sam@example.com')
  await seed(TEN, mkBooking({ customerEmail: 'sam@example.com', bookingNumber: 'JK-B-MINE' }))
  await seed(OTHER, mkBooking({ customerEmail: 'sam@example.com', bookingNumber: 'JK-B-THEIRS' }))

  const t = await timeline(TEN, mine.id)
  assert.ok(t)
  const numbers = t!.bookings.map(b => b.bookingNumber)
  assert.deepEqual(numbers, ['JK-B-MINE'], 'only this tenant’s booking is joined')
})

test('TENANCY: the store fails closed with no tenant context', async () => {
  await assert.rejects(() => buildCustomerTimeline('c_'.padEnd(22, 'a')),
    'a tenant-less read must throw, not silently return a global answer')
})

// ── Timeline assembly ────────────────────────────────────────────────────────

test('TIMELINE: joins bookings, payments, refunds and communications with provenance', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com', '8175550101')
  await seed(TEN, mkBooking({
    customerEmail: 'sam@example.com', customerPhone: '8175550101', bookingNumber: 'JK-B-2001',
    payments: [pay({ amountCents: 15_000 }), pay({ amountCents: 5_000, status: 'refunded' })],
    communications: [{ at: 1_700_000_100_000, channel: 'sms', body: 'On our way', by: 'admin', ok: true }],
    events: [{ at: 1_700_000_050_000, actor: 'system', action: 'booking.created' }],
  } as Partial<Booking>))

  const t = (await timeline(TEN, c.id))!
  assert.equal(t.totals.bookings, 1)
  assert.equal(t.totals.paidCents, 15_000, 'only CONFIRMED payments count as paid')
  assert.equal(t.totals.refundedCents, 5_000, 'a refund is counted separately, not netted silently')
  assert.equal(t.totals.communications, 1)

  const kinds = t.entries.map(e => e.kind)
  assert.ok(kinds.includes('booking') && kinds.includes('payment') && kinds.includes('refund') && kinds.includes('communication'))

  // Provenance: ONLY the booking attribution is derived.
  const booking = t.entries.find(e => e.kind === 'booking')!
  assert.equal(booking.provenance, 'derived')
  for (const e of t.entries.filter(e => e.kind !== 'booking')) {
    assert.equal(e.provenance, 'stored', `${e.kind} is stored on the booking, not derived`)
  }
  assert.equal(t.linkProvenance, 'derived')
})

test('TIMELINE: entries are newest-first', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  await seed(TEN, mkBooking({
    customerEmail: 'sam@example.com',
    payments: [pay({ confirmedAt: 1_700_000_900_000 })],
    communications: [{ at: 1_700_000_500_000, channel: 'sms', body: 'hi', by: 'admin', ok: true }],
  } as Partial<Booking>))
  const t = (await timeline(TEN, c.id))!
  const ats = t.entries.map(e => e.at)
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a), 'newest first')
})

test('TIMELINE: audit entries appear ONLY when the reader is authorized', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  await seed(TEN, mkBooking({
    customerEmail: 'sam@example.com',
    events: [{ at: 1_700_000_060_000, actor: 'admin', action: 'status.changed', result: 'confirmed' }],
  } as Partial<Booking>))

  const without = (await timeline(TEN, c.id, { includeAudit: false }))!
  assert.equal(without.entries.some(e => e.kind === 'audit'), false, 'omitted server-side, not hidden in the UI')
  assert.equal(without.includesAudit, false)

  const with_ = (await timeline(TEN, c.id, { includeAudit: true }))!
  assert.equal(with_.entries.some(e => e.kind === 'audit'), true)
  assert.equal(with_.includesAudit, true)
})

test('TIMELINE: a booking with no identifiers is counted as unlinked, never attributed', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  await seed(TEN, mkBooking({ customerEmail: 'sam@example.com', bookingNumber: 'JK-B-LINKED' }))
  await seed(TEN, mkBooking({ customerName: 'Sam Retail', bookingNumber: 'JK-B-ANON' }))  // same NAME, no email/phone

  const t = (await timeline(TEN, c.id))!
  assert.deepEqual(t.bookings.map(b => b.bookingNumber), ['JK-B-LINKED'])
  assert.equal(t.scan.unlinkedNoIdentifier, 1, 'reported, not silently dropped')
})

test('TIMELINE: a conflicted booking is surfaced for review and EXCLUDED from totals', async () => {
  const a = await mkCustomer(TEN, 'Person A', 'a@example.com')
  const b = await mkCustomer(TEN, 'Person B', undefined, '8175550202')
  await seed(TEN, mkBooking({
    customerEmail: 'a@example.com', customerPhone: '8175550202', bookingNumber: 'JK-B-CONFLICT',
    payments: [pay({ amountCents: 99_000 })],
  } as Partial<Booking>))

  const t = (await timeline(TEN, a.id))!
  assert.equal(t.totals.bookings, 0, 'never attributed to either side')
  assert.equal(t.totals.paidCents, 0, 'and its money is not counted')
  assert.equal(t.conflicts.length, 1)
  assert.equal(t.conflicts[0].bookingNumber, 'JK-B-CONFLICT')
  assert.equal(t.conflicts[0].emailCustomerId, a.id)
  assert.equal(t.conflicts[0].phoneCustomerId, b.id)

  // Both sides see it, because either could be the right owner.
  const t2 = (await timeline(TEN, b.id))!
  assert.equal(t2.conflicts.length, 1)
})

test('TIMELINE: a conflict between two OTHER customers is not shown to a third', async () => {
  const a = await mkCustomer(TEN, 'Person A', 'a@example.com')
  const b = await mkCustomer(TEN, 'Person B', undefined, '8175550202')
  const c = await mkCustomer(TEN, 'Person C', 'c@example.com')
  assert.ok(a.id && b.id)
  await seed(TEN, mkBooking({ customerEmail: 'a@example.com', customerPhone: '8175550202' }))

  const t = (await timeline(TEN, c.id))!
  assert.equal(t.conflicts.length, 0, 'someone else’s ambiguity is not this reader’s business')
})

test('TIMELINE: an unknown customer id is null, distinct from a customer with no activity', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  assert.equal(await timeline(TEN, 'c_' + 'f'.repeat(20)), null, 'unknown → null → 404')
  const empty = await timeline(TEN, c.id)
  assert.ok(empty, 'known customer with no bookings is a real, empty timeline')
  assert.equal(empty!.totals.bookings, 0)
})

// ── Completeness ─────────────────────────────────────────────────────────────

test('SCAN: a truncated scan reports itself incomplete', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  for (let i = 0; i < 6; i++) await seed(TEN, mkBooking({ customerEmail: 'sam@example.com' }))

  const full = (await timeline(TEN, c.id, { pageSize: 100 }))!
  assert.equal(full.scan.complete, true)
  assert.equal(full.totals.bookings, 6)

  // One page of 2, then stop: the answer is partial and must say so.
  const partial = (await timeline(TEN, c.id, { pageSize: 2, maxPages: 1 }))!
  assert.equal(partial.scan.complete, false, 'never claims completeness it did not earn')
  assert.equal(partial.scan.pageLimitReached, true)
  assert.ok(partial.totals.bookings < 6, 'and the totals are a floor, not a balance')
})

test('SCAN: an unreadable record makes the answer incomplete rather than silently short', async () => {
  const c = await mkCustomer(TEN, 'Sam Retail', 'sam@example.com')
  const b = mkBooking({ customerEmail: 'sam@example.com' })
  await seed(TEN, b)
  // Corrupt the record while leaving it in the index — exactly what a partial
  // write or a rolled-back migration looks like.
  await runWithTenant({ tenantId: TEN }, () => redis.set(`bk:${b.token}`, '{not json'))

  const t = (await timeline(TEN, c.id))!
  assert.equal(t.scan.missingRecords, 1)
  assert.equal(t.scan.complete, false, '"no history" and "we could not read it" must differ')
})

// ── Authorization matrix ─────────────────────────────────────────────────────

test('RBAC: customers:view reaches admin and manager; booking audit stays admin-only', () => {
  assert.equal(can('admin', 'customers:view'), true)
  assert.equal(can('manager', 'customers:view'), true)
  assert.equal(can('crew', 'customers:view'), false, 'crew never reads customer records')

  assert.equal(can('admin', 'audit:view'), true)
  assert.equal(can('manager', 'audit:view'), false, 'rbac.ts keeps audit:view admin-only')
})

test('RBAC: the API gates the timeline on customers:view and the audit section on audit:view', () => {
  const src = readFileSync(new URL('../app/api/admin/customers/[id]/route.ts', import.meta.url), 'utf8')
  assert.match(src, /requirePermission\(req, 'customers:view'\)/)
  assert.match(src, /includeAudit: can\(who\.role, 'audit:view'\)/,
    'the audit decision is made server-side from the principal, never from the request')
  const lookup = readFileSync(new URL('../app/api/admin/customers/lookup/route.ts', import.meta.url), 'utf8')
  assert.match(lookup, /requirePermission\(req, 'customers:view'\)/)
  // Both must be tenant-wrapped or the chokepoint has no context to scope by.
  assert.match(src, /withTenantRoute\(/)
  assert.match(lookup, /withTenantRoute\(/)
})

test('RBAC: a malformed customer id is an indistinguishable 404, never a store read', () => {
  const src = readFileSync(new URL('../app/api/admin/customers/[id]/route.ts', import.meta.url), 'utf8')
  assert.match(src, /ID_RE\.test\(id\)/)
  const idre = /const ID_RE = (\/.+\/)\n/.exec(src)
  assert.ok(idre, 'the id pattern must be explicit')
  const re = new RegExp(idre![1].slice(1, -1))
  assert.equal(re.test('c_' + 'a'.repeat(20)), true)
  for (const bad of ['../../etc/passwd', 'c_short', '', 'C_' + 'A'.repeat(20), 'c_' + 'g'.repeat(20)]) {
    assert.equal(re.test(bad), false, `${JSON.stringify(bad)} must not reach the store`)
  }
})
