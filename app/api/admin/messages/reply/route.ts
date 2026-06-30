// Admin: reply to a customer from the inbox detail panel. Handles three cases:
//   • matched   — message is linked to a booking → reuse notifyCustomerMessage so
//                  the send + timeline logging matches the booking page exactly.
//   • unmatched — send SMS/email directly to the phone/email on the message and
//                  log an outbound message (no booking link).
//   • note      — internal note (no send); recorded into the thread for context.
// Admin-only. Does not touch webhook/matching logic.

import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import { sendSmsDetailed, toE164 } from '../../../../lib/sms'
import { emailRaw } from '../../../../lib/booking-emails'
import { recordMessage } from '../../../../lib/messages'
import { getBookingByToken, saveBooking } from '../../../../lib/bookings'
import { notifyCustomerMessage } from '../../../../lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))

  const text = (typeof body.text === 'string' ? body.text : '').trim().slice(0, 2000)
  const channel = (['sms', 'email', 'both', 'note'].includes(body.channel) ? body.channel : 'both') as 'sms' | 'email' | 'both' | 'note'
  const bookingToken = typeof body.bookingToken === 'string' ? body.bookingToken : ''
  const phoneIn = typeof body.phone === 'string' ? body.phone : ''
  const emailIn = typeof body.email === 'string' ? body.email : ''
  const customerName = typeof body.customerName === 'string' ? body.customerName : undefined

  if (!text) return NextResponse.json({ error: 'Message text required.' }, { status: 400 })

  // ── Internal note — record into the thread, no send ─────────────────────────
  if (channel === 'note') {
    const bk = bookingToken ? await getBookingByToken(bookingToken).catch(() => null) : null
    const notePhone = toE164(phoneIn) ?? bk?.customerPhone ?? undefined
    await recordMessage({
      direction: 'outbound', channel: 'note', provider: 'manual', body: text,
      customerName: customerName ?? bk?.customerName,
      customerPhone: notePhone,
      customerEmail: emailIn || bk?.customerEmail || undefined,
      bookingToken: bk?.token, bookingNumber: bk?.bookingNumber,
      status: 'sent', tags: ['internal-note'],
    })
    return NextResponse.json({ ok: true, channels: { sms: false, email: false }, note: true })
  }

  // ── Matched — reuse the booking send path (same as booking page) ────────────
  if (bookingToken) {
    const bk = await getBookingByToken(bookingToken)
    if (!bk) return NextResponse.json({ error: 'booking not found' }, { status: 404 })
    if (channel === 'sms' && !bk.customerPhone) return NextResponse.json({ error: 'No phone on file for this customer.' }, { status: 400 })
    if (channel === 'email' && !bk.customerEmail) return NextResponse.json({ error: 'No email on file for this customer.' }, { status: 400 })
    if (channel === 'both' && !bk.customerPhone && !bk.customerEmail) return NextResponse.json({ error: 'No phone or email on file.' }, { status: 400 })

    const channels = await notifyCustomerMessage(bk, text, channel)   // sends + logs to msg timeline
    const ok = !!(channels.sms || channels.email)
    bk.communications = [...(bk.communications ?? []), {
      at: Date.now(), channel, body: text, by: 'admin', sms: channels.sms, email: channels.email, ok,
    }].slice(-100)
    await saveBooking(bk)
    if (!ok) return NextResponse.json({ error: 'Message failed to send — check contact info and that SMS/email are configured.', channels }, { status: 502 })
    return NextResponse.json({ ok: true, channels })
  }

  // ── Unmatched — send directly to the phone/email on the message ─────────────
  const dest = toE164(phoneIn)
  const wantsSms = channel === 'sms' || channel === 'both'
  const wantsEmail = channel === 'email' || channel === 'both'
  const out = { sms: false, email: false }
  let smsErr = ''

  if (wantsSms) {
    if (!dest) { if (channel === 'sms') return NextResponse.json({ error: 'No valid phone number on this message.' }, { status: 400 }) }
    else {
      const r = await sendSmsDetailed(dest, text)
      out.sms = r.ok
      if (!r.ok) smsErr = r.error
    }
  }
  if (wantsEmail) {
    if (!emailIn) { if (channel === 'email') return NextResponse.json({ error: 'No email address on this message.' }, { status: 400 }) }
    else {
      try {
        await emailRaw({
          to: [emailIn],
          subject: 'Message from J KISS LLC',
          html: `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">${esc(text).replace(/\n/g, '<br/>')}<br/><br/><span style="color:#666">— J KISS LLC · (817) 909-4312 · info@jkissllc.com</span></div>`,
        })
        out.email = true
      } catch (e) { console.error('[messages/reply] email failed', e) }
    }
  }

  const ok = out.sms || out.email
  if (ok) {
    try {
      await recordMessage({
        direction: 'outbound', channel: out.sms ? 'sms' : 'email', provider: out.sms ? 'twilio' : 'resend',
        to: out.sms ? (dest ?? phoneIn) : emailIn, body: text,
        customerName, customerPhone: dest ?? undefined, customerEmail: emailIn || undefined,
        status: 'sent', tags: ['admin-message'],
      })
    } catch (e) { console.error('[messages/reply] log failed', e) }
    return NextResponse.json({ ok: true, channels: out })
  }
  return NextResponse.json({ error: smsErr || 'Could not send — no reachable phone/email on this message.', channels: out }, { status: 502 })
}
