// Crew portal authorization matrix — who may reach what. Consolidates the guards
// the new crew surfaces depend on: the RBAC matrix (admin/manager/crew), the
// staff-vs-crew split, and the per-record ownership gate for documents. Pure.
import assert from 'node:assert/strict'
import test from 'node:test'
import { can, isStaffRole, type Permission } from '../app/lib/rbac'
import { canAccess } from '../app/lib/crew-documents'

test('a crew principal is never a staff (operations) principal', () => {
  assert.equal(isStaffRole('crew'), false, 'crew must never reach /admin — proxy.ts relies on this')
  assert.equal(isStaffRole('manager'), true)
  assert.equal(isStaffRole('admin'), true)
})

test('crew hold only self-scoped permissions', () => {
  const selfPerms: Permission[] = [
    'self:view', 'self:availability', 'self:timeoff', 'self:timeclock',
    'self:pay:request', 'self:messages', 'self:reminders', 'self:uniform',
  ]
  for (const p of selfPerms) assert.equal(can('crew', p), true, `crew should hold ${p}`)
})

test('crew cannot reach any management permission', () => {
  const denied: Permission[] = [
    'crew:manage', 'crew:view', 'pay:view:all', 'pay:generate', 'pay:approve',
    'timeoff:approve', 'users:manage', 'tax:view', 'routes:manage',
  ]
  for (const p of denied) assert.equal(can('crew', p), false, `crew must NOT hold ${p}`)
})

test('crew-document + uniform management follows current policy (admin manages, manager views)', () => {
  // Write side (publish/assign crew docs, approve/reject uniform) is crew:manage.
  assert.equal(can('admin', 'crew:manage'), true)
  assert.equal(can('manager', 'crew:manage'), false, 'manager cannot manage crew records under current policy')
  // Read side (list crew docs / uniform photos for review) is crew:view.
  assert.equal(can('admin', 'crew:view'), true)
  assert.equal(can('manager', 'crew:view'), true)
  assert.equal(can('crew', 'crew:view'), false)
})

test('document ownership: a crew member reads library + only their own files', () => {
  // Library — anyone on the crew.
  assert.equal(canAccess({ scope: 'library' }, 's1'), true)
  assert.equal(canAccess({ scope: 'library' }, 's2'), true)
  // Personal — the owner, and no one else.
  assert.equal(canAccess({ scope: 'staff', staffId: 's1' }, 's1'), true)
  assert.equal(canAccess({ scope: 'staff', staffId: 's1' }, 's2'), false)
})
