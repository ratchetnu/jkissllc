import { NextRequest, NextResponse } from 'next/server'
import { COMPANY } from '../../../../lib/company'
import { requirePermission } from '../../_lib/session'
import { getBookingByToken, balanceDueCents, fmtUSD, SERVICE_LABELS } from '../../../../lib/bookings'
import { runAiTask } from '../../../../lib/ai/service'

export const maxDuration = 30

const INTENTS: Record<string, string> = {
  followup: 'a friendly follow-up checking if they have questions and nudging them to confirm/pay',
  reminder: 'a polite reminder about their upcoming service and any balance due',
  thanks: 'a warm thank-you after the job, inviting a review',
  reschedule: 'a helpful note offering to reschedule and asking for a better date',
  cancellation: 'a sincere apology that, due to unforeseen scheduling issues and the driver being unavailable, the job must be cancelled for now, expressing regret and an eagerness to reschedule as soon as possible, and inviting them to email ' + COMPANY.email + ' if they need any further help (do NOT include a phone number)',
  custom: 'a helpful, professional message',
}

// POST /api/admin/ai/message — drafts a short SMS/email message to a customer.
export async function POST(req: NextRequest) {
  const who = await requirePermission(req, 'ai:use')
  if (who instanceof NextResponse) return who
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
  const result = await runAiTask({
    taskId: 'ops.message', feature: 'ops.message', requiredPermission: 'ai:use',
    principal: { sub: who.sub, role: who.role },
    vars: { intentInstruction: INTENTS[intent], ctxJson: JSON.stringify(ctx), extra },
    maxOutputTokens: 250, temperature: 0.6, requestChars: extra.length,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, message: result.text })
}
