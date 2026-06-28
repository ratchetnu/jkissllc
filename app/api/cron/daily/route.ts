import { NextRequest, NextResponse } from 'next/server'
import { listBookings, saveBooking, balanceDueCents, paymentSummaryStatus, type Booking } from '../../../lib/bookings'
import { notifyBookingReminder, notifyPaymentReminder, notifyJobTomorrow, notifyReviewRequest } from '../../../lib/notify'

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

  for (const b of bookings) {
    if (b.status === 'cancelled') continue
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
        !nudgedThisRun && !r.recoverySentAt && !b.customerTimeVerifiedAt &&
        b.amountPaidCents === 0 && balanceDueCents(b) > 0 &&
        daysSince(b.confirmationLinkSentAt) >= 2
      ) {
        await notifyBookingReminder(b)
        r.recoverySentAt = now; counts.recovery++; changed = true; nudgedThisRun = true
      }

      // 3. Payment reminder — engaged customer with an unpaid balance, 3d+ stale.
      if (
        !nudgedThisRun && !r.paymentSentAt && !b.collectInPerson &&
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

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // not configured — allow (Vercel adds the bearer once set)
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const counts = await run()
    return NextResponse.json({ ok: true, ...counts })
  } catch (e) {
    console.error('[cron/daily] fatal', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
