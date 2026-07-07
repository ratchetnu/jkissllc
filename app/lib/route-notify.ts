// Route assignment → SMS. Builds the confirmation link + message and records the
// Twilio result on the route. sendSmsDetailed() already enforces the app-level
// opt-out (sms:optout:{phone}), so opted-out contractors are never texted.
import { sendSmsDetailed } from './sms'
import { pushAudit, setStatus, type RouteRecord } from './routes'
import { sendOwnerAlert } from './owner-alerts'
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

// Nudge an assigned-but-unconfirmed contractor as the route date nears.
export function reminderSms(route: RouteRecord): string {
  return `J KISS LLC reminder: Please confirm your route for ${fmtRouteDate(route.routeDate)} at ${route.reportTime}. ` +
    `Tap to confirm: ${confirmUrl(route.token)} — Reply STOP to opt out.`
}

// Morning-of reminder for a route the contractor already confirmed.
export function morningOfSms(route: RouteRecord): string {
  return `J KISS LLC — today's route: report at ${route.reportTime}, ${route.reportAddress}. ` +
    `Details: ${confirmUrl(route.token)}. Reply STOP to opt out.`
}

// Assign a crew member to the route — NO text. Status → assigned. The owner
// sends the confirmation text as a separate, explicit step (sendAssignmentText).
export function assignStaff(route: RouteRecord, staff: Staff): void {
  route.assignedStaffId = staff.id
  route.assignedStaffName = staff.name
  route.assignedStaffPhone = staff.phone
  // Clear any prior send/confirmation state (e.g. reassigning to someone new).
  route.smsSid = undefined
  route.smsStatus = undefined
  route.smsError = undefined
  route.smsSentAt = undefined
  route.confirmedAt = undefined
  route.declinedAt = undefined
  route.declineReason = undefined
  route.linkOpenedAt = undefined
  pushAudit(route, 'admin', `Assigned to ${staff.name}`)
  setStatus(route, 'assigned', 'admin')
}

// Remove the assigned crew member — back to an unassigned draft.
export function unassignStaff(route: RouteRecord): void {
  const who = route.assignedStaffName
  route.assignedStaffId = undefined
  route.assignedStaffName = undefined
  route.assignedStaffPhone = undefined
  route.smsSid = undefined
  route.smsStatus = undefined
  route.smsError = undefined
  route.smsSentAt = undefined
  route.confirmedAt = undefined
  route.declinedAt = undefined
  route.declineReason = undefined
  route.linkOpenedAt = undefined
  pushAudit(route, 'admin', who ? `Removed ${who} from the route` : 'Removed assignment')
  setStatus(route, 'draft', 'admin')
}

// Text the currently-assigned contractor the confirmation link. Status →
// text_sent. Returns { ok } — false on no phone / opt-out / Twilio error.
export async function sendAssignmentText(route: RouteRecord): Promise<{ ok: boolean; error?: string }> {
  if (!route.assignedStaffPhone) {
    route.smsStatus = 'no_phone'
    route.smsError = 'Contractor has no phone number on file.'
    pushAudit(route, 'system', 'SMS not sent — no phone on file')
    return { ok: false, error: 'No phone number on file for this contractor.' }
  }
  route.smsSentAt = Date.now()
  const res = await sendSmsDetailed(route.assignedStaffPhone, assignmentSms(route))
  if (res.ok) {
    route.smsSid = res.sid
    route.smsStatus = res.status || 'sent'
    route.smsError = undefined
    setStatus(route, 'text_sent', 'system', 'Confirmation text sent')
    return { ok: true }
  }
  route.smsStatus = 'failed'
  route.smsError = res.error
  pushAudit(route, 'system', `SMS failed: ${res.error}`)
  return { ok: false, error: res.error }
}

// Assign + text in one step. Used by recurring-template generation (which is an
// explicit automation the owner opted into), NOT by manual assignment.
export async function assignAndNotify(route: RouteRecord, staff: Staff): Promise<{ ok: boolean; error?: string }> {
  assignStaff(route, staff)
  return sendAssignmentText(route)
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Alert the owner that a route needs attention — a contractor declined it, or it
// went unanswered past its date. Fire-and-forget (never throws). The confirm API
// fires 'declined' in real time; the daily cron fires 'no_response'.
export async function alertOwnerRouteEvent(
  route: RouteRecord,
  event: 'declined' | 'no_response',
): Promise<void> {
  const adminUrl = `${BASE}/admin/routes`
  const who = route.assignedStaffName || 'A contractor'
  const when = fmtRouteDate(route.routeDate)
  const ref = route.routeNumber
  const biz = route.businessName

  let smsBody: string
  let subject: string
  let headline: string
  if (event === 'declined') {
    const reason = route.declineReason ? ` — “${route.declineReason}”` : ''
    smsBody = `J KISS: ${who} DECLINED ${ref} (${biz}, ${when})${reason}. Reassign: ${adminUrl}`
    subject = `⚠ Route declined — ${ref} · ${who}`
    headline = `${esc(who)} declined ${esc(ref)}`
  } else {
    smsBody = `J KISS: No response on ${ref} — ${who}, ${biz}, ${when}. Reassign now: ${adminUrl}`
    subject = `⚠ No response — ${ref} · ${who}`
    headline = `No response on ${esc(ref)} from ${esc(who)}`
  }

  const html =
    `<p style="font-size:16px;font-weight:700;margin:0 0 10px;color:#b91c1c">${headline}</p>` +
    `<table style="font-size:14px;color:#333;border-collapse:collapse">` +
    `<tr><td style="padding:2px 12px 2px 0;color:#777">Route</td><td><strong>${esc(ref)}</strong></td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#777">Client</td><td>${esc(biz)}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#777">Date</td><td>${esc(when)} at ${esc(route.reportTime)}</td></tr>` +
    `<tr><td style="padding:2px 12px 2px 0;color:#777">Contractor</td><td>${esc(who)}</td></tr>` +
    (event === 'declined' && route.declineReason
      ? `<tr><td style="padding:2px 12px 2px 0;color:#777">Reason</td><td>${esc(route.declineReason)}</td></tr>` : '') +
    `</table>` +
    `<p style="margin:16px 0 0"><a href="${adminUrl}" style="background:#e5233a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Reassign this route →</a></p>`

  await sendOwnerAlert({ smsBody, emailSubject: subject, emailHtml: html })
}
