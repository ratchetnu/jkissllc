// Route assignment → SMS. Builds the confirmation link + message and records the
// Twilio result on the route. sendSmsDetailed() already enforces the app-level
// opt-out (sms:optout:{phone}), so opted-out contractors are never texted.
import { sendSmsDetailed } from './sms'
import { pushAudit, setStatus, type RouteRecord } from './routes'
import type { Staff } from './staff'

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://jkissllc.com').replace(/\/$/, '')

export function confirmUrl(token: string): string {
  return `${BASE}/route/${token}`
}

// YYYY-MM-DD → "Wed, Jul 8" (rendered in UTC-noon so the calendar day never shifts).
export function fmtRouteDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function assignmentSms(route: RouteRecord): string {
  return `J KISS LLC Route Assignment: You have been assigned a route for ${fmtRouteDate(route.routeDate)} at ${route.reportTime}. ` +
    `Location: ${route.reportAddress}. Confirm here: ${confirmUrl(route.token)}. Reply STOP to opt out.`
}

// Assign a crew member and text them the confirmation link. Mutates `route`.
// Returns { ok } — false when the text couldn't be sent (no phone / opt-out /
// Twilio error); the route is still assigned so the admin can retry or reassign.
export async function assignAndNotify(route: RouteRecord, staff: Staff): Promise<{ ok: boolean; error?: string }> {
  route.assignedStaffId = staff.id
  route.assignedStaffName = staff.name
  route.assignedStaffPhone = staff.phone
  pushAudit(route, 'admin', `Assigned to ${staff.name}`)
  setStatus(route, 'assigned', 'admin')

  if (!staff.phone) {
    route.smsStatus = 'no_phone'
    route.smsError = 'Contractor has no phone number on file.'
    pushAudit(route, 'system', 'SMS not sent — no phone on file')
    return { ok: false, error: 'No phone number on file for this contractor.' }
  }

  route.smsSentAt = Date.now()
  const res = await sendSmsDetailed(staff.phone, assignmentSms(route))
  if (res.ok) {
    route.smsSid = res.sid
    route.smsStatus = res.status || 'sent'
    route.smsError = undefined
    setStatus(route, 'text_sent', 'system', 'Assignment text sent')
    return { ok: true }
  }
  route.smsStatus = 'failed'
  route.smsError = res.error
  pushAudit(route, 'system', `SMS failed: ${res.error}`)
  return { ok: false, error: res.error }
}
