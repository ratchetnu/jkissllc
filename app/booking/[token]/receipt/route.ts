import { NextRequest, NextResponse } from 'next/server'
import {
  getBookingByToken, balanceDueCents, fmtUSD,
  SERVICE_LABELS, PAYMENT_METHOD_LABEL, paymentSummaryStatus,
} from '../../../lib/bookings'
import { siteUrl } from '../../../lib/booking-emails'
import { getReview } from '../../../lib/site-reviews'

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
function fmtDate(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-US', { dateStyle: 'medium' })
}

const HEAD = `<style>
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
  .paidbar { display:flex; justify-content:space-between; align-items:center; gap:12px; background:#ecfdf3; border:1px solid #abefc6; border-radius:10px; padding:14px 18px; margin:8px 0 4px; }
  .paidbar .lbl { font-size:13px; color:#067647; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
  .paidbar .amt { font-size:22px; font-weight:800; color:#067647; }
  .stamp { display:inline-block; border:3px solid #067647; color:#067647; font-weight:800; letter-spacing:.06em; padding:4px 12px; border-radius:8px; transform:rotate(-5deg); font-size:14px; }
  .pay td { padding:6px 0; font-size:13px; border-top:1px solid #f0f0f0; }
  .pay td:last-child { text-align:right; font-weight:700; }
  .review { margin-top:26px; background:#0b0b0c; border-radius:14px; padding:24px; text-align:center; color:#fff; }
  .review h3 { margin:0 0 6px; font-size:18px; font-weight:800; }
  .review p { margin:0 0 16px; font-size:14px; color:#cfcfcf; line-height:1.55; }
  .review .stars { font-size:22px; letter-spacing:3px; color:#FFC93C; margin-bottom:10px; }
  .review a.cta { display:inline-block; background:#E0002A; color:#fff; text-decoration:none; padding:13px 26px; border-radius:10px; font-weight:800; font-size:15px; cursor:pointer; }
  .review .opt { display:block; margin-top:12px; font-size:12px; color:#888; }
  .rstars { font-size:32px; letter-spacing:8px; cursor:pointer; user-select:none; margin:4px 0 2px; }
  .rstars span { color:#555; transition:color .1s; }
  .rstars span.on { color:#FFC93C; }
  .rform { margin-top:8px; }
  .rform textarea { width:100%; margin-top:12px; padding:12px 14px; border-radius:10px; border:1px solid #333; background:#141416; color:#fff; font-size:14px; font-family:inherit; resize:vertical; min-height:70px; }
  .rform .err { color:#ff8a9a; font-size:13px; margin-top:8px; min-height:18px; }
  .review .stars2 { font-size:26px; letter-spacing:4px; color:#FFC93C; margin-bottom:8px; }
  .review blockquote { margin:0 0 12px; font-size:14px; color:#ddd; font-style:italic; }
  .ft { padding: 16px 28px; border-top: 1px solid #eee; font-size: 11px; color: #999; text-align: center; }
  .btn { display:inline-block; background:#E0002A; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px; font-weight:700; font-size:13px; border:none; cursor:pointer; }
  .toolbar { max-width:720px; margin:0 auto 14px; text-align:right; }
  @media print { body { background:#fff; padding:0; } .doc { border:none; } .toolbar, .review a.cta { display:none; } }
</style>`

