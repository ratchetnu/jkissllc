import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../../_lib/session'
import {
  listBookings, balanceDueCents, paymentSummaryStatus, confirmedFeesCents,
  SERVICE_LABELS, BOOKING_STATUS_LABEL, PAYMENT_SUMMARY_LABEL, type Booking,
} from '../../../../lib/bookings'
// Shared cell renderer: escapes delimiters AND neutralizes spreadsheet formula
// injection (customer name/email/promo flow into this staff-downloaded export).
import { csvCell } from '../../../../lib/validators'

const usd = (c: number) => (c / 100).toFixed(2)

function jobDate(b: Booking): string {
  return b.selectedDate || new Date(b.createdAt).toISOString().slice(0, 10)
}

// GET /api/admin/bookings/export?filter=all|paid|unpaid|completed&service=&from=&to=
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') ?? 'all'
  const service = searchParams.get('service') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  const includeTest = searchParams.get('includeTest') === '1'

  let rows = await listBookings(1000)

  rows = rows.filter(b => {
    if (!includeTest && b.isTest) return false // sandbox records excluded unless explicitly requested
    if (service && b.serviceType !== service) return false
    const d = jobDate(b)
    if (from && d < from) return false
    if (to && d > to) return false
    if (filter === 'paid' && paymentSummaryStatus(b) !== 'paid_in_full') return false
    if (filter === 'unpaid' && b.amountPaidCents > 0) return false
    if (filter === 'completed' && b.status !== 'completed') return false
    return true
  })

  const header = [
    'Booking #', 'Invoice Number', 'Customer', 'Phone', 'Email', 'Service Type', 'Assigned To', 'Job Date', 'Arrival Window',
    'Invoice Amount', 'Discount', 'Promo Code', 'Amount Paid', 'Processing Fees', 'Net Revenue', 'Balance Due',
    'Booking Status', 'Payment Status', 'Reschedules', 'Archived', 'Created',
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const b of rows) {
    lines.push([
      b.bookingNumber,
      b.invoiceNumber ?? '',
      b.customerName,
      b.customerPhone ?? '',
      b.customerEmail ?? '',
      SERVICE_LABELS[b.serviceType],
      b.assignedTo ?? '',
      jobDate(b),
      b.selectedWindow ?? '',
      usd(b.invoiceAmountCents),
      usd(b.discountCents ?? 0),
      b.promoCode ?? '',
      usd(b.amountPaidCents),
      usd(confirmedFeesCents(b)),
      usd(b.amountPaidCents),
      usd(balanceDueCents(b)),
      BOOKING_STATUS_LABEL[b.status],
      PAYMENT_SUMMARY_LABEL[paymentSummaryStatus(b)],
      String(b.rescheduleCount ?? 0),
      b.archived ? 'yes' : '',
      new Date(b.createdAt).toISOString().slice(0, 10),
    ].map(csvCell).join(','))
  }

  const csv = lines.join('\n')
  const fname = `jkiss-bookings-${filter}-${new Date().toISOString().slice(0, 10)}.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
    },
  })
})
