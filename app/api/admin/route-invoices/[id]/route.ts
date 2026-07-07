import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import {
  getInvoiceByToken, saveInvoice, deleteInvoice, voidInvoice, subtotalCents,
  type InvoiceLine,
} from '../../../../lib/route-invoices'
import { emailRaw, siteUrl } from '../../../../lib/booking-emails'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const cents = (v: unknown): number => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0 }
const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmtDate = (iso?: string) => { if (!iso) return ''; const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }

function sanitizeLines(v: unknown): InvoiceLine[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, 200).map((raw): InvoiceLine => {
    const l = raw as Record<string, unknown>
    return {
      routeToken: typeof l.routeToken === 'string' ? l.routeToken : undefined,
      routeNumber: typeof l.routeNumber === 'string' ? l.routeNumber.slice(0, 40) : undefined,
      routeDate: typeof l.routeDate === 'string' ? l.routeDate.slice(0, 10) : undefined,
      description: S(l.description, 200) || 'Item',
      amountCents: cents(l.amountCents),
    }
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const inv = await getInvoiceByToken(id)
  if (!inv) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 })

  const b = await req.json().catch(() => ({}))
  const action = S(b.action, 40)

  if (action === 'update') {
    if (inv.status === 'paid') return NextResponse.json({ error: 'A paid invoice can’t be edited.' }, { status: 409 })
    if (b.lines !== undefined) inv.lines = sanitizeLines(b.lines)
    if (b.clientName !== undefined) inv.clientName = S(b.clientName, 160) || undefined
    if (b.clientEmail !== undefined) inv.clientEmail = S(b.clientEmail, 200) || undefined
    if (b.notes !== undefined) inv.notes = S(b.notes, 1000) || undefined
    await saveInvoice(inv)
    return NextResponse.json({ ok: true, invoice: inv })
  }

  if (action === 'send') {
    if (!inv.clientEmail) return NextResponse.json({ error: 'Add a client email before sending.' }, { status: 400 })
    if (!inv.lines.length) return NextResponse.json({ error: 'Add at least one line item before sending.' }, { status: 400 })
    const total = subtotalCents(inv)
    const url = `${siteUrl()}/invoice/${inv.token}`
    const rows = inv.lines.map(l =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(fmtDate(l.routeDate))}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.description)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${money(l.amountCents)}</td></tr>`).join('')
    const html =
      `<p style="font-size:15px;margin:0 0 4px">Invoice <strong>${esc(inv.invoiceNumber)}</strong> from J Kiss LLC</p>` +
      `<p style="margin:0 0 14px;color:#555">${esc(inv.clientName || inv.businessName)}</p>` +
      `<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr>` +
      `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;color:#777">Date</th>` +
      `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;color:#777">Description</th>` +
      `<th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd;color:#777">Amount</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<p style="text-align:right;font-size:18px;font-weight:800;margin:14px 0 0">Total: ${money(total)}</p>` +
      (inv.notes ? `<p style="color:#555;margin:12px 0 0">${esc(inv.notes)}</p>` : '') +
      `<p style="margin:20px 0 0"><a href="${url}" style="background:#e5233a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700">View &amp; pay invoice →</a></p>`
    try { await emailRaw({ to: [inv.clientEmail], subject: `Invoice ${inv.invoiceNumber} from J Kiss LLC — ${money(total)}`, html }) }
    catch (e) { console.error('[invoice send]', e); return NextResponse.json({ error: 'Could not send the email — try again.' }, { status: 502 }) }
    if (inv.status === 'draft') inv.status = 'sent'
    inv.sentAt = Date.now()
    await saveInvoice(inv)
    return NextResponse.json({ ok: true, invoice: inv })
  }

  if (action === 'mark_paid') {
    inv.amountPaidCents = subtotalCents(inv)
    inv.status = 'paid'
    inv.paidAt = Date.now()
    inv.paidMethod = 'manual'
    await saveInvoice(inv)
    return NextResponse.json({ ok: true, invoice: inv })
  }

  if (action === 'void') {
    await voidInvoice(inv)
    return NextResponse.json({ ok: true, invoice: inv })
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  await deleteInvoice(id)
  return NextResponse.json({ ok: true })
}
