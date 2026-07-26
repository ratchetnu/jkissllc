// The reopen action is only useful if the owner can reach it. These assertions pin the
// control's existence and, more importantly, that it sources its target list from the
// server policy rather than a hand-copied list that could drift.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync('app/admin/bookings/page.tsx', 'utf8')
const policy = readFileSync('app/lib/booking-status.ts', 'utf8')

test('a reopen control exists and invokes the reopen action', () => {
  assert.match(page, /run\('reopen',/)
  assert.match(page, /Reopen booking/)
  assert.match(page, /busy === 'reopen'/)
})

test('the control renders ONLY for a closed booking', () => {
  assert.match(page, /CLOSED_STATUSES\.includes\(b\.status\) && \(/)
})

test('the target list comes from the server policy, not a copied literal', () => {
  assert.match(page, /import \{ REOPEN_TARGETS \} from '\.\.\/\.\.\/lib\/booking-status'/)
  assert.match(page, /REOPEN_TARGETS\.map\(/)
  assert.match(policy, /export const REOPEN_TARGETS/)
  // A hand-written list of the five statuses in the page would be the drift risk.
  assert.doesNotMatch(page, /\['confirmed', 'in_progress', 'continued', 'time_verified', 'booking_created'\]/)
})

test('the owner must choose a target — the control never guesses', () => {
  assert.match(page, /if \(!reopenTo\) \{ setErr\('Choose the status to reopen into\.'\); return \}/)
  assert.match(page, /<option value="">Reopen as…<\/option>/)
})

test('reopening asks for confirmation and records an optional reason', () => {
  assert.match(page, /Reopen this booking as \$\{BOOKING_STATUS_LABEL\[/)
  assert.match(page, /reason: reopenWhy\.trim\(\) \|\| undefined/)
})

test('the control is labelled for assistive technology', () => {
  assert.match(page, /aria-label="Reopen into which status"/)
  assert.match(page, /aria-label="Reason for reopening \(optional\)"/)
})
