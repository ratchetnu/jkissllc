// Communications layer tests (Phase 8). Pure + dependency-injected — no Redis, no
// real provider calls. dispatchComm's seams are faked so the whole decision tree
// (send mode, idempotency, opt-out, quiet hours, retries, ledger) is exercised
// deterministically, and no test can send a real message.

import assert from 'node:assert/strict'
import test from 'node:test'

import { COMM_EVENTS, getEventDef, isCommEvent } from '../app/lib/comms/events'
import { renderTemplate, previewTemplate } from '../app/lib/comms/templates'
import { resolveSendMode, inQuietHours, idempotencyKey, MAX_ATTEMPTS } from '../app/lib/comms/policy'
import { dispatchComm, type CommDeps } from '../app/lib/comms/service'
import { listCommHistory, estimateUsage } from '../app/lib/comms/history'
import { enabledRules, isArmed, AUTOMATION_RULES } from '../app/lib/comms/automation'
import type { CommContext } from '../app/lib/comms/context'
import type { Message } from '../app/lib/messages'
import { can } from '../app/lib/rbac'

// A weekday afternoon (1pm Central) — outside quiet hours.
const DAYTIME = Date.UTC(2026, 6, 15, 18, 0, 0)
// 11pm Central — inside quiet hours.
const NIGHT = Date.UTC(2026, 6, 15, 4, 0, 0)

const fullCtx = (o: Partial<CommContext> = {}): CommContext => ({
  customerName: 'Jordan Sample', phone: '+15550001234', email: 'jordan@example.com',
  bookingId: 'tok123', bookingNumber: 'JK-B-1042', amountText: '$240.00', balanceText: '$120.00',
  bookingLink: 'https://x/booking/tok123', invoiceLink: 'https://x/receipt', reviewLink: 'https://x/review',
  crewName: 'Marcus', dateText: 'Tue, Jul 22', windowText: '8-10am', etaText: '20 min', ...o,
})

type Calls = {
  sms: { to: string | null | undefined; body: string }[]
  email: { to: string[]; subject: string }[]
  record: Parameters<CommDeps['record']>[0][]
  claimed: Set<string>
  audit: unknown[]
}

function makeDeps(over: Partial<CommDeps> = {}, now = DAYTIME): { deps: Partial<CommDeps>; calls: Calls } {
  const calls: Calls = { sms: [], email: [], record: [], claimed: new Set(), audit: [] }
  const deps: Partial<CommDeps> = {
    now: () => now,
    sendSms: async (to, body) => { calls.sms.push({ to, body }); return { ok: true, sid: 'SM1', status: 'queued' } },
    sendEmail: async (a) => { calls.email.push({ to: a.to, subject: a.subject }); return { ok: true, id: 'em1' } },
    isSmsOptedOut: async () => false,
    isEmailOptedOut: async () => false,
    claim: async (key) => { if (calls.claimed.has(key)) return false; calls.claimed.add(key); return true },
    record: async (m) => { calls.record.push(m); return { id: 'm' + calls.record.length } },
    audit: async (a) => { calls.audit.push(a); return a },
    ...over,
  }
  return { deps, calls }
}

// ── Event model ──────────────────────────────────────────────────────────────
test('event catalog covers all 17 sprint events', () => {
  const wanted = [
    'BOOKING_RECEIVED', 'QUOTE_SENT', 'QUOTE_REMINDER', 'BOOKING_CONFIRMED', 'APPOINTMENT_REMINDER',
    'CREW_DISPATCHED', 'ON_THE_WAY', 'ETA_UPDATED', 'ARRIVED', 'JOB_COMPLETED', 'INVOICE_SENT',
    'INVOICE_REMINDER', 'PAYMENT_RECEIVED', 'REVIEW_REQUEST', 'JOB_CANCELLED', 'JOB_RESCHEDULED', 'INTERNAL_DISPATCH',
  ]
  assert.equal(COMM_EVENTS.length, 17)
  for (const e of wanted) assert.ok(isCommEvent(e), `${e} is a known event`)
  // No event is marketing (compliance invariant).
  for (const e of COMM_EVENTS) assert.equal(e.marketing, false)
})

// ── Variable rendering + validation + preview ────────────────────────────────
test('renderTemplate fills variables and reports none missing when complete', () => {
  const r = renderTemplate('BOOKING_CONFIRMED', fullCtx())
  assert.ok(r.sms && r.sms.includes('JK-B-1042'))
  assert.ok(r.email && r.email.subject.includes('JK-B-1042'))
  assert.deepEqual(r.missing, [])
})

