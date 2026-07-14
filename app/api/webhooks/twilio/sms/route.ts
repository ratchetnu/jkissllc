// Inbound SMS webhook (Twilio). A customer texting back to our number lands here.
// We verify the signature, dedupe retries, match the sender to a booking, store the
// message (unread) in the communications log, pause that booking's nagging reminders,
// handle STOP/START opt-out, and alert the owner. Mirrors the Stripe webhook: nodejs
// runtime, force-dynamic, and we always 200 so Twilio doesn't hammer retries.
//
// SETUP: in Twilio, set this number's (or Messaging Service's) inbound "A MESSAGE
// COMES IN" webhook to:  https://www.jkissllc.com/api/webhooks/twilio/sms  (POST).
// Set TWILIO_AUTH_TOKEN in the env for signature verification.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { toE164 } from '../../../../lib/sms'
import { verifyTwilioSignature } from '../../../../lib/twilio-webhook'
import { classifyInboundKeyword, helpTwiml, STOP_WORDS, START_WORDS } from '../../../../lib/sms-keywords'
import { listBookings, saveBooking, type Booking } from '../../../../lib/bookings'
import { recordMessage, seenProviderMessage } from '../../../../lib/messages'
import { notifyOwnerOfReply } from '../../../../lib/owner-alerts'
import { redis } from '../../../../lib/redis'
import { withBackgroundTenant } from '../../../../lib/platform/tenancy/request-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Empty TwiML so Twilio doesn't send an auto-reply on its own.
function twiml(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  const form = new URLSearchParams(raw)
  const params: Record<string, string> = {}
  form.forEach((v, k) => { params[k] = v })

  // Verify against the exact URL Twilio is configured to call.
  const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.get('host') ?? 'www.jkissllc.com'}`
  const search = req.nextUrl.search || ''
  const url = `${base}/api/webhooks/twilio/sms${search}`

  // Auth: prefer Twilio signature (needs TWILIO_AUTH_TOKEN); also accept a shared
  // secret in the URL (?key=…) via TWILIO_WEBHOOK_SECRET. At least one should be set
  // in prod so this public endpoint can't be spoofed.
  // Auth: accept EITHER a valid shared secret (?key=…, TWILIO_WEBHOOK_SECRET) OR a
  // valid Twilio signature (TWILIO_AUTH_TOKEN). Either proof is sufficient, so having
  // both configured never makes a genuine Twilio request fail. Fail closed (503) when
  // neither is configured; reject (403) when configured but no proof validates.
  const token = process.env.TWILIO_AUTH_TOKEN
  const secret = process.env.TWILIO_WEBHOOK_SECRET
  if (!token && !secret) {
    console.error('[twilio-sms] fail-closed: neither TWILIO_AUTH_TOKEN nor TWILIO_WEBHOOK_SECRET configured')
    return new NextResponse('webhook not configured', { status: 503 })
  }
  let authed = false
  if (secret) {
    const key = req.nextUrl.searchParams.get('key') ?? ''
    try { if (key.length === secret.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(secret))) authed = true } catch { /* not authed */ }
  }
  if (!authed && token) {
    authed = verifyTwilioSignature(url, params, req.headers.get('x-twilio-signature'))
  }
  if (!authed) { console.warn('[twilio-sms] webhook auth failed'); return new NextResponse('forbidden', { status: 403 }) }

  // HELP / INFO — reply with public support info and return immediately. This never
  // creates a customer record, matches no booking, and triggers no owner/booking
  // workflow (kept out of the tenant/Redis path so it stays a pure auto-reply).
  // STOP/START keep their existing behavior in the tenant block below.
  if (classifyInboundKeyword(params.Body) === 'help') {
    return new NextResponse(helpTwiml(), { status: 200, headers: { 'Content-Type': 'text/xml' } })
  }

  // Tenant-owned work runs inside the resolved tenant context (off → reference
  // tenant, no key change; on → scoped + fail-closed).
  return withBackgroundTenant('webhook', async () => {
  const messageSid = params.MessageSid || params.SmsSid || ''
  const fromRaw = params.From || ''
  const from = toE164(fromRaw) || fromRaw
  const bodyText = (params.Body || '').trim()

  // Idempotency — Twilio may retry the same SID.
  if (messageSid && (await seenProviderMessage(messageSid))) return twiml()

  // STOP / START keyword handling (defense-in-depth alongside Twilio's own opt-out).
  const kw = bodyText.toUpperCase()
  const isStop = STOP_WORDS.has(kw)
  if (from) {
    try {
      if (isStop) await redis.set(`sms:optout:${from}`, '1')
      else if (START_WORDS.has(kw)) await redis.del(`sms:optout:${from}`)
    } catch (e) { console.error('[twilio-sms] optout write failed', e) }
  }

  // Match the sender to the most-recent booking with that phone. Scan is fine at
  // current volume; a phone index can optimize later.
  let booking: Booking | null = null
  if (from) {
    try {
      const all = await listBookings(1000)
      booking = all.find(b => toE164(b.customerPhone) === from) ?? null
    } catch (e) { console.error('[twilio-sms] booking match failed', e) }
  }

  // Store the inbound message (unread) — even when unmatched, so nothing is lost.
  try {
    await recordMessage({
      direction: 'inbound', channel: 'sms', provider: 'twilio',
      providerMessageId: messageSid || undefined,
      from, to: params.To, body: bodyText || '(no text)',
      customerPhone: from || undefined,
      customerName: booking?.customerName,
      customerEmail: booking?.customerEmail,
      bookingToken: booking?.token,
      bookingNumber: booking?.bookingNumber,
      tags: isStop ? ['opt-out'] : undefined,
    })
  } catch (e) { console.error('[twilio-sms] store failed', e) }

  // Pause nagging reminders — the customer is engaging (but not on a STOP).
  if (booking && !isStop) {
    try {
      booking.automationPaused = true
      booking.lastCustomerReplyAt = Date.now()
      booking.updatedAt = Date.now()
      await saveBooking(booking)
    } catch (e) { console.error('[twilio-sms] pause failed', e) }
  }

  // Alert the owner.
  try {
    await notifyOwnerOfReply({
      via: 'text',
      customerName: booking?.customerName,
      fromPhone: from || fromRaw,
      bookingNumber: booking?.bookingNumber,
      preview: bodyText || '(no text)',
      adminUrl: `${base}/admin/inbox`,
    })
  } catch (e) { console.error('[twilio-sms] owner alert failed', e) }

  return twiml()
  })
}
