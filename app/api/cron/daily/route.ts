import { NextRequest, NextResponse } from 'next/server'
import { listBookings, saveBooking, balanceDueCents, paymentSummaryStatus, type Booking, type BookingStatus } from '../../../lib/bookings'
import { notifyBookingReminder, notifyPaymentReminder, notifyJobTomorrow, notifyReviewRequest } from '../../../lib/notify'
import { isAbandonedOnlineHold } from '../../../lib/availability'
import { listRoutes, saveRoute, setStatus, pushAudit } from '../../../lib/routes'
import { reminderSms, morningOfSms, alertOwnerRouteEvent } from '../../../lib/route-notify'
import { sendSms } from '../../../lib/sms'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Central-time calendar date (YYYY-MM-DD) for a timestamp.
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
const centralDate = (ts: number) => dayFmt.format(new Date(ts))
function addDaysStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
const DAY = 86_400_000

// Runs once daily (Vercel Cron). Sends time-based reminders with one-shot dedupe
// stamps on each booking. Fail-soft: a single send error never aborts the run.
async function run(): Promise<Record<string, number>> {
  const now = Date.now()
  const todayStr = centralDate(now)
  const tomorrowStr = addDaysStr(todayStr, 1)
  const daysSince = (ts?: number) => (ts ? (now - ts) / DAY : Infinity)

  const counts = { processed: 0, recovery: 0, payment: 0, dayBefore: 0, review: 0, errors: 0 }
  const bookings = await listBookings(1000)

  // Dead statuses get NO automation at all. 'completed' is intentionally excluded —
  // it still flows below to the post-job review request.
  const NO_AUTOMATION: BookingStatus[] = ['cancelled', 'could_not_complete', 'partially_completed', 'refunded']
  for (const b of bookings) {
    if (NO_AUTOMATION.includes(b.status)) continue
    counts.processed++
    const reachable = Boolean(b.customerEmail || b.customerPhone)
    if (!reachable) continue
    const r = b.reminders ?? (b.reminders = {})
    let changed = false
    let nudgedThisRun = false

    try {
      // 1. Day-before reminder — a real, scheduled job happening tomorrow.
      if (
        !r.dayBeforeSentAt && b.selectedDate === tomorrowStr &&
        (b.status === 'confirmed' || b.status === 'time_verified')
      ) {
        await notifyJobTomorrow(b)
        r.dayBeforeSentAt = now; counts.dayBefore++; changed = true; nudgedThisRun = true
      }

      // 2. Abandoned-booking recovery — link sent, never verified or paid, 2d+ stale.
      if (
        !nudgedThisRun && !b.automationPaused && !r.recoverySentAt && !b.customerTimeVerifiedAt &&
        b.amountPaidCents === 0 && balanceDueCents(b) > 0 &&
        daysSince(b.confirmationLinkSentAt) >= 2
      ) {
        await notifyBookingReminder(b)
        r.recoverySentAt = now; counts.recovery++; changed = true; nudgedThisRun = true
      }

      // 3. Payment reminder — engaged customer with an unpaid balance, 3d+ stale.
      if (
        !nudgedThisRun && !b.automationPaused && !r.paymentSentAt && !b.collectInPerson &&
        balanceDueCents(b) > 0 && paymentSummaryStatus(b) !== 'paid_in_full' &&
        (b.customerTimeVerifiedAt || b.amountPaidCents > 0) &&
        daysSince(b.confirmationLinkSentAt ?? b.createdAt) >= 3
      ) {
        await notifyPaymentReminder(b)
        r.paymentSentAt = now; counts.payment++; changed = true; nudgedThisRun = true
      }

      // 4. Review request — completed + paid-in-full, 3d+ after completion.
      if (
        !r.reviewRequestSentAt && b.status === 'completed' &&
        paymentSummaryStatus(b) === 'paid_in_full' && daysSince(b.completedAt) >= 3
      ) {
        await notifyReviewRequest(b)
        r.reviewRequestSentAt = now; counts.review++; changed = true
      }
    } catch (e) {
      counts.errors++
      console.error('[cron/daily]', b.bookingNumber, e)
    }

    if (changed) {
      try { await saveBooking(b as Booking) } catch (e) { console.error('[cron/daily save]', b.bookingNumber, e) }
    }
  }
  return counts
}

