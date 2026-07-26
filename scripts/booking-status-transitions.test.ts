// Sprint 1 closeout — the booking status transition matrix.
// The matrix is a description of workflows that already existed, so the load-bearing
// tests here are the compatibility ones: every move the audited call sites could
// legitimately make must still be legal, and recompute()'s fact-derived decisions must
// never be silently dropped.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOKING_TRANSITIONS, TERMINAL_BOOKING_STATUSES, canTransition,
  isTerminalBookingStatus, nextStatusOrKeep, statusAfterConfirmationLinkSent,
  statusAfterCustomerView,
} from '../app/lib/booking-status'
import {
  BOOKING_STATUS_LABEL, CLOSED_STATUSES, recompute,
  type Booking, type BookingStatus, type Payment,
} from '../app/lib/bookings'

const ALL = Object.keys(BOOKING_STATUS_LABEL) as BookingStatus[]

const mkBooking = (o: Partial<Booking> = {}): Booking => ({
  token: 'a'.repeat(64), bookingNumber: 'JK-B-1001', customerName: 'Jane Doe',
  serviceType: 'moving', items: [], invoiceAmountCents: 0, depositAmountCents: 5000,
  amountPaidCents: 0, availableDates: ['2026-08-01'], availableWindows: ['8am–10am'],
  status: 'booking_created', payments: [], createdAt: 1, updatedAt: 1, ...o,
})
const paid = (o: Partial<Payment> = {}): Payment => ({
  id: 'p1', type: 'deposit', method: 'stripe', status: 'confirmed',
  amountCents: 5000, feeCents: 0, totalChargedCents: 5000, netCents: 5000,
  createdAt: 2, confirmedAt: 2, ...o,
})
const zelleProof = (o: Partial<Payment> = {}): Payment => ({
  ...paid({ method: 'zelle', status: 'sent_by_customer', proofPath: 'x.enc', proofUploadedAt: 2 }), ...o,
})
const timeVerified = { customerTimeVerifiedAt: 3, selectedDate: '2026-08-01', selectedWindow: '8am–10am' }

// ── Structural integrity ─────────────────────────────────────────────────────

test('the matrix covers every BookingStatus and references only real statuses', () => {
  assert.deepEqual(Object.keys(BOOKING_TRANSITIONS).sort(), [...ALL].sort())
  for (const [from, targets] of Object.entries(BOOKING_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(ALL.includes(to), `${from} → ${to} is not a real status`)
      assert.notEqual(to, from, `${from} lists itself; same-status is handled separately`)
    }
    assert.equal(new Set(targets).size, targets.length, `${from} has duplicate targets`)
  }
})

test('the terminal list stays in lockstep with CLOSED_STATUSES in bookings.ts', () => {
  assert.deepEqual([...TERMINAL_BOOKING_STATUSES].sort(), [...CLOSED_STATUSES].sort())
})

// ── Exhaustive: all 17 × 17 pairs ────────────────────────────────────────────

test('every one of the 289 status pairs is decided by the matrix', () => {
  let allowed = 0, refused = 0, same = 0
  for (const from of ALL) for (const to of ALL) {
    const r = canTransition(from, to)
    if (from === to) { assert.equal(r.ok, true); assert.equal(r.ok && r.sameStatus, true); same++; continue }
    const expected = BOOKING_TRANSITIONS[from].includes(to)
    assert.equal(r.ok, expected, `${from} → ${to} expected ok=${expected}`)
    if (r.ok) { assert.equal(r.sameStatus, false); allowed++ }
    else { assert.ok(r.reason.length > 0); refused++ }
  }
  assert.equal(same, ALL.length)
  assert.equal(allowed + refused + same, ALL.length ** 2)
  console.log(`  ${ALL.length}×${ALL.length}: ${allowed} allowed · ${refused} refused · ${same} idempotent`)
})

test('same-status is always an idempotent no-op, including from terminal states', () => {
  for (const s of ALL) {
    const r = canTransition(s, s)
    assert.equal(r.ok, true, `${s} → ${s} must be allowed`)
    assert.equal(r.ok && r.sameStatus, true)
    assert.equal(nextStatusOrKeep(s, s), s)
  }
})