test('renderTemplate degrades to safe fallbacks and never prints "undefined"', () => {
  const r = renderTemplate('BOOKING_CONFIRMED', {})
  assert.ok(r.sms && !r.sms.includes('undefined'), 'no undefined in sms')
  assert.ok(r.email && !r.email.html.includes('undefined'), 'no undefined in email')
  assert.ok(r.missing.includes('bookingNumber'), 'missing vars reported')
})

test('previewTemplate renders fully from sample data with nothing missing', () => {
  const r = previewTemplate('QUOTE_SENT')
  assert.ok(r.sms && r.email)
  assert.deepEqual(r.missing, [])
})

test('sms-only events render no email', () => {
  const r = renderTemplate('ETA_UPDATED', fullCtx())
  assert.ok(r.sms)
  assert.equal(r.email, undefined)
  assert.deepEqual(r.channels, ['sms'])
})

// ── Send mode / no live sends in Preview ─────────────────────────────────────
test('resolveSendMode never returns live outside production', () => {
  const orig = { v: process.env.VERCEL_ENV, m: process.env.COMMS_SEND_MODE }
  try {
    process.env.VERCEL_ENV = 'preview'; process.env.COMMS_SEND_MODE = 'live'
    assert.equal(resolveSendMode(), 'off', 'preview + live env => off')
    process.env.COMMS_SEND_MODE = 'test'
    assert.equal(resolveSendMode(), 'test', 'preview + test env => test')
    process.env.VERCEL_ENV = 'production'; process.env.COMMS_SEND_MODE = 'live'
    assert.equal(resolveSendMode(), 'live', 'production + live => live')
    process.env.VERCEL_ENV = 'production'; delete process.env.COMMS_SEND_MODE
    assert.equal(resolveSendMode(), 'off', 'default is suppressed')
  } finally {
    if (orig.v === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = orig.v
    if (orig.m === undefined) delete process.env.COMMS_SEND_MODE; else process.env.COMMS_SEND_MODE = orig.m
  }
})

test('mode off suppresses everything: no send, no ledger, no idempotency burn', async () => {
  const { deps, calls } = makeDeps()
  const res = await dispatchComm('BOOKING_CONFIRMED', fullCtx(), { mode: 'off' }, deps)
  assert.equal(calls.sms.length, 0)
  assert.equal(calls.email.length, 0)
  assert.equal(calls.record.length, 0)
  assert.equal(calls.claimed.size, 0)
  assert.ok(res.outcomes.every(o => o.status === 'suppressed' && o.reason === 'send_mode_off'))
})

test('mode test simulates: logs a simulated ledger row but calls no provider', async () => {
  const { deps, calls } = makeDeps()
  const res = await dispatchComm('BOOKING_CONFIRMED', fullCtx(), { mode: 'test' }, deps)
  assert.equal(calls.sms.length, 0, 'no real SMS')
  assert.equal(calls.email.length, 0, 'no real email')
  assert.ok(calls.record.length >= 1, 'ledger recorded')
  assert.ok(calls.record.every(m => (m.tags ?? []).includes('simulated')))
  assert.ok(res.outcomes.every(o => o.status === 'simulated'))
  assert.ok(res.loggedMessageIds.length >= 1)
})

// ── Live send + link association + audit ─────────────────────────────────────
test('mode live sends both channels, records provider ids, audits, links booking', async () => {
  const { deps, calls } = makeDeps()
  const res = await dispatchComm('BOOKING_CONFIRMED', fullCtx(), { mode: 'live', actor: 'owner', actorRole: 'admin' }, deps)
  assert.equal(calls.sms.length, 1)
  assert.equal(calls.email.length, 1)
  const sms = res.outcomes.find(o => o.channel === 'sms')!
  assert.equal(sms.status, 'sent'); assert.equal(sms.providerId, 'SM1')
  const rec = calls.record[0]
  assert.equal(rec.bookingToken, 'tok123')
  assert.equal(rec.bookingNumber, 'JK-B-1042')
  assert.ok((rec.tags ?? []).includes('event:BOOKING_CONFIRMED'))
  assert.ok((rec.tags ?? []).includes('by:owner'))
  assert.equal(calls.audit.length, 1, 'live send is audited')
})

// ── Idempotency / duplicate prevention ───────────────────────────────────────
test('duplicate prevention: second identical dispatch is skipped', async () => {
  const { deps, calls } = makeDeps()
  await dispatchComm('APPOINTMENT_REMINDER', fullCtx(), { mode: 'live' }, deps)
  const smsAfterFirst = calls.sms.length
  const res2 = await dispatchComm('APPOINTMENT_REMINDER', fullCtx(), { mode: 'live' }, deps)
  assert.equal(res2.duplicate, true)
  assert.ok(res2.outcomes.every(o => o.status === 'skipped' && o.reason === 'duplicate'))
  assert.equal(calls.sms.length, smsAfterFirst, 'no additional send')
})

test('explicit idempotency key controls dedup', async () => {
  const { deps, calls } = makeDeps()
  await dispatchComm('JOB_COMPLETED', fullCtx(), { mode: 'live', idempotencyKey: 'k1' }, deps)
  const res2 = await dispatchComm('JOB_COMPLETED', fullCtx(), { mode: 'live', idempotencyKey: 'k1' }, deps)
  assert.equal(res2.duplicate, true)
  assert.equal(idempotencyKey('JOB_COMPLETED', fullCtx(), 'k1'), 'comm:idem:k1')
})

// ── Opt-out ──────────────────────────────────────────────────────────────────
test('sms opt-out suppresses SMS but email still goes', async () => {
  const { deps, calls } = makeDeps({ isSmsOptedOut: async () => true })
  const res = await dispatchComm('BOOKING_CONFIRMED', fullCtx(), { mode: 'live' }, deps)
  assert.equal(calls.sms.length, 0)
  assert.equal(res.outcomes.find(o => o.channel === 'sms')!.reason, 'sms_opted_out')
  assert.equal(res.outcomes.find(o => o.channel === 'email')!.status, 'sent')
})

test('email opt-out suppresses email', async () => {
  const { deps, calls } = makeDeps({ isEmailOptedOut: async () => true })
  const res = await dispatchComm('BOOKING_CONFIRMED', fullCtx(), { mode: 'live' }, deps)
  assert.equal(calls.email.length, 0)
  assert.equal(res.outcomes.find(o => o.channel === 'email')!.reason, 'email_opted_out')
})

// ── Invalid contacts ─────────────────────────────────────────────────────────
test('missing/invalid phone and missing email are skipped, not sent', async () => {
  const { deps, calls } = makeDeps()
  const res = await dispatchComm('BOOKING_CONFIRMED', fullCtx({ phone: 'abc', email: undefined }), { mode: 'live' }, deps)
  assert.equal(calls.sms.length, 0)
  assert.equal(calls.email.length, 0)
  assert.equal(res.outcomes.find(o => o.channel === 'sms')!.reason, 'no_phone')
  assert.equal(res.outcomes.find(o => o.channel === 'email')!.reason, 'no_email')
})

// ── Provider failure + retries ───────────────────────────────────────────────
test('4xx provider failure is not retried', async () => {
  let n = 0
  const { deps } = makeDeps({ sendSms: async () => { n++; return { ok: false, error: 'bad number', httpStatus: 400 } } })
  const res = await dispatchComm('ARRIVED', fullCtx(), { mode: 'live' }, deps)
  assert.equal(n, 1, 'no retry on 4xx')
  assert.equal(res.outcomes.find(o => o.channel === 'sms')!.status, 'failed')
})

test('5xx provider failure retries up to MAX_ATTEMPTS', async () => {
  let n = 0
  const { deps } = makeDeps({ sendSms: async () => { n++; return { ok: false, error: 'server', httpStatus: 500 } } })
  const res = await dispatchComm('ARRIVED', fullCtx(), { mode: 'live' }, deps)
  assert.equal(n, MAX_ATTEMPTS)
  assert.equal(res.outcomes.find(o => o.channel === 'sms')!.attempts, MAX_ATTEMPTS)
})

test('transient failure then success reports sent', async () => {
  let n = 0
  const { deps } = makeDeps({ sendSms: async () => { n++; return n < 2 ? { ok: false, error: 'x', httpStatus: 503 } : { ok: true, sid: 'SM9', status: 'sent' } } })
  const res = await dispatchComm('ARRIVED', fullCtx(), { mode: 'live' }, deps)
  const sms = res.outcomes.find(o => o.channel === 'sms')!
  assert.equal(sms.status, 'sent'); assert.equal(sms.attempts, 2)
})

// ── Quiet hours ──────────────────────────────────────────────────────────────
test('reminder held during quiet hours; bypass and non-reminders go through', async () => {
  assert.equal(inQuietHours(NIGHT), true)
  assert.equal(inQuietHours(DAYTIME), false)

  const a = makeDeps({}, NIGHT)
  const held = await dispatchComm('APPOINTMENT_REMINDER', fullCtx(), { mode: 'live', now: NIGHT }, a.deps)
  assert.equal(held.outcomes.find(o => o.channel === 'sms')!.reason, 'quiet_hours')

  const b = makeDeps({}, NIGHT)
  const bypass = await dispatchComm('APPOINTMENT_REMINDER', fullCtx(), { mode: 'live', now: NIGHT, allowQuietHours: true }, b.deps)
  assert.equal(bypass.outcomes.find(o => o.channel === 'sms')!.status, 'sent')

  const c = makeDeps({}, NIGHT)
  const hard = await dispatchComm('BOOKING_CONFIRMED', fullCtx(), { mode: 'live', now: NIGHT }, c.deps)
  assert.equal(hard.outcomes.find(o => o.channel === 'sms')!.status, 'sent', 'transactional ignores quiet hours')
})

// ── History filtering + usage (no sends) ─────────────────────────────────────
const msg = (o: Partial<Message>): Message => ({
  id: o.id ?? 'x', direction: o.direction ?? 'outbound', channel: o.channel ?? 'sms',
  provider: o.provider ?? 'twilio', body: o.body ?? 'hello', status: o.status ?? 'sent',
  unread: false, createdAt: o.createdAt ?? 1, tags: o.tags, ...o,
}) as Message

test('history filters to comms rows, channel, failed; usage estimates cost', async () => {
  const fake: Message[] = [
    msg({ id: 'a', channel: 'sms', status: 'sent', tags: ['comms', 'event:BOOKING_CONFIRMED'], body: 'x'.repeat(200) }),
    msg({ id: 'b', channel: 'email', status: 'failed', tags: ['comms', 'event:INVOICE_SENT'] }),
    msg({ id: 'c', channel: 'sms', status: 'queued', tags: ['comms', 'event:ON_THE_WAY', 'simulated'] }),
    msg({ id: 'd', channel: 'sms', direction: 'inbound', status: 'received', tags: [] }), // not comms
  ]
  const loader = async () => fake

  const all = await listCommHistory({ onlyComms: true }, loader)
  assert.equal(all.length, 3, 'excludes the non-comms inbound row')

  const smsOnly = await listCommHistory({ onlyComms: true, channel: 'sms' }, loader)
  assert.equal(smsOnly.length, 2)

  const failed = await listCommHistory({ onlyComms: true, onlyFailed: true }, loader)
  assert.equal(failed.length, 1); assert.equal(failed[0].id, 'b')

  const noSim = await listCommHistory({ onlyComms: true, includeSimulated: false }, loader)
  assert.ok(!noSim.some(r => r.simulated))

  const usage = estimateUsage(all)
  assert.equal(usage.smsCount, 1, 'simulated sms excluded from cost')
  assert.equal(usage.smsSegments, 2, '200 chars => 2 segments')
  assert.ok(usage.estimatedUsd > 0)
  assert.equal(usage.failed, 1)
  assert.equal(usage.simulated, 1)
})

// ── Automation stays disabled ────────────────────────────────────────────────
test('all automation rules ship disabled and test-mode (nothing armed)', () => {
  assert.deepEqual(enabledRules(), [])
  for (const r of AUTOMATION_RULES) {
    assert.equal(r.enabled, false)
    assert.equal(r.mode, 'test')
    assert.equal(isArmed(r), false)
  }
})

// ── Authorization matrix ─────────────────────────────────────────────────────
test('rbac gates the console + test-send permissions', () => {
  assert.equal(can('admin', 'comms:analytics'), true)
  assert.equal(can('manager', 'comms:analytics'), true)
  assert.equal(can('admin', 'messages:send'), true)
  assert.equal(can('crew', 'comms:analytics'), false)
  assert.equal(can('crew', 'messages:send'), false)
})

// ── getEventDef guard ────────────────────────────────────────────────────────
test('getEventDef throws on unknown event', () => {
  assert.throws(() => getEventDef('NOPE' as never))
})
