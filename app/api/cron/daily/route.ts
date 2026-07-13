import { NextRequest, NextResponse } from 'next/server'
import { listBookings, saveBooking, balanceDueCents, paymentSummaryStatus, type Booking, type BookingStatus } from '../../../lib/bookings'
import { notifyBookingReminder, notifyPaymentReminder, notifyJobTomorrow, notifyReviewRequest } from '../../../lib/notify'
import { isAbandonedOnlineHold } from '../../../lib/availability'
import { listRoutes, getRouteByToken, saveRoute, syncLead, pushAudit } from '../../../lib/routes'
import { withRouteLock } from '../../../lib/route-mutex'
import { reminderSms, morningOfSms, alertOwnerRouteEvent } from '../../../lib/route-notify'
import { listTemplates, materializeTemplate } from '../../../lib/route-templates'
import { accrueAllClaims } from '../../../lib/claim-accrual'
import { sendSms, withSmsSuppressed } from '../../../lib/sms'
import { getAutomationSettings } from '../../../lib/automation-settings'

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
  // Owner switches for the crew reminder texts. No-response owner alerts are NOT
  // gated — those tell the owner a route went unconfirmed, which they always want.
  const auto = await getAutomationSettings()
  const routes = await listRoutes(1000)

  for (const r0 of routes) {
    // Terminal / not-yet-live routes get no automation. Cheap pre-filter on the
    // bulk-loaded copy; the actual mutation reloads fresh under the route lock.
    if (r0.status === 'cancelled' || r0.status === 'completed' || r0.status === 'no_show' || r0.status === 'draft') continue
    if (!(r0.assignees ?? []).length) continue
    counts.routesProcessed++

    try {
      // Under the lock so an early-morning confirm/decline on this route can't be
      // clobbered by the cron's flag write (and vice versa). RouteBusyError just
      // defers this route to the next pass — the dedupe stamps make it idempotent.
      await withRouteLock(r0.token, async () => {
        const r = await getRouteByToken(r0.token)
        if (!r) return
        let changed = false
        for (const a of r.assignees ?? []) {
          const pending = !a.confirmedAt && !a.declinedAt
          if (pending && r.routeDate < today) {
            // Past its date, never confirmed → one-time owner alert per person.
            if (!a.noResponseAlertedAt) {
              await alertOwnerRouteEvent(r, 'no_response')
              a.noResponseAlertedAt = now; counts.routeNoResponse++; changed = true
            }
          } else if (auto.confirmationReminders && pending && (r.routeDate === today || r.routeDate === tomorrow) && !a.reminderSentAt) {
            // Imminent and still unconfirmed → nudge this crew member to confirm.
            if (a.phone) await sendSms(a.phone, reminderSms(r, a))
            a.reminderSentAt = now; pushAudit(r, 'system', `Confirmation reminder sent to ${a.name}`); counts.routeReminders++; changed = true
          }
          if (auto.morningReminders && a.confirmedAt && r.routeDate === today && !a.morningOfSentAt) {
            // Confirmed and happening today → morning-of reminder.
            if (a.phone) await sendSms(a.phone, morningOfSms(r, a))
            a.morningOfSentAt = now; pushAudit(r, 'system', `Morning-of reminder sent to ${a.name}`); counts.routeMorningOf++; changed = true
          }
        }
        if (changed) { syncLead(r); await saveRoute(r) }
      })
    } catch (e) {
      counts.routeErrors++
      console.error('[cron/routes]', r0.routeNumber, e)
    }
  }
  return counts
}

// Materialize routes from active recurring templates for the next 14 days, so
// standing contracts always have their routes created without manual work.
// materializeTemplate skips dates already generated, so this is idempotent.
async function runTemplates(now: number): Promise<Record<string, number>> {
  const today = centralDate(now)
  const templates = await listTemplates()
  let generated = 0
  for (const t of templates) {
    if (!t.active) continue
    try { generated += (await materializeTemplate(t, today, 14)).created.length }
    catch (e) { console.error('[cron/templates]', t.id, e) }
  }
  return { templatesActive: templates.filter(t => t.active).length, routesGenerated: generated }
}

// Weekly claim deductions. accrueAllClaims only touches pay weeks that have ended
// and never deducts more than the contractor earned, so a bad day here can't
// over-collect — it just does nothing.
async function runClaims(now: number): Promise<Record<string, unknown>> {
  try {
    const r = await accrueAllClaims(now)
    return { claimsScanned: r.claimsScanned, deductionsPosted: r.posted.length, deductionsSkipped: r.skipped.length }
  } catch (e) {
    console.error('[cron/claims]', e)
    return { error: 'claim accrual failed' }
  }
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed — an unconfigured secret must not leave this open
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // ?dryRun=1 → don't send reminders or cancel anything; just report abandoned holds.
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  try {
    // Automated TEXTS are permanently disabled for the 9am run: everything below still
    // runs (email reminders, route generation, claim deductions, hold cleanup), but any
    // outbound SMS it would send is suppressed at the send layer. See withSmsSuppressed.
    return await withSmsSuppressed(async () => {
    const counts = dryRun ? { skipped: 'reminders (dry-run)' } : await run()
    // Template generation is isolated: nextRouteNumber() now throws rather than
    // minting a possibly-duplicate number when Redis is unreachable, and a throw
    // here would otherwise skip runRoutes() below — silencing the crew's route
    // texts for the whole day. Generating no routes is recoverable; not texting
    // the drivers is not.
    const templates = dryRun ? { skipped: 'templates (dry-run)' } : await runTemplates(Date.now()).catch(e => {
      console.error('[cron/templates]', e)
      return { error: 'template generation failed' }
    })
    const routes = dryRun ? { skipped: 'routes (dry-run)' } : await runRoutes(Date.now())
    const cleanup = await cleanupAbandonedHolds(Date.now(), dryRun)
    // Post any weekly claim deductions whose pay week has closed. Idempotent per
    // (contractor, week), and capped at what they actually earned.
    const claims = dryRun ? { skipped: 'claim deductions (dry-run)' } : await runClaims(Date.now())
    return NextResponse.json({ ok: true, dryRun, smsSuppressed: true, ...counts, templates, routes, cleanup, claims })
    })
  } catch (e) {
    console.error('[cron/daily] fatal', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