// ── Terminal behaviour ───────────────────────────────────────────────────────

test('no terminal status can return to the active funnel', () => {
  const active = ALL.filter((s) => !isTerminalBookingStatus(s))
  for (const from of TERMINAL_BOOKING_STATUSES) for (const to of active) {
    const r = canTransition(from, to)
    assert.equal(r.ok, false, `${from} → ${to} must be refused`)
    assert.equal(r.ok === false && r.code, 'TERMINAL_STATUS')
  }
  console.log(`  ${TERMINAL_BOOKING_STATUSES.length} terminal × ${active.length} active → all refused`)
})

test('closure outcomes may still be revised between themselves', () => {
  for (const [from, to] of [
    ['completed', 'refunded'], ['completed', 'partially_completed'], ['completed', 'could_not_complete'],
    ['partially_completed', 'completed'], ['could_not_complete', 'completed'],
    ['could_not_complete', 'cancelled'], ['cancelled', 'refunded'],
  ] as [BookingStatus, BookingStatus][]) {
    assert.equal(canTransition(from, to).ok, true, `${from} → ${to} should remain possible`)
  }
})

test('refunded is absorbing — nothing follows money returned', () => {
  assert.deepEqual(BOOKING_TRANSITIONS.refunded, [])
  for (const to of ALL.filter((s) => s !== 'refunded')) {
    assert.equal(canTransition('refunded', to).ok, false, `refunded → ${to} must be refused`)
  }
})

test('a closed booking cannot be reopened, cancelled twice into life, or restarted', () => {
  for (const [from, to] of [
    ['completed', 'in_progress'], ['cancelled', 'confirmed'], ['refunded', 'in_progress'],
    ['cancelled', 'in_progress'], ['completed', 'quote_received'], ['refunded', 'completed'],
  ] as [BookingStatus, BookingStatus][]) {
    const r = canTransition(from, to)
    assert.equal(r.ok, false, `${from} → ${to}`)
    assert.match(r.ok === false ? r.reason : '', /closed booking/)
  }
})

// ── Unknown / legacy records ─────────────────────────────────────────────────

test('a legacy or unrecognised status is refused, never coerced', () => {
  const bogus = 'legacy_imported_status' as BookingStatus
  const from = canTransition(bogus, 'confirmed')
  assert.equal(from.ok, false)
  assert.equal(from.ok === false && from.code, 'UNKNOWN_STATUS')
  const to = canTransition('confirmed', bogus)
  assert.equal(to.ok, false)
  assert.equal(to.ok === false && to.code, 'UNKNOWN_STATUS')
  // The automatic helper keeps the record exactly as it is rather than rewriting it.
  assert.equal(nextStatusOrKeep(bogus, 'confirmed'), bogus)
})

test('legacy booking reads still recompute without throwing or being rewritten', () => {
  const legacy = mkBooking({ status: 'legacy_imported_status' as BookingStatus, payments: [paid()], ...timeVerified })
  const out = recompute(legacy)
  assert.equal(out.status, 'legacy_imported_status', 'an unknown status is preserved as-is')
  assert.equal(out.amountPaidCents, 5000, 'money is still recomputed for legacy records')
})

// ── recompute() compatibility — the highest-risk regression surface ──────────

test('recompute still auto-confirms from every stage it previously could', () => {
  const sources = ALL.filter((s) => !CLOSED_STATUSES.includes(s) && s !== 'in_progress' && s !== 'continued')
  const confirmedFrom: BookingStatus[] = []
  for (const status of sources) {
    const b = recompute(mkBooking({ status, payments: [paid()], ...timeVerified }))
    if (b.status === 'confirmed') confirmedFrom.push(status)
  }
  console.log(`  auto-confirms from ${confirmedFrom.length}/${sources.length} funnel stages`)
  assert.deepEqual(confirmedFrom.sort(), sources.sort(), 'every funnel stage must still reach confirmed')
})

