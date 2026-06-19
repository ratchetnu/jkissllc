import { NextRequest, NextResponse } from 'next/server'
import {
  getBookingByToken, balanceDueCents, fmtUSD,
  SERVICE_LABELS, BOOKING_STATUS_LABEL, paymentSummaryStatus, PAYMENT_SUMMARY_LABEL,
} from '../../../../lib/bookings'
import { getPolicyVersion, getCurrentPolicy } from '../../../../lib/policy'

function esc(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function row(k: string, v?: string): string {
  if (!v) return ''
  return `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`
}
function fmtTs(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

// GET /api/booking/[token]/confirmation — printable Booking Confirmation Record.
// Customer-safe (no IP / internal notes); doubles as the customer's receipt.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const b = await getBookingByToken(token)
  if (!b) return new NextResponse('Booking not found', { status: 404 })

  const policy = b.agreementPolicyVersion
    ? (await getPolicyVersion(b.agreementPolicyVersion)) ?? (await getCurrentPolicy())
    : await getCurrentPolicy()

  const items = b.items.length ? `<ul class="items">${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Booking Confirmation — ${esc(b.bookingNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; padding: 28px; background: #f4f4f5; }
  .doc { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 14px; overflow: hidden; }
  .hd { background: #0b0b0c; color: #fff; padding: 22px 28px; display: flex; justify-content: space-between; align-items: center; }
  .hd h1 { font-size: 20px; margin: 0; font-weight: 800; }
  .hd .red { color: #E0002A; }
  .hd .meta { text-align: right; font-size: 12px; color: #bbb; }
  .body { padding: 28px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #E0002A; margin: 26px 0 8px; }
  h2:first-child { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td.k { color: #777; width: 200px; padding: 5px 0; vertical-align: top; }
  td.v { font-weight: 600; padding: 5px 0; }
  .items { margin: 6px 0 0; padding-left: 20px; font-size: 14px; }
  .items li { margin: 2px 0; }
  .totals td.v { text-align: right; }
  .balance { font-size: 18px; font-weight: 800; color: #E0002A; }
  .policy { white-space: pre-wrap; font-size: 11px; color: #444; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 14px; margin-top: 8px; max-height: 320px; overflow: auto; }
  .ft { padding: 16px 28px; border-top: 1px solid #eee; font-size: 11px; color: #999; text-align: center; }
  .btn { display:inline-block; background:#E0002A; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px; font-weight:700; font-size:13px; border:none; cursor:pointer; }
  .toolbar { max-width:720px; margin:0 auto 14px; text-align:right; }
  @media print { body { background:#fff; padding:0; } .doc { border:none; } .toolbar { display:none; } .policy { max-height:none; overflow:visible; } }
</style></head>
<body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save PDF</button></div>
  <div class="doc">
    <div class="hd">
      <h1>J KISS <span class="red">LLC</span></h1>
      <div class="meta">BOOKING CONFIRMATION<br>${esc(b.bookingNumber)}${b.invoiceNumber ? `<br>Invoice ${esc(b.invoiceNumber)}` : ''}</div>
    </div>
    <div class="body">
      <h2>Booking</h2>
      <table>
        ${row('Status', BOOKING_STATUS_LABEL[b.status])}
        ${row('Customer', b.customerName)}
        ${row('Phone', b.customerPhone)}
        ${row('Email', b.customerEmail)}
        ${row('Service', SERVICE_LABELS[b.serviceType])}
        ${row('Invoice Date', b.invoiceDate)}
        ${row('Service Date', b.selectedDate)}
        ${row('Arrival Window', b.selectedWindow)}
        ${row('Time Verified', fmtTs(b.customerTimeVerifiedAt))}
      </table>

      <h2>Locations</h2>
      <table>
        ${row('Pickup', b.pickupAddress)}
        ${row('Drop-off', b.dropoffAddress)}
        ${row('Job Site', b.jobSiteAddress)}
      </table>

      ${b.description || items ? `<h2>Job Details</h2>${b.description ? `<p style="font-size:14px;margin:0 0 6px">${esc(b.description)}</p>` : ''}${items}` : ''}
      ${b.crewSize || b.estimatedHours ? `<table>${row('Crew', b.crewSize ? `${b.crewSize}-person team` : undefined)}${row('Estimated Hours', b.estimatedHours ? String(b.estimatedHours) : undefined)}</table>` : ''}

      <h2>Payment</h2>
      <table class="totals">
        ${row('Payment Status', PAYMENT_SUMMARY_LABEL[paymentSummaryStatus(b)])}
        <tr><td class="k">Invoice Total</td><td class="v">${fmtUSD(b.invoiceAmountCents)}</td></tr>
        ${b.depositAmountCents ? `<tr><td class="k">Deposit</td><td class="v">${fmtUSD(b.depositAmountCents)}</td></tr>` : ''}
        <tr><td class="k">Amount Paid</td><td class="v">${fmtUSD(b.amountPaidCents)}</td></tr>
        <tr><td class="k">Balance Due</td><td class="v balance">${fmtUSD(balanceDueCents(b))}</td></tr>
      </table>

      <h2>Cancellation &amp; Refund Policy Accepted</h2>
      <table>
        ${row('Policy Version', `v${policy.version}`)}
        ${row('Accepted', fmtTs(b.agreementAcceptedAt) || 'Not yet accepted')}
      </table>
      <div class="policy">${esc(policy.text)}</div>
    </div>
    <div class="ft">J Kiss LLC · (817) 909-4312 · info@jkissllc.com · US DOT 3484556 / MC 01155352 · Generated ${fmtTs(Date.now())}</div>
  </div>
</body></html>`

  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
