// Inbound EMAIL webhook. Customer email replies (to info@jkissllc.com) are pushed
// here by a forwarder — either the Google Apps Script in scripts/gmail-reply-forwarder.gs
// (Workspace) or an inbound-parse service. We match to a booking (by the JK-* number in
// the subject, else by the sender's email), store unread, pause nagging reminders, and
// alert the owner. Mirrors the SMS webhook.
//
// SETUP: protect with EMAIL_WEBHOOK_SECRET and have the forwarder POST to:
//   https://www.jkissllc.com/api/webhooks/email?key=YOUR_SECRET

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { listBookings, saveBooking, getBookingByNumber, type Booking } from '../../../lib/bookings'
import { recordMessage, seenProviderMessage } from '../../../lib/messages'
import { notifyOwnerOfReply } from '../../../lib/owner-alerts'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// "Name <addr@x.com>" -> "addr@x.com"
function extractEmail(s: string): string {
  const m = (s || '').match(/<([^>]+)>/)
  return (m ? m[1] : s || '').trim().toLowerCase()
}

export async function POST(req: NextRequest) {
  // Shared-secret auth — the forwarder appends ?key=…
  const secret = process.env.EMAIL_WEBHOOK_SECRET
  if (secret) {
    const key = req.nextUrl.searchParams.get('key') ?? ''
    try {
      if (!(key.length === secret.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(secret)))) {
        return new NextResponse('forbidden', { status: 403 })
      }
    } catch { return new NextResponse('forbidden', { status: 403 }) }
  } else {
    // Fail closed: reject when the shared secret is not configured rather than
    // accepting an unauthenticated inbound webhook (previously it warned and continued).
    console.error('[email-webhook] fail-closed: EMAIL_WEBHOOK_SECRET not configured')
    return new NextResponse('webhook not configured', { status: 503 })
  }

  // Tenant-owned work runs inside the resolved tenant context (off → reference
  // tenant, no key change; on → scoped + fail-closed).
  return withBackgroundTenant('webhook', async () => {
  // Accept JSON (Apps Script) or form-encoded (parse services).
  let p: Record<string, string> = {}
  try {
    if ((req.headers.get('content-type') || '').includes('application/json')) {
      p = (await req.json()) as Record<string, string>
    } else {
      const form = new URLSearchParams(await req.text())
      form.forEach((v, k) => { p[k] = v })
    }
  } catch { /* tolerate malformed bodies */ }

  const fromRaw = p.from || p.From || p.sender || ''
  const from = extractEmail(fromRaw)
  const subject = (p.subject || p.Subject || '').toString()
  const text = (p.text || p.plain || p['stripped-text'] || p.body || '').toString().trim()
  const messageId = (p.messageId || p['Message-Id'] || p.message_id || '').toString()

  if (!from && !text) return NextResponse.json({ ok: true, skipped: 'empty' })
  if (messageId && (await seenProviderMessage(messageId))) return NextResponse.json({ ok: true, dedup: true })

  // Match: the JK-* booking number in the subject (most reliable, survives the thread),
  // then fall back to the sender's email address.
  let booking: Booking | null = null
  const num = subject.match(/JK-[A-Z]-?\d+/i)
  if (num) { try { booking = await getBookingByNumber(num[0].toUpperCase().replace(/\s/g, '')) } catch { /* ignore */ } }
  if (!booking && from) {
    try {
      const all = await listBookings(1000)
      booking = all.find(b => (b.customerEmail || '').toLowerCase() === from) ?? null
    } catch (e) { console.error('[email-webhook] match failed', e) }
  }

  try {
    await recordMessage({
      direction: 'inbound', channel: 'email', provider: 'gmail',
      providerMessageId: messageId || undefined,
      from, to: p.to || p.To, subject, body: text || '(no text)',
      customerEmail: from || undefined,
      customerName: booking?.customerName, customerPhone: booking?.customerPhone,
      bookingToken: booking?.token, bookingNumber: booking?.bookingNumber,
    })
  } catch (e) { console.error('[email-webhook] store failed', e) }

  if (booking) {
    try {
      booking.automationPaused = true
      booking.lastCustomerReplyAt = Date.now()
      booking.updatedAt = Date.now()
      await saveBooking(booking)
    } catch (e) { console.error('[email-webhook] pause failed', e) }
  }

  try {
    const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.get('host') ?? 'www.jkissllc.com'}`
    await notifyOwnerOfReply({
      via: 'email', customerName: booking?.customerName, fromEmail: from || fromRaw,
      bookingNumber: booking?.bookingNumber, preview: text || subject || '(no text)',
      adminUrl: `${base}/admin/inbox`,
    })
  } catch (e) { console.error('[email-webhook] owner alert failed', e) }

  return NextResponse.json({ ok: true, matched: !!booking })
  })
}