test('recompute still reaches pending_zelle_verification, time_verified and payment_received', () => {
  const zelle = recompute(mkBooking({ status: 'booking_created', payments: [zelleProof()] }))
  assert.equal(zelle.status, 'pending_zelle_verification')

  const timed = recompute(mkBooking({ status: 'booking_created', ...timeVerified }))
  assert.equal(timed.status, 'time_verified')

  const money = recompute(mkBooking({ status: 'quote_received', payments: [paid()] }))
  assert.equal(money.status, 'payment_received')
})

test('recompute never overrides closed, in_progress or continued records', () => {
  for (const status of [...CLOSED_STATUSES, 'in_progress', 'continued'] as BookingStatus[]) {
    const b = recompute(mkBooking({ status, payments: [paid()], ...timeVerified }))
    assert.equal(b.status, status, `${status} must be preserved`)
  }
})

test('a confirmed booking whose payments vanish falls back rather than sticking', () => {
  // Payments voided, unverified Zelle proof left on file.
  const b = recompute(mkBooking({
    status: 'confirmed',
    payments: [zelleProof(), paid({ id: 'p2', status: 'failed', amountCents: 0, netCents: 0 })],
  }))
  assert.equal(b.status, 'pending_zelle_verification', 'the record must stop claiming it is paid')
})

// ── Call-site behaviour preserved ────────────────────────────────────────────

test('send-link reaches confirmation_link_sent from every stage the old whitelist covered', () => {
  const allowed = new Set<BookingStatus>([
    'quote_received', 'pending_payment', 'payment_received', 'booking_created',
  ])
  for (const from of ALL) {
    assert.equal(
      statusAfterConfirmationLinkSent(from),
      allowed.has(from) ? 'confirmation_link_sent' : from,
      from,
    )
  }
})

test('customer_viewed still advances from the stages the old two-status check covered', () => {
  const allowed = new Set<BookingStatus>(['confirmation_link_sent', 'booking_created'])
  for (const from of ALL) {
    assert.equal(
      statusAfterCustomerView(from),
      allowed.has(from) ? 'customer_viewed' : from,
      from,
    )
  }
})

test('a booking can always be cancelled while it is still live, never after refund', () => {
  for (const from of ALL.filter((s) => !isTerminalBookingStatus(s))) {
    assert.equal(canTransition(from, 'cancelled').ok, true, `${from} → cancelled`)
  }
  assert.equal(canTransition('refunded', 'cancelled').ok, false)
})

test('the mid-job lifecycle actions remain reachable in their real order', () => {
  assert.equal(canTransition('confirmed', 'in_progress').ok, true)
  assert.equal(canTransition('in_progress', 'continued').ok, true)
  assert.equal(canTransition('continued', 'in_progress').ok, true)
  assert.equal(canTransition('in_progress', 'completed').ok, true)
  assert.equal(canTransition('continued', 'completed').ok, true)
  // A job cannot start before it is locked in.
  assert.equal(canTransition('quote_received', 'in_progress').ok, false)
  assert.equal(canTransition('time_verified', 'in_progress').ok, false)
})

test('the full assignment → accept → clock → photo → complete path is legal end to end', () => {
  // Assignment, acceptance, clock in/out and completion photos all operate on the
  // assignment record and never move booking.status — the booking only travels
  // confirmed → in_progress → completed across that whole workflow.
  const journey: BookingStatus[] = [
    'quote_received', 'payment_received', 'confirmation_link_sent', 'customer_viewed',
    'time_verified', 'confirmed', 'in_progress', 'completed',
  ]
  for (let i = 0; i < journey.length - 1; i++) {
    const r = canTransition(journey[i], journey[i + 1])
    assert.equal(r.ok, true, `${journey[i]} → ${journey[i + 1]} must be legal`)
  }
  // And the multi-day variant that returns for a second trip.
  const multiDay: BookingStatus[] = ['confirmed', 'in_progress', 'continued', 'in_progress', 'partially_completed']
  for (let i = 0; i < multiDay.length - 1; i++) {
    assert.equal(canTransition(multiDay[i], multiDay[i + 1]).ok, true, `${multiDay[i]} → ${multiDay[i + 1]}`)
  }
  console.log('  standard journey + multi-day continuation both legal end to end')
})