// Auto-cancel abandoned online deposit-holds (see isAbandonedOnlineHold for the
// exact, conservative criteria). dryRun logs what WOULD be cancelled, changes nothing.
async function cleanupAbandonedHolds(now: number, dryRun: boolean): Promise<{ matched: string[]; cancelled: number; dryRun: boolean }> {
  const bookings = await listBookings(1000)
  const matched: string[] = []
  let cancelled = 0
  for (const b of bookings) {
    if (!isAbandonedOnlineHold(b, now)) continue
    matched.push(b.bookingNumber)
    if (dryRun) { console.log('[cron/cleanup] DRY-RUN would cancel', b.bookingNumber); continue }
    const stamp = new Date(now).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
    const hrs = Math.round((now - b.createdAt) / DAY * 24)
    b.status = 'cancelled'
    b.cancelledAt = now
    b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] AUTO-CANCELLED: abandoned online hold — deposit never paid (${hrs}h after booking).`
    try { await saveBooking(b); cancelled++ } catch (e) { console.error('[cron/cleanup save]', b.bookingNumber, e) }
  }
  return { matched, cancelled, dryRun }
}

// Route Dispatch automation. Daily pass (9am Central):
//   • assigned/text_sent but unconfirmed, date today or tomorrow → confirm nudge
//   • confirmed and happening today → morning-of reminder
//   • assigned/text_sent but unconfirmed and the date has passed → mark No Response
//     and alert the owner so it can be reassigned.
// Each action carries a one-shot dedupe stamp; a send error never aborts the pass.
async function runRoutes(now: number): Promise<Record<string, number>> {
  const today = centralDate(now)
  const tomorrow = addDaysStr(today, 1)
  const counts = { routesProcessed: 0, routeReminders: 0, routeMorningOf: 0, routeNoResponse: 0, routeErrors: 0 }
  const routes = await listRoutes(1000)

  for (const r of routes) {
    // Terminal / not-yet-live statuses get no automation.
    if (r.status === 'cancelled' || r.status === 'completed' || r.status === 'declined' ||
        r.status === 'no_show' || r.status === 'draft') continue
    counts.routesProcessed++
    let changed = false
    const pendingConfirm = r.status === 'assigned' || r.status === 'text_sent'

    try {
      if (pendingConfirm && r.routeDate < today) {
        // Past its date, never confirmed → No Response + one-time owner alert.
        if (r.status !== 'no_response') { setStatus(r, 'no_response', 'system', 'No confirmation by route date'); changed = true }
        if (!r.noResponseAlertedAt) {
          await alertOwnerRouteEvent(r, 'no_response')
          r.noResponseAlertedAt = now; counts.routeNoResponse++; changed = true
        }
      } else if (pendingConfirm && (r.routeDate === today || r.routeDate === tomorrow) && !r.reminderSentAt) {
        // Imminent and still unconfirmed → nudge the contractor to confirm.
        if (r.assignedStaffPhone) await sendSms(r.assignedStaffPhone, reminderSms(r))
        r.reminderSentAt = now; pushAudit(r, 'system', 'Confirmation reminder sent'); counts.routeReminders++; changed = true
      }

      if (r.status === 'confirmed' && r.routeDate === today && !r.morningOfSentAt) {
        // Confirmed and happening today → morning-of reminder.
        if (r.assignedStaffPhone) await sendSms(r.assignedStaffPhone, morningOfSms(r))
        r.morningOfSentAt = now; pushAudit(r, 'system', 'Morning-of reminder sent'); counts.routeMorningOf++; changed = true
      }
    } catch (e) {
      counts.routeErrors++
      console.error('[cron/routes]', r.routeNumber, e)
    }

    if (changed) {
      try { await saveRoute(r) } catch (e) { console.error('[cron/routes save]', r.routeNumber, e) }
    }
  }
  return counts
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // not configured — allow (Vercel adds the bearer once set)
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // ?dryRun=1 → don't send reminders or cancel anything; just report abandoned holds.
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  try {
    const counts = dryRun ? { skipped: 'reminders (dry-run)' } : await run()
    const routes = dryRun ? { skipped: 'routes (dry-run)' } : await runRoutes(Date.now())
    const cleanup = await cleanupAbandonedHolds(Date.now(), dryRun)
    return NextResponse.json({ ok: true, dryRun, ...counts, routes, cleanup })
  } catch (e) {
    console.error('[cron/daily] fatal', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
