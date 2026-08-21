import { getAutomationSettings, type AutomationSettings } from './automation-settings'
import { alertOwnerRouteEvent } from './route-notify'
import { reminderSms, morningOfSms } from './route-notify'
import { withRouteLock } from './route-mutex'
import { getRouteByToken, listRoutes, pushAudit, saveRoute, syncLead, type RouteRecord } from './routes'
import { sendSms } from './sms'
import { listStaff, staffCanAcceptAssignments, type Staff } from './staff'

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
})

const centralDate = (ts: number): string => dayFmt.format(new Date(ts))

function addDaysStr(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000)
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

export type DailyRouteAutomationDeps = {
  getAutomationSettings: () => Promise<AutomationSettings>
  listRoutes: (limit?: number) => Promise<RouteRecord[]>
  listStaff: (limit?: number) => Promise<Staff[]>
  withRouteLock: <T>(token: string, run: () => Promise<T>) => Promise<T>
  getRouteByToken: (token: string) => Promise<RouteRecord | null>
  alertOwnerRouteEvent: typeof alertOwnerRouteEvent
  sendSms: typeof sendSms
  saveRoute: typeof saveRoute
}

const defaults: DailyRouteAutomationDeps = {
  getAutomationSettings,
  listRoutes,
  listStaff,
  withRouteLock,
  getRouteByToken,
  alertOwnerRouteEvent,
  sendSms,
  saveRoute,
}

// Route-dispatch automation is kept outside the HTTP route so the complete loop is
// behavior-testable. Historical assignments may remain visible, but contractors
// who are not currently ready are never contacted or marked as non-responsive.
export async function runDailyRouteAutomation(
  now: number,
  overrides: Partial<DailyRouteAutomationDeps> = {},
): Promise<Record<string, number>> {
  const deps = { ...defaults, ...overrides }
  const today = centralDate(now)
  const tomorrow = addDaysStr(today, 1)
  const counts = { routesProcessed: 0, routeReminders: 0, routeMorningOf: 0, routeNoResponse: 0, routeErrors: 0 }
  const auto = await deps.getAutomationSettings()
  const [routes, staff] = await Promise.all([deps.listRoutes(1000), deps.listStaff(1000)])
  const dispatchableStaff = new Set(staff.filter(staffCanAcceptAssignments).map(person => person.id))

  for (const routeSnapshot of routes) {
    if (routeSnapshot.status === 'cancelled' || routeSnapshot.status === 'completed'
        || routeSnapshot.status === 'no_show' || routeSnapshot.status === 'draft') continue
    if (!(routeSnapshot.assignees ?? []).length) continue
    counts.routesProcessed++

    try {
      await deps.withRouteLock(routeSnapshot.token, async () => {
        const route = await deps.getRouteByToken(routeSnapshot.token)
        if (!route) return
        let changed = false
        for (const assignee of route.assignees ?? []) {
          if (!dispatchableStaff.has(assignee.staffId)) continue
          const pending = !assignee.confirmedAt && !assignee.declinedAt
          if (pending && route.routeDate < today) {
            if (!assignee.noResponseAlertedAt) {
              await deps.alertOwnerRouteEvent(route, 'no_response')
              assignee.noResponseAlertedAt = now
              counts.routeNoResponse++
              changed = true
            }
          } else if (auto.confirmationReminders && pending
              && (route.routeDate === today || route.routeDate === tomorrow) && !assignee.reminderSentAt) {
            if (assignee.phone) await deps.sendSms(assignee.phone, reminderSms(route, assignee))
            assignee.reminderSentAt = now
            pushAudit(route, 'system', `Confirmation reminder sent to ${assignee.name}`)
            counts.routeReminders++
            changed = true
          }
          if (auto.morningReminders && assignee.confirmedAt
              && route.routeDate === today && !assignee.morningOfSentAt) {
            if (assignee.phone) await deps.sendSms(assignee.phone, morningOfSms(route, assignee))
            assignee.morningOfSentAt = now
            pushAudit(route, 'system', `Morning-of reminder sent to ${assignee.name}`)
            counts.routeMorningOf++
            changed = true
          }
        }
        if (changed) {
          syncLead(route)
          await deps.saveRoute(route)
        }
      })
    } catch (error) {
      counts.routeErrors++
      console.error('[cron/routes]', routeSnapshot.routeNumber, error)
    }
  }
  return counts
}
