const publicPaths = [
  '/', '/quote', '/track', '/about', '/careers', '/reviews', '/safety',
  '/privacy', '/terms', '/start-your-carrier', '/box-truck-delivery/dallas',
  '/opspilot', '/operion', '/coi',
]

const adminPaths = [
  '/admin/operations', '/admin/operations/schedule', '/admin/operations/book-now',
  '/admin/operations/list', '/admin/operations/employees', '/admin/operations/businesses',
  '/admin/operations/equipment', '/admin/operations/claims', '/admin/operations/messages',
  '/admin/operations/communications', '/admin/operations/finance',
  '/admin/operations/pay-statements', '/admin/operations/timesheets',
  '/admin/operations/settings', '/admin/operations/release',
  '/admin/operations/ai', '/admin/operations/ai/controls',
  '/admin/operations/ai/performance', '/admin/operations/ai/learning',
  '/admin/operations/ai/shadow', '/admin/operations/ai/alerts',
  '/admin/disposal',
]

const entry = (path, authRequired, extra = {}) => ({
  path,
  authRequired,
  readiness: { selector: 'main', minimumText: authRequired ? 20 : 30, ...extra },
})

export const MOBILE_AUDIT_ROUTES = [
  ...publicPaths.map((path) => entry(path, false)),
  ...adminPaths.map((path) => entry(path, true)),
  entry('/portal', true),
].map((route) => {
  if (route.path === '/admin/operations/timesheets') {
    return { ...route, readiness: { ...route.readiness, expectedText: ['Timesheets', 'Period total', 'Entries'] } }
  }
  if (route.path === '/quote') {
    return { ...route, readiness: { ...route.readiness, expectedText: ['Let’s Plan Your Move'] } }
  }
  return route
})

export function readinessFor(path) {
  return MOBILE_AUDIT_ROUTES.find((route) => route.path === path) ?? null
}
