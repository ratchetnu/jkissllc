// Operion operations navigation model — pure tests (Apple-style IA, role-aware).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NAV_ITEMS, BOOK_NOW_HREF, visibleNav, desktopPrimaryNav, mobilePrimaryNav, menuGroups, mobileMoreGroups,
} from '../app/admin/operations/nav-config'

const ownerCtx = { role: 'admin', isOwner: true }

test('visibleNav: managers lose adminOnly; owner-only stays owner-only (permissions unchanged)', () => {
  const owner = visibleNav(NAV_ITEMS, ownerCtx)
  assert.ok(owner.some(n => n.href === '/admin/operations/settings'))
  assert.ok(owner.some(n => n.href === '/admin/operations/platform'))
  assert.ok(owner.some(n => n.href === '/admin/operations/sync'))
  assert.ok(owner.some(n => n.href === '/admin/operations/ai'))

  const manager = visibleNav(NAV_ITEMS, { role: 'manager', isOwner: false })
  assert.ok(!manager.some(n => n.href === '/admin/operations/settings'), 'manager: no Settings')
  assert.ok(!manager.some(n => n.href === '/admin/operations/platform'), 'manager: no Platform')
  assert.ok(!manager.some(n => n.href === '/admin/operations/sync'), 'manager: no Sync Status')
  assert.ok(!manager.some(n => n.href === '/admin/operations/ai'), 'manager: no AI Command Center')

  const adminNonOwner = visibleNav(NAV_ITEMS, { role: 'admin', isOwner: false })
  assert.ok(!adminNonOwner.some(n => n.href === '/admin/operations/platform'), 'non-owner: no Platform')
  assert.ok(!adminNonOwner.some(n => n.href === '/admin/operations/sync'), 'non-owner: no Sync Status')
  assert.ok(!adminNonOwner.some(n => n.href === '/admin/operations/ai'), 'non-owner: no AI Command Center')
  // Non-owner admin keeps admin-only-but-not-owner destinations.
  assert.ok(adminNonOwner.some(n => n.href === '/admin/operations/settings'), 'admin keeps Settings')
  assert.ok(adminNonOwner.some(n => n.href === '/admin/operations/release'), 'admin keeps Release Center')
})

test('desktop centre = Home, Schedule, Operations, Messages, Crew (in order)', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  assert.deepEqual(desktopPrimaryNav(vis).map(n => n.href), [
    '/admin/operations', '/admin/operations/schedule', '/admin/operations/list',
    '/admin/operations/messages', '/admin/operations/employees',
  ])
})

test('mobile bar = Home, Schedule, Operations, Messages (Crew + Book Now handled separately)', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const mob = mobilePrimaryNav(vis)
  assert.deepEqual(mob.map(n => n.href), [
    '/admin/operations', '/admin/operations/schedule', '/admin/operations/list', '/admin/operations/messages',
  ])
  assert.ok(!mob.some(n => n.href === BOOK_NOW_HREF), 'Book Now is the raised centre action, not a bar item')
  assert.ok(!mob.some(n => n.href === '/admin/operations/employees'), 'Crew lives in the mobile More sheet')
})

test('Book Now is never a plain nav pill — excluded from centre, mega-menu, and both bars', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const inCentre = desktopPrimaryNav(vis).some(n => n.href === BOOK_NOW_HREF)
  const inMega = menuGroups(vis).flatMap(g => g.items).some(n => n.href === BOOK_NOW_HREF)
  const inMobBar = mobilePrimaryNav(vis).some(n => n.href === BOOK_NOW_HREF)
  const inMobMore = mobileMoreGroups(vis).flatMap(g => g.items).some(n => n.href === BOOK_NOW_HREF)
  assert.ok(!inCentre && !inMega && !inMobBar && !inMobMore, 'Book Now surfaces only as bell + centre action')
})

