// Route assignment → SMS. Builds the confirmation link + message and records the
// Twilio result on the route. sendSmsDetailed() already enforces the app-level
// opt-out (sms:optout:{phone}), so opted-out contractors are never texted.
import { sendSmsDetailed } from './sms'
import { pushAudit, addAssignee, removeAssignee, syncLead, type RouteRecord, type Assignee } from './routes'
import { sendOwnerAlert } from './owner-alerts'
import { recordMessage } from './messages'
import { getFinanceSettings, snapshotCrewPay } from './finance'
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

// The assignment text. It carries the crew member's OWN pay and only when the
// owner has enabled showPayInConfirm — never the client's contract price, never
// the route's profit, never another crew member's pay.
export function assignmentSms(route: RouteRecord, assignee: Assignee, opts: { showPay?: boolean } = {}): string {
  const pay = opts.showPay && assignee.pay ? ` Your pay: ${assignee.pay}.` : ''
  return `J KISS LLC Route Assignment: You have been assigned a route for ${fmtRouteDate(route.routeDate)} at ${route.reportTime}. ` +
    `Location: ${route.reportAddress}.${pay} Confirm here: ${confirmUrl(assignee.token)}. Reply STOP to opt out.`
}

// Nudge an assigned-but-unconfirmed crew member as the route date nears.
export function reminderSms(route: RouteRecord, assignee: Assignee): string {
  return `J KISS LLC reminder: Please confirm your route for ${fmtRouteDate(route.routeDate)} at ${route.reportTime}. ` +
    `Tap to confirm: ${confirmUrl(assignee.token)} — Reply STOP to opt out.`
}

// Morning-of reminder for a crew member who already confirmed.
export function morningOfSms(route: RouteRecord, assignee: Assignee): string {
  return `J KISS LLC — today's route: report at ${route.reportTime}, ${route.reportAddress}. ` +
    `Details: ${confirmUrl(assignee.token)}. Reply STOP to opt out.`
}

// Add a crew member — NO text. The owner sends confirmations explicitly.
//
// Their pay is snapshotted now: `manualCents` (typed in for this route) wins,
// otherwise their configured rate for this business, otherwise their default.
// If none exists the route simply carries no pay for them, and the finance
// dashboard flags it as unpriced crew rather than silently counting $0.
export function addCrew(route: RouteRecord, staff: Staff, manualCents?: number | null): Assignee {
  const a = addAssignee(route, { staffId: staff.id, name: staff.name, phone: staff.phone, role: staff.role })
  // addAssignee returns the EXISTING assignee if this person is already on the
  // route — don't silently re-price them on a duplicate add.
  if (a.payCents == null) snapshotCrewPay(a, staff, route.businessName, manualCents)
  return a
}

// Remove a crew member. Returns their (now dead) confirm token, or null.
export function removeCrew(route: RouteRecord, staffId: string): string | null {
  return removeAssignee(route, staffId)
}

// Text ONE crew member their own confirmation link. Updates that assignee's SMS
// state and rolls up the route. Returns { ok } — false on no phone / opt-out /
// Twilio error.
export async function sendAssignmentText(route: RouteRecord, assignee: Assignee): Promise<{ ok: boolean; error?: string }> {
  if (!assignee.phone) {
    assignee.smsStatus = 'no_phone'
    assignee.smsError = 'No phone number on file.'
    pushAudit(route, 'system', `SMS not sent to ${assignee.name} — no phone on file`)
    syncLead(route)
    return { ok: false, error: `No phone number on file for ${assignee.name}.` }
  }
  // Fail closed: if the setting can't be read, don't put money in the text.
  let showPay = false
  try { showPay = (await getFinanceSettings()).showPayInConfirm } catch { showPay = false }
  const body = assignmentSms(route, assignee, { showPay })

  assignee.smsSentAt = Date.now()
  const res = await sendSmsDetailed(assignee.phone, body)
  if (res.ok) {
    assignee.smsSid = res.sid
    assignee.smsStatus = res.status || 'sent'
    assignee.smsError = undefined
    pushAudit(route, 'system', `Confirmation text sent to ${assignee.name}`)
    // Log to the Messages hub under the "route" (employee) category. Log the
    // exact body that was sent, not a re-rendered one.
    try {
      await recordMessage({
        direction: 'outbound', channel: 'sms', provider: 'twilio',
        to: assignee.phone, body,
        customerName: assignee.name, customerPhone: assignee.phone,
        providerMessageId: res.sid, tags: ['route'], unread: false,
      })
    } catch { /* logging is non-fatal */ }
  } else {
    assignee.smsStatus = 'failed'
    assignee.smsError = res.error
    pushAudit(route, 'system', `SMS to ${assignee.name} failed: ${res.error}`)
  }
  syncLead(route)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

// Assign a single default contractor + text them. Used by recurring-template
// generation (an explicit automation the owner opted into), NOT manual assign.
export async function assignAndNotify(route: RouteRecord, staff: Staff): Promise<{ ok: boolean; error?: string }> {
  const a = addCrew(route, staff)
  return sendAssignmentText(route, a)
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Alert the owner that a route needs attention — a contractor declined it, or it
// went unanswered past its date. Fire-and-forget (never throws). The confirm API
// fires 'declined' in real time; the daily cron fires 'no_response'.
export async function alertOwnerRouteEvent(
  route: RouteRecord,
  event: 'declined' | 'no_response',
  person?: { name?: string; reason?: string },
): Promise<void> {
  const adminUrl = `${BASE}/admin/routes`
  const who = person?.name || route.assignedStaffName || 'A contractor'
  const when = fmtRouteDate(route.routeDate)
  const ref = route.routeNumber
  const biz = route.businessName
  const declineReason = person?.reason ?? route.declineReason

  let smsBody: string
  let subject: string
  let headline: string
  if (event === 'declined') {
    const reason = declineReason ? ` — “${declineReason}”` : ''
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
    (event === 'declined' && declineReason
      ? `<tr><td style="padding:2px 12px 2px 0;color:#777">Reason</td><td>${esc(declineReason)}</td></tr>` : '') +
    `</table>` +
    `<p style="margin:16px 0 0"><a href="${adminUrl}" style="background:#e5233a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Reassign this route →</a></p>`

  await sendOwnerAlert({ smsBody, emailSubject: subject, emailHtml: html })
}
