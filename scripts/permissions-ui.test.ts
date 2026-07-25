// Permissions experience — pure view helpers + static read-only/containment
// guarantees for the redesigned page. Presentation only: these assert how the matrix
// is DISPLAYED, never what it grants. Authorization coverage lives in
// audit-permissions.test.ts and rbac.test.ts and is untouched by this file.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  PERMISSION_LABELS, permissionLabel, filterDomains, countPermissions,
  resultCountLabel, roleSummaries, roleScopeLabel, VIEW_MODES,
  type MatrixData,
} from '../app/admin/operations/permissions/permissions-view'
import { ALL_PERMISSIONS, PERMISSION_DOMAINS, ROLES, can } from '../app/lib/rbac'

const PAGE = 'app/admin/operations/permissions/page.tsx'

// A small fixture shaped exactly like the /api/admin/permissions projection.
const DATA: MatrixData = {
  roles: [{ id: 'admin', label: 'Admin' }, { id: 'manager', label: 'Manager' }, { id: 'crew', label: 'Crew' }],
  domains: [
    { domain: 'Money', permissions: [
      { id: 'invoices:manage', grantedBy: ['admin'] },
      { id: 'profitability:view', grantedBy: ['admin', 'manager'] },
    ] },
    { domain: 'Crew self-service', permissions: [
      { id: 'self:timeclock', grantedBy: ['crew'] },
    ] },
  ],
  readOnly: true,
}

// ── Plain language ───────────────────────────────────────────────────────────

test('every real permission has a plain-language name — no raw id leads the primary UI', () => {
  const missing = ALL_PERMISSIONS.filter(p => !PERMISSION_LABELS[p])
  assert.deepEqual(missing, [], `permissions missing a plain-language label: ${missing.join(', ')}`)
})

test('permissionLabel: known ids read as English; unknown ids degrade safely', () => {
  assert.equal(permissionLabel('routes:manage'), 'Manage routes')
  assert.equal(permissionLabel('pay:view:all'), "View everyone's pay")
  // An id added to rbac.ts before this map is updated still renders as a phrase…
  assert.equal(permissionLabel('widgets:manage'), 'Manage widgets')
  // …and one with no recognizable verb falls back to the id rather than inventing words.
  assert.equal(permissionLabel('some:opaque:thing'), 'some:opaque:thing')
})

// ── Filtering ────────────────────────────────────────────────────────────────

test('search matches the plain-language name AND the raw id', () => {
  // Nobody types "invoices:manage" — they type "invoice".
  assert.equal(countPermissions(filterDomains(DATA.domains, { q: 'invoice' })), 1)
  assert.equal(countPermissions(filterDomains(DATA.domains, { q: 'Manage invoices' })), 1)
  assert.equal(countPermissions(filterDomains(DATA.domains, { q: 'invoices:manage' })), 1)
  assert.equal(countPermissions(filterDomains(DATA.domains, { q: 'zzz' })), 0)
})

test('area and role filters narrow correctly, and empty areas are dropped', () => {
  const money = filterDomains(DATA.domains, { domain: 'Money' })
  assert.deepEqual(money.map(d => d.domain), ['Money'])
  const crew = filterDomains(DATA.domains, { role: 'crew' })
  // Money has no crew grant at all, so its header must not appear alone.
  assert.deepEqual(crew.map(d => d.domain), ['Crew self-service'])
  const none = filterDomains(DATA.domains, { domain: 'Money', role: 'crew' })
  assert.deepEqual(none, [])
})

test('filtering NEVER alters grants — the viewer only hides rows', () => {
  for (const d of filterDomains(DATA.domains, { q: 'a' })) {
    for (const p of d.permissions) {
      const original = DATA.domains.flatMap(x => x.permissions).find(x => x.id === p.id)!
      assert.deepEqual(p.grantedBy, original.grantedBy)
    }
  }
})

// ── Counts and summaries ─────────────────────────────────────────────────────

test('result count is singular/plural correct', () => {
  assert.equal(resultCountLabel(1), '1 permission')
  assert.equal(resultCountLabel(0), '0 permissions')
  assert.equal(resultCountLabel(54), '54 permissions')
})

test('role summaries are DERIVED from the projection, not hand-written claims', () => {
  const s = roleSummaries(DATA)
  const admin = s.find(x => x.id === 'admin')!
  assert.equal(admin.granted, 2)
  assert.equal(admin.total, 3)
  assert.equal(admin.areas, 1)
  const crew = s.find(x => x.id === 'crew')!
  assert.equal(crew.granted, 1)
  // The granted count is the card headline, so the scope line stays short enough for
  // three cards to sit side by side on a phone.
  assert.equal(roleScopeLabel(crew), 'of 3 · 1 area')
  assert.equal(roleScopeLabel(admin), 'of 3 · 1 area')
})

test('summaries agree with can() for the real matrix (viewer cannot over- or under-state a role)', () => {
  const real: MatrixData = {
    roles: ROLES.map(r => ({ id: r, label: r })),
    domains: PERMISSION_DOMAINS.map(d => ({
      domain: d.domain,
      permissions: d.permissions.map(p => ({ id: p, grantedBy: ROLES.filter(r => can(r, p)) })),
    })),
    readOnly: true,
  }
  for (const s of roleSummaries(real)) {
    const expected = ALL_PERMISSIONS.filter(p => can(s.id as (typeof ROLES)[number], p)).length
    assert.equal(s.granted, expected, `${s.id} summary disagrees with can()`)
    assert.equal(s.total, ALL_PERMISSIONS.length)
  }
})

// ── Structure guarantees ─────────────────────────────────────────────────────

test('three views are offered, with "By permission" first (the matrix is secondary)', () => {
  assert.deepEqual(VIEW_MODES.map(v => v.id), ['permission', 'role', 'matrix'])
  assert.equal(VIEW_MODES[0].label, 'By permission')
})

test('the page is READ-ONLY: it issues no mutating request and offers no edit control', () => {
  const src = readFileSync(PAGE, 'utf8')
  assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(src), 'permissions page must not mutate')
  assert.match(src, /credentials: 'same-origin'/)
  // The only fetch is the read projection.
  assert.deepEqual(src.match(/fetch\(/g)?.length, 1)
})

test('matrix scrolling is contained in its own box, with the permission column pinned', () => {
  const src = readFileSync(PAGE, 'utf8')
  // A bounded, scrollable container — so the PAGE never scrolls sideways on mobile.
  assert.match(src, /overflow: 'auto', maxHeight/)
  assert.match(src, /position: 'sticky', left: 0/)   // first column pinned
  assert.match(src, /position: 'sticky', top: 0/)    // header row pinned
})
