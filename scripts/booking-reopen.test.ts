// Closure reversal. The transition matrix keeps terminal statuses closed so no ordinary
// status edit can reopen a finished job — this is the deliberate, audited way back from a
// mis-clicked `Mark complete` or `Cancel`, and it must not become a second way to bypass
// the matrix for anything else.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOKING_TRANSITIONS, REOPEN_TARGETS, canReopen, canTransition,
  closureFieldsToClear, isTerminalBookingStatus, TERMINAL_BOOKING_STATUSES,
} from '../app/lib/booking-status'
import { BOOKING_STATUS_LABEL, type BookingStatus } from '../app/lib/bookings'

const ALL = Object.keys(BOOKING_STATUS_LABEL) as BookingStatus[]

test('every closed status can be reopened — including refunded', () => {
  for (const from of TERMINAL_BOOKING_STATUSES) {
    assert.equal(canReopen(from, 'confirmed').ok, true, `${from} must be recoverable`)
  }
  console.log(`  recoverable from all ${TERMINAL_BOOKING_STATUSES.length} closed statuses ✅`)
})

test('reopen refuses a booking that is not closed', () => {
  for (const from of ALL.filter((s) => !isTerminalBookingStatus(s))) {
    const r = canReopen(from, 'confirmed')
    assert.equal(r.ok, false, `${from} is live — reopen must not apply`)
    assert.equal(r.ok === false && r.code, 'NOT_CLOSED')
  }
  console.log('  live bookings rejected — ordinary status edits stay the path ✅')
})

test('reopen targets are restricted to plausible active states', () => {
  assert.deepEqual([...REOPEN_TARGETS].sort(),
    ['booking_created', 'confirmed', 'continued', 'in_progress', 'time_verified'].sort())
  const refused = ALL.filter((to) => !REOPEN_TARGETS.includes(to))
  for (const to of refused) {
    const r = canReopen('completed', to)
    assert.equal(r.ok, false, `completed → ${to} must not be a reopen target`)
    assert.equal(r.ok === false && r.code, 'INVALID_REOPEN_TARGET')
  }
  console.log(`  ${REOPEN_TARGETS.length} valid targets · ${refused.length} refused`)
})

test('reopen cannot be used to move between closure outcomes', () => {
  // That is the matrix's job (completed → refunded etc). Reopen must not duplicate it,
  // or it becomes a second, less-audited path to the same edits.
  for (const to of TERMINAL_BOOKING_STATUSES) {
    assert.equal(canReopen('completed', to).ok, false, `completed → ${to} via reopen`)
  }
  assert.equal(canTransition('completed', 'refunded').ok, true, 'the matrix still owns this move')
})

test('the transition matrix still refuses these moves — reopen is the ONLY way back', () => {
  for (const from of TERMINAL_BOOKING_STATUSES) for (const to of REOPEN_TARGETS) {
    assert.equal(canTransition(from, to).ok, false,
      `${from} → ${to} must stay refused for ordinary edits`)
    assert.equal(canReopen(from, to).ok, true, `${from} → ${to} must be reachable via reopen`)
  }
  console.log('  matrix refuses / reopen permits — the two boundaries stay distinct ✅')
})

test('an unknown status is refused rather than reopened', () => {
  const r = canReopen('legacy_status' as BookingStatus, 'confirmed')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.code, 'UNKNOWN_STATUS')
})

test('closure stamps are shed so a reopened record never claims both states', () => {
  assert.deepEqual(closureFieldsToClear('completed'), ['completedAt'])
  assert.deepEqual(closureFieldsToClear('partially_completed'), ['completedAt'])
  assert.deepEqual(closureFieldsToClear('could_not_complete'), ['completedAt', 'cancelledAt'])
  assert.deepEqual(closureFieldsToClear('cancelled'), ['cancelledAt'])
  assert.deepEqual(closureFieldsToClear('refunded'), ['cancelledAt'])
  // Every closed status must clear at least one stamp.
  for (const s of TERMINAL_BOOKING_STATUSES) assert.ok(closureFieldsToClear(s).length > 0, s)
})

test('reopen does not widen the matrix as a side effect', () => {
  let allowed = 0
  for (const f of ALL) for (const t of ALL) if (f !== t && canTransition(f, t).ok) allowed++
  assert.equal(allowed, 129, 'the matrix must be untouched by the reopen work')
  assert.deepEqual(BOOKING_TRANSITIONS.refunded, [], 'refunded stays absorbing for ordinary edits')
})

test('the mis-click scenarios that motivated this are all recoverable', () => {
  // Accidental "Mark complete" on a job still in progress.
  assert.equal(canReopen('completed', 'in_progress').ok, true)
  // Accidental "Cancel" on a confirmed job.
  assert.equal(canReopen('cancelled', 'confirmed').ok, true)
  // Cancelled, then the customer rescheduled.
  assert.equal(canReopen('cancelled', 'time_verified').ok, true)
  // A refund issued against the wrong booking.
  assert.equal(canReopen('refunded', 'confirmed').ok, true)
  console.log('  mis-clicked complete / cancel / refund all recoverable ✅')
})
