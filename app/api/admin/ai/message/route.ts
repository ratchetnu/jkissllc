import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import { getBookingByToken, balanceDueCents, fmtUSD, SERVICE_LABELS } from '../../../../lib/bookings'
import { aiText } from '../../../../lib/ai'

export const maxDuration = 30

const INTENTS: Record<string, string> = {
  followup: 'a friendly follow-up checking if they have questions and nudging them to confirm/pay',
  reminder: 'a polite reminder about their upcoming service and any balance due',
  thanks: 'a warm thank-you after the job, inviting a review',
  reschedule: 'a helpful note offering to reschedule and asking for a better date',
  cancellation: 'a sincere apology that, due to unforeseen scheduling issues and the driver being unavailable, the job must be cancelled for now, expressing regret and an eagerness to reschedule as soon as possible, and inviting them to email info@jkissllc.com if they need any further help (do NOT include a phone number)',
  custom: 'a helpful, professional message',
}

// POST /api/admin/ai/message — drafts a short SMS/email message to a customer.
export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const b = await getBookingByToken(String(body.token ?? ''))
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const intent = INTENTS[body.intent] ? String(body.intent) : 'custom'
  const extra = typeof body.note === 'string' ? body.note.slice(0, 300) : ''

  const ctx = {
    customer: b.customerName,
    service: SERVICE_LABELS[b.serviceType] ?? b.serviceType,
    date: b.selectedDate || (b.availableDates?.[0] ?? 'not yet scheduled'),
    window: b.selectedWindow ?? '',
    balanceDue: fmtUSD(balanceDueCents(b)),
    status: b.status,
    bookingNumber: b.bookingNumber,
  }
  const r = await aiText({
    system: 'You write short, warm, professional customer messages for J Kiss LLC (a DFW box-truck delivery, junk-removal, and property-cleanout company), ready to send as a text or email. First-name basis, no greeting-card fluff, no placeholders/brackets. Sign off as "— J Kiss LLC". Keep under 65 words. Use only the facts provided. Output only the message.',
    prompt: `Write ${INTENTS[intent]}.\n\nBooking facts (JSON): ${JSON.stringify(ctx)}\n${extra ? `Owner's extra instruction: ${extra}` : ''}`,
    maxOutputTokens: 250,
    temperature: 0.6,
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 })
  return NextResponse.json({ ok: true, message: r.text })
}