// GET /booking/[token]/receipt — the final paid invoice + an optional review prompt.
// Only renders the full receipt once the invoice is paid in full; otherwise it
// sends the customer back to their booking page to finish paying.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const b = await getBookingByToken(token)
  if (!b) return new NextResponse('Receipt not found', { status: 404 })

  const paidInFull = paymentSummaryStatus(b) === 'paid_in_full'

  if (!paidInFull) {
    const balance = balanceDueCents(b)
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt — ${esc(b.bookingNumber)}</title>${HEAD}</head>
<body><div class="doc"><div class="hd"><h1>J KISS <span class="red">LLC</span></h1><div class="meta">RECEIPT<br>${esc(b.bookingNumber)}</div></div>
<div class="body"><h2>Not yet paid in full</h2>
<p style="font-size:15px;line-height:1.6">Your paid receipt will be available here once the invoice is fully paid. Current balance due: <strong>${fmtUSD(balance)}</strong>.</p>
<p style="margin-top:18px"><a class="btn" href="${esc(siteUrl())}/booking/${esc(b.token)}">Go to your booking →</a></p></div>
<div class="ft">J Kiss LLC · (817) 909-4312 · info@jkissllc.com · US DOT 3484556 / MC 01155352</div></div></body></html>`
    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  const existing = await getReview(token)
  const firstName = esc(b.customerName.split(' ')[0] || 'there')
  const reviewSection = existing
    ? `<div class="review" id="review">
        <div class="stars2">${'★'.repeat(existing.rating)}${'☆'.repeat(5 - existing.rating)}</div>
        <h3>Thanks for the review!</h3>
        ${existing.text ? `<blockquote>“${esc(existing.text)}”</blockquote>` : ''}
        <span class="opt">Your feedback helps J Kiss LLC grow.</span>
      </div>`
    : `<div class="review" id="review">
        <h3>How did we do, ${firstName}?</h3>
        <p>Tap the stars and (optionally) tell us about your experience — it posts right here on our site.</p>
        <div class="rstars" id="rstars" role="radiogroup" aria-label="Star rating">
          <span data-v="1">★</span><span data-v="2">★</span><span data-v="3">★</span><span data-v="4">★</span><span data-v="5">★</span>
        </div>
        <div class="rform">
          <textarea id="rtext" maxlength="1000" placeholder="What went well? (optional)"></textarea>
          <div class="err" id="rerr"></div>
          <a class="cta" id="rsubmit">Submit Review →</a>
          <span class="opt">Totally optional — your receipt is yours to keep either way.</span>
        </div>
      </div>`
  const reviewScript = existing ? '' : `<script>
(function(){
  var rating=0;
  var stars=Array.prototype.slice.call(document.querySelectorAll('#rstars span'));
  function paint(n){ stars.forEach(function(s){ s.classList.toggle('on', Number(s.getAttribute('data-v'))<=n); }); }
  stars.forEach(function(s){
    s.addEventListener('click', function(){ rating=Number(s.getAttribute('data-v')); paint(rating); });
    s.addEventListener('mouseenter', function(){ paint(Number(s.getAttribute('data-v'))); });
  });
  var sr=document.getElementById('rstars');
  if(sr) sr.addEventListener('mouseleave', function(){ paint(rating); });
  var btn=document.getElementById('rsubmit');
  if(btn) btn.addEventListener('click', function(){
    var err=document.getElementById('rerr');
    if(!rating){ err.textContent='Please tap a star rating first.'; return; }
    err.textContent=''; btn.textContent='Submitting…'; btn.style.pointerEvents='none';
    fetch('/api/booking/${esc(b.token)}/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rating:rating,text:(document.getElementById('rtext').value||'')})})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
      .then(function(o){
        if(!o.ok) throw new Error(o.j.error||'Could not submit your review.');
        var box=document.getElementById('review');
        var filled='★★★★★'.slice(0,rating)+'☆☆☆☆☆'.slice(0,5-rating);
        box.innerHTML='<div class="stars2">'+filled+'</div><h3>Thanks for the review!</h3><span class="opt">Your feedback helps J Kiss LLC grow.</span>';
      })
      .catch(function(e){ err.textContent=e.message; btn.textContent='Submit Review →'; btn.style.pointerEvents='auto'; });
  });
})();
</script>`

  const items = b.items.length ? `<ul class="items">${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''
  const photoGrid = b.invoicePhotos && b.invoicePhotos.length
    ? `<h2>Photos</h2><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:4px">${b.invoicePhotos.map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;border:1px solid #ddd"></a>`).join('')}</div>`
    : ''
  const confirmed = b.payments.filter(p => p.status === 'confirmed').sort((a, c) => (a.confirmedAt ?? a.createdAt) - (c.confirmedAt ?? c.createdAt))
  const lastPaidAt = confirmed.reduce((m, p) => Math.max(m, p.confirmedAt ?? p.createdAt), 0)
  const payRows = confirmed.map(p =>
    `<tr><td>${esc(fmtDate(p.confirmedAt ?? p.createdAt))} · ${esc(PAYMENT_METHOD_LABEL[p.method])}</td><td>${fmtUSD(p.amountCents)}</td></tr>`
  ).join('')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paid Receipt — ${esc(b.bookingNumber)}</title>${HEAD}</head>
<body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save PDF</button></div>
  <div class="doc">
    <div class="hd">
      <h1>J KISS <span class="red">LLC</span></h1>
      <div class="meta">PAID INVOICE / RECEIPT<br>${esc(b.bookingNumber)}${b.invoiceNumber ? `<br>Invoice ${esc(b.invoiceNumber)}` : ''}</div>
    </div>
    <div class="body">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:4px">
        <span class="stamp">PAID IN FULL</span>
        <span style="font-size:12px;color:#888;text-align:right">Paid ${esc(fmtDate(lastPaidAt))}</span>
      </div>

      <h2>Customer</h2>
      <table>
        ${row('Name', b.customerName)}
        ${row('Email', b.customerEmail)}
        ${row('Phone', b.customerPhone)}
        ${row('Service', SERVICE_LABELS[b.serviceType])}
        ${row('Service Date', b.selectedDate ? `${b.selectedDate}${b.selectedWindow ? ` · ${b.selectedWindow}` : ''}` : undefined)}
        ${row('Your Crew', [b.assignedTo, b.assignedHelper].filter(Boolean).join(' & ') || undefined)}
        ${row('Invoice Date', b.invoiceDate)}
      </table>

      ${b.pickupAddress || b.dropoffAddress || b.jobSiteAddress ? `<h2>Locations</h2><table>${row('Pickup', b.pickupAddress)}${row('Drop-off', b.dropoffAddress)}${row('Job Site', b.jobSiteAddress)}</table>` : ''}

      ${b.description || items ? `<h2>Job Details</h2>${b.description ? `<p style="font-size:14px;margin:0 0 6px">${esc(b.description)}</p>` : ''}${items}` : ''}

      ${photoGrid}

      <h2>Payments</h2>
      <table class="pay">${payRows}</table>

      <h2>Summary</h2>
      <table class="totals">
        <tr><td class="k">Invoice Total</td><td class="v">${fmtUSD(b.invoiceAmountCents)}</td></tr>
        ${b.discountCents ? `<tr><td class="k">Discount${b.promoCode ? ` (${esc(b.promoCode)})` : ''}</td><td class="v">– ${fmtUSD(b.discountCents)}</td></tr>` : ''}
        <tr><td class="k">Total Paid</td><td class="v">${fmtUSD(b.amountPaidCents)}</td></tr>
      </table>
      <div class="paidbar"><span class="lbl">Balance Due</span><span class="amt">${fmtUSD(balanceDueCents(b))}</span></div>

      ${reviewSection}

      <div style="margin-top:22px;background:#0b0b0c;border-radius:12px;padding:20px;text-align:center;color:#fff">
        <p style="margin:0 0 6px;font-size:16px;font-weight:800">Thanks — here&apos;s 10% off your next job</p>
        ${b.loyaltyCode
          ? `<p style="margin:0 0 12px;font-size:13px;color:#b5b7bd;line-height:1.55">Use this code for <strong style="color:#fff">10% off</strong> your next booking — or share it with a friend for their first job.</p>
             <p style="margin:0;display:inline-block;background:#E0002A;color:#fff;font-weight:800;letter-spacing:2px;font-size:18px;padding:10px 20px;border-radius:8px">${esc(b.loyaltyCode)}</p>
             <p style="margin:10px 0 0;font-size:12px;color:#888">Enter it on your booking page, or mention it when you call (817) 909-4312.</p>`
          : `<p style="margin:0;font-size:13px;color:#b5b7bd;line-height:1.55">Refer a friend and ask us about 10% off your next service. Text us at (817) 909-4312.</p>`}
      </div>
    </div>
    <div class="ft">J Kiss LLC · (817) 909-4312 · info@jkissllc.com · US DOT 3484556 / MC 01155352 · Generated ${fmtTs(Date.now())}</div>
  </div>
  ${reviewScript}
</body></html>`

  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
