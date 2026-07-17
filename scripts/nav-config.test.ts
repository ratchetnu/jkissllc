// Operion operations navigation model — pure tests (role-aware, ≤5 mobile items).
import assert from 'node:assert/strict'
import test from 'node:test'
import { NAV_ITEMS, visibleNav, primaryNav, moreGroups, MAX_PRIMARY } from '../app/admin/operations/nav-config'

test('visibleNav: managers lose adminOnly; Platform is owner-only', () => {
  const owner = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true })
  assert.ok(owner.some(n => n.href === '/admin/operations/settings'))
  assert.ok(owner.some(n => n.href === '/admin/operations/platform'))
  const manager = visibleNav(NAV_ITEMS, { role: 'manager', isOwner: false })
  assert.ok(!manager.some(n => n.href === '/admin/operations/settings'), 'manager: no Settings')
  assert.ok(!manager.some(n => n.href === '/admin/operations/platform'), 'manager: no Platform')
  const adminNonOwner = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: false })
  assert.ok(!adminNonOwner.some(n => n.href === '/admin/operations/platform'), 'non-owner: no Platform')
})

test('mobile shows at most 5 items (4 primary + More)', () => {
  const vis = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true })
  const primary = primaryNav(vis)
  assert.ok(primary.length <= MAX_PRIMARY - 1, 'at most 4 primary destinations')
  assert.ok(primary.length + 1 <= 5, 'primary + More ≤ 5')
  // The four flagged-primary destinations are the mobile bar. Schedule is elevated
  // into the bar as the primary operational surface; Messages moves to the More sheet
  // (Communication group) but stays fully reachable (asserted below).
  assert.deepEqual(primary.map(p => p.href), ['/admin/operations', '/admin/operations/schedule', '/admin/operations/book-now', '/admin/operations/list'])
})

test('Messages stays reachable in the More sheet after Schedule is elevated', () => {
  const vis = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true })
  const groups = moreGroups(vis, primaryNav(vis))
  const inMore = new Set(groups.flatMap(g => g.items.map(i => i.href)))
  assert.ok(inMore.has('/admin/operations/messages'), 'Messages reachable via More')
})

test('every visible destination is reachable — primary OR in a More group (nothing lost)', () => {
  const vis = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true })
  const primary = primaryNav(vis)
  const groups = moreGroups(vis, primary)
  const reachable = new Set([...primary.map(p => p.href), ...groups.flatMap(g => g.items.map(i => i.href))])
  for (const n of vis) assert.ok(reachable.has(n.href), `${n.href} must be reachable`)
  // No destination appears in both primary and More.
  const inMore = new Set(groups.flatMap(g => g.items.map(i => i.href)))
  for (const p of primary) assert.ok(!inMore.has(p.href), `${p.href} not duplicated in More`)
})

test('More groups are ordered + non-empty; Pay lives under Finance', () => {
  const vis = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: true })
  const groups = moreGroups(vis, primaryNav(vis))
  assert.ok(groups.every(g => g.items.length > 0), 'no empty groups')
  const finance = groups.find(g => g.group === 'finance')
  assert.ok(finance?.items.some(i => i.href === '/admin/operations/pay-statements'), 'Pay under Finance')
  assert.ok(groups.some(g => g.group === 'platform' && g.items.some(i => i.href === '/admin/operations/settings')), 'Settings under Platform')
})

test('manager More menu excludes owner/admin-only destinations', () => {
  const vis = visibleNav(NAV_ITEMS, { role: 'manager', isOwner: false })
  const groups = moreGroups(vis, primaryNav(vis))
  const hrefs = groups.flatMap(g => g.items.map(i => i.href))
  assert.ok(!hrefs.includes('/admin/operations/settings'))
  assert.ok(!hrefs.includes('/admin/operations/platform'))
})
