// ── Current-route → workspace-destination compatibility map ──────────────────
//
// Maps each future workspace destination to the CURRENT routes that already serve
// it, so a later nav cutover is a re-label + re-group, not a rebuild. An empty
// array marks a destination with no current home yet (a known product gap).
// Validated against the destination registry by tests.

export const WORKSPACE_ROUTE_MAP: Record<string, string[]> = {
  today: ['/admin/operations'],
  jobs: ['/admin/operations/list', '/admin/routes'],
  customers: [], // GAP: no first-class customer surface yet (see 03-capability-matrix.md #6)
  team: ['/admin/operations/employees'],
  messages: ['/admin/operations/messages', '/admin/inbox'],
  money: ['/admin/operations/finance', '/admin/operations/pay-statements', '/admin/invoices'],
  assets: ['/admin/operations/equipment'],
  insights: ['/admin/operations/ai'],
  automations: ['/admin/operations/messages'], // reminders live under the messages sub-app today
  settings: ['/admin/operations/settings'],
  'crew-home': ['/portal'],
  'crew-jobs': ['/portal/routes'],
  'crew-messages': ['/portal/messages'],
  'my-bookings': ['/booking/[token]'],
}

/** Destinations that have no current route home (product gaps to close). */
export function destinationGaps(): string[] {
  return Object.entries(WORKSPACE_ROUTE_MAP).filter(([, routes]) => routes.length === 0).map(([id]) => id)
}