test('desktop mega-menu categories are ordered + non-empty, with the reference grouping', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const groups = menuGroups(vis)
  assert.deepEqual(groups.map(g => g.key), ['team', 'comms', 'business', 'finance', 'release', 'platform'])
  assert.ok(groups.every(g => g.items.length > 0), 'no empty groups')
  const byKey = (k: string) => groups.find(g => g.key === k)!.items.map(i => i.href)
  assert.deepEqual(byKey('team'), ['/admin/operations/users'], 'Team & Access is in the More menu, not buried in Settings')
  assert.ok(byKey('comms').includes('/admin/operations/communications'))
  assert.ok(byKey('comms').includes('/admin/operations/ai'), 'AI Command Center under Communication')
  assert.deepEqual(byKey('business'), ['/admin/operations/businesses', '/admin/operations/equipment', '/admin/operations/claims'])
  assert.deepEqual(byKey('finance'), ['/admin/operations/pay-statements', '/admin/operations/settings'])
  assert.deepEqual(byKey('release'), ['/admin/operations/release'])
  assert.deepEqual(byKey('platform'), ['/admin/operations/platform', '/admin/operations/sync'])
})

test('mobile More sheet leads with ONE Team section holding Crew and Team & Access', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const groups = mobileMoreGroups(vis)
  assert.equal(groups[0].key, 'team')
  // The bottom-bar overflow (Crew) merges INTO the Team group. Two sections both
  // headed "Team" would be the obvious bug in doing this the easy way.
  assert.deepEqual(groups[0].items.map(i => i.href), ['/admin/operations/employees', '/admin/operations/users'])
  assert.equal(groups.filter(g => g.label === 'Team').length, 1, 'exactly one Team heading')
  assert.deepEqual(groups.slice(1).map(g => g.key), ['comms', 'business', 'finance', 'release', 'platform'])
})

// The reported defect: adding a crew login required Settings -> Team & Access, because
// /admin/operations/users appeared in no nav surface at all.
test('THE FIX: Team & Access is reachable from More on desktop AND mobile', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const USERS = '/admin/operations/users'
  assert.ok(menuGroups(vis).flatMap(g => g.items).some(n => n.href === USERS), 'desktop More menu')
  assert.ok(mobileMoreGroups(vis).flatMap(g => g.items).some(n => n.href === USERS), 'mobile More sheet')
  // It sits beside Crew, and is admin-only to match `users:manage` server-side.
  const item = NAV_ITEMS.find(n => n.href === USERS)!
  assert.equal(item.group, 'team')
  assert.equal(item.adminOnly, true)
})

test('a manager never sees Team & Access — nav matches users:manage enforcement', () => {
  const mgr = visibleNav(NAV_ITEMS, { role: 'manager', isOwner: false })
  const all = [...menuGroups(mgr), ...mobileMoreGroups(mgr)].flatMap(g => g.items.map(i => i.href))
  assert.ok(!all.includes('/admin/operations/users'))
})

test('nothing is lost — every visible destination is reachable on desktop AND on mobile', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const desktopReach = new Set<string>([
    ...desktopPrimaryNav(vis).map(n => n.href),
    ...menuGroups(vis).flatMap(g => g.items.map(i => i.href)),
    BOOK_NOW_HREF, // the notification indicator
  ])
  const mobileReach = new Set<string>([
    ...mobilePrimaryNav(vis).map(n => n.href),
    ...mobileMoreGroups(vis).flatMap(g => g.items.map(i => i.href)),
    BOOK_NOW_HREF, // the raised centre action
  ])
  for (const n of vis) {
    assert.ok(desktopReach.has(n.href), `${n.href} reachable on desktop`)
    assert.ok(mobileReach.has(n.href), `${n.href} reachable on mobile`)
  }
})

test('no destination is duplicated between the desktop centre and the mega-menu', () => {
  const vis = visibleNav(NAV_ITEMS, ownerCtx)
  const centre = new Set(desktopPrimaryNav(vis).map(n => n.href))
  for (const n of menuGroups(vis).flatMap(g => g.items)) {
    assert.ok(!centre.has(n.href), `${n.href} not in both centre and mega-menu`)
  }
})

test('manager mega-menu + sheet exclude owner/admin-only destinations', () => {
  const vis = visibleNav(NAV_ITEMS, { role: 'manager', isOwner: false })
  const hrefs = [...menuGroups(vis), ...mobileMoreGroups(vis)].flatMap(g => g.items.map(i => i.href))
  for (const gone of ['/admin/operations/settings', '/admin/operations/platform', '/admin/operations/sync', '/admin/operations/ai']) {
    assert.ok(!hrefs.includes(gone), `manager must not see ${gone}`)
  }
})
