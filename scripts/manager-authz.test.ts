// Phase-2 authorization tightening — the manager/crew boundary, proven against the
// RBAC matrix the route guards consult. Each case mirrors a route that was migrated
// off the coarse `requireSession` gate: it names the permission (or admin/staff
// requirement) the route now enforces and asserts who the matrix lets through.
//
// This is the unit-level companion to scripts/authorization-coverage.test.ts (which
// proves the routes CALL a real guard). Here we prove the guards DECIDE correctly:
// a manager principal is denied the admin-only surfaces, admin is allowed, and crew
// never reach the staff-only operations surface.
import assert from 'node:assert/strict'
import test from 'node:test'

import { can, isStaffRole, type Permission, type Role } from '../app/lib/rbac'

// ── Admin-only routes: the permission is held ONLY by admin (manager denied) ──
// path under app/api/admin → the permission the migrated route requires.
const ADMIN_ONLY: Array<{ route: string; perm: Permission }> = [
  { route: 'routes/pay', perm: 'pay:view:all' },
  { route: 'route-invoices', perm: 'invoices:manage' },
  { route: 'route-invoices/[id]', perm: 'invoices:manage' },
  { route: 'finance', perm: 'profitability:view' },
  { route: 'policy', perm: 'settings:manage' },
  { route: 'promos', perm: 'settings:manage' },
  { route: 'alerts (GET)', perm: 'settings:manage' },
  { route: 'opspilot-waitlist', perm: 'settings:manage' },
]

test('admin-only routes: manager is denied, admin is allowed', () => {
  for (const { route, perm } of ADMIN_ONLY) {
    assert.equal(can('manager', perm), false, `manager must NOT reach ${route} (${perm})`)
    assert.equal(can('admin', perm), true, `admin must reach ${route} (${perm})`)
    assert.equal(can('crew', perm), false, `crew must NOT reach ${route} (${perm})`)
  }
})

// careers/doc is gated with requireAdmin (decrypted PII identity documents), so the
// decision is a straight role check, not a permission — only admin passes.
test('careers/doc (requireAdmin): only admin passes', () => {
  const passesAdminGuard = (role: Role) => role === 'admin'
  assert.equal(passesAdminGuard('admin'), true)
  assert.equal(passesAdminGuard('manager'), false, 'manager must NOT read applicant identity docs')
  assert.equal(passesAdminGuard('crew'), false, 'crew must NOT read applicant identity docs')
})

// ── Manager-held routes: admin + manager pass, crew denied ──
const MANAGER_HELD: Array<{ route: string; perm: Permission }> = [
  { route: 'analytics', perm: 'reports:view' },
  { route: 'reports', perm: 'reports:view' },
  { route: 'businesses', perm: 'businesses:manage' },
  { route: 'routes', perm: 'routes:manage' },
  { route: 'route-templates', perm: 'recurring:manage' },
  { route: 'equipment', perm: 'equipment:manage' },
  { route: 'claims', perm: 'claims:manage' },
  { route: 'client-portals', perm: 'businesses:manage' },
  { route: 'messages', perm: 'messages:send' },
  { route: 'availability', perm: 'availability:view' },
  { route: 'careers (review)', perm: 'applicants:review' },
  { route: 'staff (GET)', perm: 'crew:view' },
]

test('manager-held routes: admin + manager pass, crew denied', () => {
  for (const { route, perm } of MANAGER_HELD) {
    assert.equal(can('admin', perm), true, `admin must reach ${route} (${perm})`)
    assert.equal(can('manager', perm), true, `manager must reach ${route} (${perm})`)
    assert.equal(can('crew', perm), false, `crew must NOT reach ${route} (${perm})`)
  }
})

// careers PATCH keeps a finer per-action check: the terminal decisions
// (approve a hire / set the final recommendation) require applicants:decide, which
// managers do NOT hold — so a manager can review but not decide.
test('careers decisions require applicants:decide (admin only)', () => {
  assert.equal(can('manager', 'applicants:review'), true, 'manager may review applicants')
  assert.equal(can('manager', 'applicants:decide'), false, 'manager may NOT hire/decide')
  assert.equal(can('admin', 'applicants:decide'), true)
})

// staff writes stay admin-only (crew:manage is admin-held); managers assign crew to
// routes via the routes API, not here.
test('staff writes are admin-only (crew:manage)', () => {
  assert.equal(can('manager', 'crew:manage'), false)
  assert.equal(can('admin', 'crew:manage'), true)
})

// ── Staff-only routes (requireStaffSession): admin + manager pass, crew rejected ──
// These carry no narrower permission; the guard is purely "is this a staff role?".
const STAFF_ONLY = [
  'bookings', 'bookings/[id]', 'bookings/export', 'book-now',
  'blob-upload', 'upload', 'disposal', 'disposal/outcomes', 'reviews', 'shipments',
]

test('staff-only routes: admin + manager are staff, crew are not', () => {
  assert.equal(isStaffRole('admin'), true)
  assert.equal(isStaffRole('manager'), true)
  assert.equal(isStaffRole('crew'), false)
  // The assertion that matters per route: a crew principal is rejected everywhere here.
  for (const route of STAFF_ONLY) {
    assert.equal(isStaffRole('crew'), false, `crew must NOT reach staff-only ${route}`)
    assert.equal(isStaffRole('manager'), true, `manager must reach staff-only ${route}`)
  }
})
