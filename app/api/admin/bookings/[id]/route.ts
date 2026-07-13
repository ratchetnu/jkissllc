import { NextRequest, NextResponse } from 'next/server'
import { requireSession, getPrincipal } from '../../_lib/session'
import { can } from '../../../../lib/rbac'
import {
  getBookingByToken, saveBooking, deleteBooking, recompute, balanceDueCents, dollarsToCents,
  paymentSummaryStatus, sanitizePhotos, pushBookingEvent, generateToken, setInfoRequestToken,
  SERVICE_TYPES, type Booking, type ServiceType, type Payment, type PaymentMethod, type PaymentType,
  type BookingStatus,
} from '../../../../lib/bookings'
import { notifyCustomerZelleRejected, resendOwnerNotification, notifyOwnerAiOutcome } from '../../../../lib/booking-notify'
import { processAiJob, enqueueAiJob, supportsPhotoAi, photoVersion } from '../../../../lib/book-now-ai'
import { submitConfirmation, processFinalAiJob, enqueueFinalAiJob } from '../../../../lib/book-now-confirmation'
import { INFO_REQUEST_FIELD_LABEL, type InfoRequest, type InfoRequestField } from '../../../../lib/bookings'
import { currentTenantId } from '../../../../lib/platform/tenancy/context'
import { getPolicyVersion, getCurrentPolicy } from '../../../../lib/policy'
import { sendConfirmationLink, notifyJobCompleted, notifyBookingConfirmed, notifyPaidInFull, notifyContinuation, notifyCustomerMessage } from '../../../../lib/notify'
import { emailOpsPaymentReceived, emailPaymentReceiptCustomer, emailRefundCustomer, bookingLink, siteUrl } from '../../../../lib/booking-emails'
import { str, strList, num } from '../../../../lib/validators'
import { sendSmsDetailed, getSmsStatus, toE164 } from '../../../../lib/sms'
import { recordMessage } from '../../../../lib/messages'
import { ensureLoyaltyCode } from '../../../../lib/promo'
import { getStripe, stripeConfigured } from '../../../../lib/stripe'
import { getDisposalSettings } from '../../../../lib/disposal'
import { getCalibration } from '../../../../lib/job-learning'
import { decideQuote } from '../../../../lib/pricing/quote-decision'
import { onEstimateModified } from '../../../../lib/intake-workflow'
import { validateEstimateModification } from '../../../../lib/estimate-modify'

export const runtime = 'nodejs'

const METHODS: PaymentMethod[] = ['stripe', 'zelle', 'apple_cash', 'cash', 'other']

function addConfirmedPayment(b: Booking, p: { amountCents: number; method: PaymentMethod; type: PaymentType; note?: string; reference?: string }): Payment {
  const now = Date.now()
  const payment: Payment = {
    id: crypto.randomUUID(),
    type: p.type, method: p.method, status: 'confirmed',
    amountCents: p.amountCents, feeCents: 0, totalChargedCents: p.amountCents, netCents: p.amountCents,
    note: p.note, reference: p.reference,
    createdAt: now, confirmedAt: now,
  }
  b.payments.push(payment)
  return payment
}

// GET — full booking (admin sees everything: payments, internal notes, the IP /
// UA agreement audit trail) plus the exact accepted policy text for evidence.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const b = await getBookingByToken(id)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const policy = b.agreementPolicyVersion
    ? (await getPolicyVersion(b.agreementPolicyVersion)) ?? (await getCurrentPolicy())
    : null
  return NextResponse.json({ booking: b, acceptedPolicy: policy })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  await deleteBooking(id)
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const b = await getBookingByToken(id)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action: string = body.action ?? 'update'
  const who = await getPrincipal(req)
  const actor = who?.sub || 'admin'

  // Sandbox comms safety: a test record never sends automatic customer messages.
  // An owner may still force one with an explicit confirmTest flag.
  const OUTBOUND_COMMS = new Set(['send-link', 'send-receipt', 'send-continuation', 'send-message', 'resend-notification'])
  if (b.isTest && OUTBOUND_COMMS.has(action) && body.confirmTest !== true) {
    return NextResponse.json({ error: 'This is a SANDBOX test record — outbound customer communication is blocked. Confirm explicitly to override.' }, { status: 400 })
  }

  const wasConfirmed = b.status === 'confirmed'
  const wasPaidInFull = paymentSummaryStatus(b) === 'paid_in_full'
  let extra: Record<string, unknown> = {}
  let refundedNowCents = 0
  let rejectReplacementUrl: string | undefined
  let rejectReason: string | undefined

  switch (action) {
    case 'update': {
      const f = body.fields ?? body
      if (str(f.customerName, 200)) b.customerName = str(f.customerName, 200)!
      if ('customerPhone' in f) b.customerPhone = str(f.customerPhone, 40)
      if ('customerEmail' in f) b.customerEmail = str(f.customerEmail, 200)
      if ('invoiceNumber' in f) b.invoiceNumber = str(f.invoiceNumber, 60)
      if ('invoiceDate' in f) b.invoiceDate = str(f.invoiceDate, 40)
      if (f.serviceType && SERVICE_TYPES.includes(f.serviceType)) b.serviceType = f.serviceType as ServiceType
      if ('pickupAddress' in f) b.pickupAddress = str(f.pickupAddress, 300)
      if ('dropoffAddress' in f) b.dropoffAddress = str(f.dropoffAddress, 300)
      if ('jobSiteAddress' in f) b.jobSiteAddress = str(f.jobSiteAddress, 300)
      if ('description' in f) b.description = str(f.description, 2000)
      if ('items' in f) b.items = strList(f.items, 80)
      if ('invoicePhotos' in f) b.invoicePhotos = sanitizePhotos(f.invoicePhotos)
      if ('invoiceAmount' in f) b.invoiceAmountCents = dollarsToCents(f.invoiceAmount)
      if ('discountAmount' in f) b.discountCents = dollarsToCents(f.discountAmount) || undefined
      if ('depositAmount' in f) b.depositAmountCents = dollarsToCents(f.depositAmount)
      if ('crewSize' in f) b.crewSize = num(f.crewSize)
      if ('estimatedHours' in f) b.estimatedHours = num(f.estimatedHours)
      if ('availableDates' in f) b.availableDates = strList(f.availableDates, 60)
      if ('availableWindows' in f) b.availableWindows = strList(f.availableWindows, 20)
      if ('selectedDate' in f) b.selectedDate = str(f.selectedDate, 20)
      if ('selectedWindow' in f) b.selectedWindow = str(f.selectedWindow, 40)
      if ('internalNotes' in f) b.internalNotes = str(f.internalNotes, 2000)
      if ('assignedTo' in f) b.assignedTo = str(f.assignedTo, 80)
      if ('assignedHelper' in f) b.assignedHelper = str(f.assignedHelper, 80)
      if ('disposalEstimate' in f) b.disposalEstimateCents = dollarsToCents(f.disposalEstimate) || undefined
      if ('disposalActual' in f) b.disposalActualCents = dollarsToCents(f.disposalActual) || undefined
      if ('collectInPerson' in f) b.collectInPerson = f.collectInPerson === true || f.collectInPerson === 'true' || f.collectInPerson === 'on'
      if (f.status && STATUS_SET[f.status as BookingStatus]) {
        b.status = f.status as BookingStatus
        // Stamp lifecycle timestamps so the timeline + reporting stay accurate.
        if ((b.status === 'completed' || b.status === 'partially_completed') && !b.completedAt) b.completedAt = Date.now()
        if ((b.status === 'cancelled' || b.status === 'could_not_complete' || b.status === 'refunded') && !b.cancelledAt) b.cancelledAt = Date.now()
      }
      break
    }
    case 'send-link': {
      const channels = await sendConfirmationLink(b)
      b.confirmationLinkSentAt = Date.now()
      b.confirmationLinkSentBy = 'admin'
      if (['quote_received', 'pending_payment', 'payment_received', 'booking_created'].includes(b.status)) {
        b.status = 'confirmation_link_sent'
      }
      extra = { channels }
      break
    }
    case 'confirm-payment': {
      // Confirm a customer-reported (pending) manual payment.
      const p = b.payments.find(x => x.id === body.paymentId)
      if (!p) return NextResponse.json({ error: 'payment not found' }, { status: 404 })
      if (p.status === 'confirmed') return NextResponse.json({ error: 'Already confirmed.' }, { status: 400 })
      p.status = 'confirmed'
      p.confirmedAt = Date.now()
      if (str(body.note, 500)) p.note = `${p.note ? p.note + ' · ' : ''}${str(body.note, 500)}`
      pushBookingEvent(b, { actor, action: 'zelle.approved', result: 'confirmed', meta: { paymentId: p.id, method: p.method } })
      await sendReceipts(b, p)
      break
    }
    case 'approve-zelle': {
      // Owner/Admin only — verify a Zelle proof and confirm the deposit.
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      const p = b.payments.find(x => x.id === body.paymentId && x.method === 'zelle')
      if (!p) return NextResponse.json({ error: 'Zelle payment not found' }, { status: 404 })
      if (p.status === 'confirmed') return NextResponse.json({ error: 'Already confirmed.' }, { status: 400 })
      p.status = 'confirmed'
      p.confirmedAt = Date.now()
      p.reviewedBy = actor
      p.reviewedAt = Date.now()
      pushBookingEvent(b, { actor, action: 'zelle.approved', result: 'confirmed', meta: { paymentId: p.id, amountCents: p.amountCents } })
      pushBookingEvent(b, { actor, action: 'booking.confirmed', meta: { via: 'zelle' } })
      await sendReceipts(b, p)
      break
    }
    case 'reject-zelle': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      const p = b.payments.find(x => x.id === body.paymentId && x.method === 'zelle')
      if (!p) return NextResponse.json({ error: 'Zelle payment not found' }, { status: 404 })
      if (p.status === 'confirmed') return NextResponse.json({ error: 'That payment is already confirmed.' }, { status: 400 })
      rejectReason = str(body.reason, 300) || 'The screenshot could not be verified.'
      p.status = 'failed'
      p.reviewedBy = actor
      p.reviewedAt = Date.now()
      p.rejectionReason = rejectReason
      // Keep the rejected proof for audit; issue a one-time replacement-upload grant.
      const rtoken = generateToken()
      b.replacementUpload = { token: rtoken, paymentId: p.id, at: Date.now() }
      rejectReplacementUrl = `${siteUrl()}/booking/${b.token}?replace=${rtoken}`
      pushBookingEvent(b, { actor, action: 'zelle.rejected', result: rejectReason, meta: { paymentId: p.id } })
      break
    }
    case 'resend-notification': {
      // Owner-triggered re-alert. 'new_submission' re-sends the Book Now request
      // alert (no payment needed) — the recovery path for a silently-missed lead.
      const kind =
        body.kind === 'new_confirmed_booking' ? 'new_confirmed_booking'
        : body.kind === 'new_submission' ? 'new_submission'
        : 'zelle_review'
      const p = kind === 'zelle_review'
        ? b.payments.find(x => x.method === 'zelle' && x.status === 'sent_by_customer')
        : kind === 'new_confirmed_booking'
        ? [...b.payments].reverse().find(x => x.status === 'confirmed')
        : undefined
      const r = await resendOwnerNotification(b, kind, p)
      pushBookingEvent(b, { actor, action: 'notification.resent', result: r.sent ? 'sent' : 'failed', meta: { kind } })
      extra = { resent: r.sent }
      break
    }

    // ── Durable server-side AI processing controls (owner-only) ──────────────
    // run-ai / retry-ai run the analysis→pricing chain on the STORED photos (no
    // customer resubmit). They call processAiJob, which loads+saves its own copy,
    // so we RETURN here rather than fall through to the trailing save (which would
    // clobber the attached estimate with this stale record).
    case 'run-ai':
    case 'retry-ai': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      if (!supportsPhotoAi(b)) return NextResponse.json({ error: 'This service is not photo-estimated.' }, { status: 400 })
      if (photoVersion(b) === 0) return NextResponse.json({ error: 'No stored photos to analyze.' }, { status: 400 })
      let tenantId: string | undefined
      try { tenantId = currentTenantId() } catch { /* ignore */ }
      // Force a fresh, full-budget attempt from the stored photos.
      enqueueAiJob(b, { force: true, initiatedBy: actor, tenantId })
      if (b.aiJob) b.aiJob.attempts = 0
      await saveBooking(b)
      const result = await processAiJob(id, { initiatedBy: actor, tenantId })
      const nb = await getBookingByToken(id)
      if (nb && (result.status === 'completed' || result.status === 'manual_review' || result.status === 'failed')) {
        try { await notifyOwnerAiOutcome(nb, result.status) } catch (e) { console.error('[run-ai notify]', e) }
      }
      return NextResponse.json({ ok: true, booking: nb ?? b, aiJob: nb?.aiJob, result })
    }

    case 'cancel-ai': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      if (!b.aiJob || (b.aiJob.status !== 'queued' && b.aiJob.status !== 'retrying')) {
        return NextResponse.json({ error: 'No pending AI job to cancel.' }, { status: 400 })
      }
      b.aiJob = { ...b.aiJob, status: 'not_started', nextRetryAt: undefined, updatedAt: Date.now() }
      pushBookingEvent(b, { actor, action: 'ai.failed', result: 'cancelled', meta: { by: actor } })
      break
    }

    case 'send-manual-review': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      const pv = photoVersion(b)
      b.aiJob = {
        status: 'manual_review',
        idempotencyKey: b.aiJob?.idempotencyKey ?? `book-now-ai:manual:${b.token}:${pv}`,
        photoVersion: pv, attempts: b.aiJob?.attempts ?? 0,
        initiatedBy: actor, updatedAt: Date.now(),
      }
      pushBookingEvent(b, { actor, action: 'ai.manual_review', result: 'owner', meta: { by: actor } })
      break
    }

    // ── Guided-confirmation FINAL analysis controls (owner-only). Like run-ai,
    // these load+save their own copy via processFinalAiJob, so RETURN early. ────
    case 'run-final-ai':
    case 'retry-final-ai': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      if (!b.confirmation) return NextResponse.json({ error: 'No customer confirmation to analyze. Request or enter the confirmation first.' }, { status: 400 })
      let tenantId: string | undefined
      try { tenantId = currentTenantId() } catch { /* ignore */ }
      enqueueFinalAiJob(b, { force: true, initiatedBy: actor, tenantId })
      if (b.finalAiJob) b.finalAiJob.attempts = 0
      await saveBooking(b)
      const result = await processFinalAiJob(id, { initiatedBy: actor, tenantId })
      const nb = await getBookingByToken(id)
      if (nb && (result.status === 'completed' || result.status === 'manual_review' || result.status === 'failed')) {
        try { await notifyOwnerAiOutcome(nb, result.status) } catch (e) { console.error('[run-final-ai notify]', e) }
      }
      return NextResponse.json({ ok: true, booking: nb ?? b, finalAiJob: nb?.finalAiJob, result })
    }

    case 'final-manual-review': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      b.finalAiJob = {
        status: 'manual_review',
        idempotencyKey: b.finalAiJob?.idempotencyKey ?? `book-now-final:manual:${b.token}:${b.confirmation?.confirmationVersion ?? 0}`,
        photoVersion: b.invoicePhotos?.length ?? 0, attempts: b.finalAiJob?.attempts ?? 0,
        initiatedBy: actor, updatedAt: Date.now(),
      }
      pushBookingEvent(b, { actor, action: 'ai.final_manual_review', result: 'owner', meta: { by: actor } })
      break
    }

    // ── Owner edits the confirmed inventory. Creates a NEW confirmation version
    // (submittedBy owner) so the original customer read is preserved in history +
    // item-level provenance, then re-runs the durable final analysis. Returns early. ─
    case 'edit-confirmed-inventory': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      if (!Array.isArray(body.items)) return NextResponse.json({ error: 'items[] required.' }, { status: 400 })
      const existing = b.confirmation
      // Deterministic idempotency key so an owner double-click doesn't create two
      // versions + two final runs (submitConfirmation dedups on this key).
      const itemsSig = (body.items as unknown[]).map((it) => {
        const o = (it ?? {}) as Record<string, unknown>
        return `${String(o.id ?? '')}:${String(o.category ?? '')}:${String(o.quantity ?? '')}:${o.removed ? 1 : 0}`
      }).join('|').slice(0, 200)
      const raw = {
        items: body.items,
        accessConditions: existing?.accessConditions ?? {},
        disclosures: existing?.disclosures ?? {},
        photoQuality: existing?.photoQuality ?? {},
        estate: existing?.estate,
        followUpAnswers: existing?.followUpAnswers ?? [],
        attestation: existing?.attestation,
        idempotencyKey: `owner-edit:${actor}:${(body.items as unknown[]).length}:${itemsSig}`,
      }
      let tenantId: string | undefined
      try { tenantId = currentTenantId() } catch { /* ignore */ }
      const sub = await submitConfirmation(id, raw, { submittedBy: 'owner', initiatedBy: actor, tenantId })
      if (!sub.ok) return NextResponse.json({ error: 'Could not save the edited inventory.' }, { status: 400 })
      const result = await processFinalAiJob(id, { initiatedBy: actor, tenantId })
      const nb = await getBookingByToken(id)
      return NextResponse.json({ ok: true, booking: nb ?? b, result })
    }

    // ── Approve the FINAL estimate and set the quote from it (owner approval,
    // recorded). Optionally sends the customer their confirmation link. ─────────
    case 'approve-final': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      if (!b.finalAiEstimate) return NextResponse.json({ error: 'No final estimate to approve.' }, { status: 400 })
      const overrideUsd = Math.round(num(body.amount) ?? 0)
      const approvedUsd = overrideUsd > 0 ? overrideUsd : b.finalAiEstimate.pricing.recommendedUsd
      b.invoiceAmountCents = approvedUsd * 100
      if (b.depositAmountCents <= 0) b.depositAmountCents = Math.min(approvedUsd * 100, Math.max(5000, Math.round(approvedUsd * 100 * 0.2)))
      pushBookingEvent(b, { actor, action: 'ai.owner_approved', result: `$${approvedUsd}`, meta: { approvedUsd, tier: b.finalAiEstimate.routingTier, override: overrideUsd > 0 } })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[Final estimate approved by ${actor}] $${approvedUsd}${overrideUsd > 0 ? ' (owner-set)' : ''}`
      if (body.send === true) {
        const channels = await sendConfirmationLink(b)
        if (['quote_received', 'pending_payment', 'payment_received', 'booking_created'].includes(b.status)) b.status = 'confirmation_link_sent'
        extra = { channels }
      } else {
        extra = { confirmLink: bookingLink(b.token) }
      }
      break
    }

    // ── Request more information (Part 13): a secure, single-step clarification.
    // The customer returns via /quote/resume/<token> that opens ONLY the step. ──
    case 'request-info': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Owner/admin only.' }, { status: 403 })
      const rawFields: unknown[] = Array.isArray(body.fields) ? body.fields : []
      const fields = rawFields
        .filter((f): f is InfoRequestField => typeof f === 'string' && f in INFO_REQUEST_FIELD_LABEL)
      if (fields.length === 0) return NextResponse.json({ error: 'Choose at least one thing to request.' }, { status: 400 })
      const reason = str(body.reason, 300) || 'We need a couple more details to finish your quote.'
      const note = str(body.message, 500)
      const rtoken = generateToken()
      const req: InfoRequest = {
        token: rtoken, reason, message: note, fields, requestedBy: actor, sentAt: Date.now(), completed: false,
      }
      // Compose a friendly customer message with the secure resume link.
      const link = `${siteUrl()}/quote/resume/${rtoken}`
      const asked = fields.map(f => INFO_REQUEST_FIELD_LABEL[f]).join(', ')
      const text = `${note || reason} To finish your quote, please add: ${asked}. Continue here (no need to start over): ${link}`
      const channel: 'sms' | 'email' | 'both' = b.customerPhone && b.customerEmail ? 'both' : b.customerPhone ? 'sms' : 'email'
      let channels = { sms: false, email: false }
      if (b.customerPhone || b.customerEmail) {
        try { channels = await notifyCustomerMessage(b, text, channel) } catch (e) { console.error('[request-info notify]', e) }
      }
      req.channels = channels
      b.infoRequest = req
      await setInfoRequestToken(rtoken, b.token)
      pushBookingEvent(b, { actor, action: 'confirmation.requested', result: fields.join(','), meta: { fields, reason, sent: channels.sms || channels.email } })
      extra = { infoRequest: { token: rtoken, link, channels } }
      break
    }
    case 'void-payment': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      // Remove a payment record (e.g. a customer re-reported a payment that was
      // already recorded — confirming it would double-count). Recompute drops it
      // from Amount Paid. Logged to the audit trail for chargeback evidence.
      const idx = b.payments.findIndex(x => x.id === body.paymentId)
      if (idx === -1) return NextResponse.json({ error: 'payment not found' }, { status: 404 })
      const [removed] = b.payments.splice(idx, 1)
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      const why = str(body.reason, 200)
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Voided payment: $${(removed.amountCents / 100).toFixed(2)} · ${removed.method} · ${removed.type} · ${removed.status}${why ? ` — ${why}` : ''}`
      break
    }
    case 'record-payment':
    case 'mark-deposit-paid':
    case 'mark-balance-paid':
    case 'mark-paid-full': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      const method = (METHODS.includes(body.method) ? body.method : 'cash') as PaymentMethod
      const balance = balanceDueCents(b)
      let amountCents: number
      let type: PaymentType
      if (action === 'mark-deposit-paid') {
        amountCents = Math.max(0, Math.min(b.depositAmountCents - b.amountPaidCents, balance)); type = 'deposit'
      } else if (action === 'mark-paid-full') {
        amountCents = balance; type = 'full'
      } else if (action === 'mark-balance-paid') {
        amountCents = balance; type = 'balance'
      } else {
        amountCents = dollarsToCents(body.amount); type = (['deposit', 'balance', 'full', 'partial'].includes(body.type) ? body.type : 'partial')
      }
      if (amountCents <= 0) return NextResponse.json({ error: 'Nothing due / invalid amount.' }, { status: 400 })
      // Block accidental double-entry of the same manual payment (same reference).
      const ref = str(body.reference, 120)
      if (ref && b.payments.some(p => p.reference === ref && p.status === 'confirmed')) {
        return NextResponse.json({ error: `A payment with reference "${ref}" is already recorded.` }, { status: 409 })
      }
      const p = addConfirmedPayment(b, { amountCents, method, type, reference: ref, note: str(body.note, 500) })
      await sendReceipts(b, p)
      break
    }
    case 'send-receipt': {
      // Re-send the final paid receipt link (email + SMS if configured). Useful
      // when SMS isn't available yet and the link must go out manually too.
      if (paymentSummaryStatus(b) !== 'paid_in_full') {
        return NextResponse.json({ error: 'The paid receipt is available once the invoice is paid in full.' }, { status: 400 })
      }
      const channels = await notifyPaidInFull(b)
      extra = { channels }
      break
    }
    case 'mark-in-progress': {
      b.status = 'in_progress'
      break
    }
    case 'continue': {
      // Multi-day job: work started but couldn't finish in one trip — a return is
      // needed. NOT a cancellation: same booking, balance, and payments carry over.
      const prevReturn = b.continuation?.returnDate
      const newReturn = str(body.returnDate, 20)
      const newWindow = str(body.returnWindow, 60)
      // A changed return date/window is a fresh proposal — the customer must
      // re-confirm availability, so clear any prior confirmation/change request.
      const dateChanged = newReturn !== prevReturn || newWindow !== b.continuation?.returnWindow
      b.continuation = {
        continuedAt: b.continuation?.continuedAt || Date.now(),
        originalServiceDate: b.continuation?.originalServiceDate || b.selectedDate || b.availableDates?.[0],
        reason: str(body.reason, 500),
        completedToday: str(body.completedToday, 1000),
        remainingWork: str(body.remainingWork, 1000),
        returnDate: newReturn,
        returnWindow: newWindow,
        customerNotified: body.customerNotified === true || body.customerNotified === 'true',
        customerConfirmedReturn: dateChanged ? false : b.continuation?.customerConfirmedReturn,
        customerConfirmedReturnAt: dateChanged ? undefined : b.continuation?.customerConfirmedReturnAt,
        returnChangeRequest: dateChanged ? undefined : b.continuation?.returnChangeRequest,
        notes: str(body.notes, 1000),
      }
      b.status = 'continued'
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] CONTINUED — return ${b.continuation.returnDate ?? 'TBD'}${b.continuation.reason ? ` · ${b.continuation.reason}` : ''}`
      // Hand the admin a shareable link so they can send it to the customer to
      // confirm the return date right after saving.
      extra = { confirmLink: bookingLink(b.token) }
      break
    }
    case 'send-continuation': {
      // Email/text the customer the continuation message; mark them notified.
      if (!b.continuation) return NextResponse.json({ error: 'Mark the job as Continued first.' }, { status: 400 })
      const channels = await notifyContinuation(b)
      b.continuation.customerNotified = true
      extra = { channels }
      break
    }
    case 'mark-completed': {
      // Guard accounting: a job shouldn't be completed with no invoice total set
      // (e.g. an instant online booking still showing $0 until ops prices it).
      if (b.invoiceAmountCents <= 0) {
        return NextResponse.json({ error: 'Set the final invoice amount before marking this job completed.' }, { status: 400 })
      }
      b.status = 'completed'
      b.completedAt = Date.now()
      break
    }
    case 'cancel': {
      b.status = 'cancelled'
      b.cancelledAt = Date.now()
      if (str(body.reason, 500)) b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[CANCELLED] ${str(body.reason, 500)}`
      break
    }
    case 'send-message': {
      // Owner-composed message to the customer (apology, cancellation heads-up, etc.)
      // over SMS, email, or both. Logged to the booking's communications history.
      const text = str(body.text, 1200)
      const channel = (['sms', 'email', 'both'].includes(body.channel) ? body.channel : 'both') as 'sms' | 'email' | 'both'
      if (!text) return NextResponse.json({ error: 'Message text required.' }, { status: 400 })
      if ((channel === 'sms' || channel === 'both') && !b.customerPhone && channel !== 'both') {
        return NextResponse.json({ error: 'No phone number on file for this customer.' }, { status: 400 })
      }
      if (channel === 'sms' && !b.customerPhone) return NextResponse.json({ error: 'No phone number on file for this customer.' }, { status: 400 })
      if (channel === 'email' && !b.customerEmail) return NextResponse.json({ error: 'No email address on file for this customer.' }, { status: 400 })
      if (channel === 'both' && !b.customerPhone && !b.customerEmail) return NextResponse.json({ error: 'No phone or email on file for this customer.' }, { status: 400 })

      const channels = await notifyCustomerMessage(b, text, channel)
      const ok = !!(channels.sms || channels.email)
      b.communications = [...(b.communications ?? []), {
        at: Date.now(), channel, body: text, by: 'admin',
        sms: channels.sms, email: channels.email, ok,
      }].slice(-100)
      if (!ok) {
        await saveBooking(b)   // persist the failed attempt for the log
        return NextResponse.json({ error: 'Message failed to send — check contact info and that SMS/email are configured.', channels }, { status: 502 })
      }
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      const via = [channels.sms && 'text', channels.email && 'email'].filter(Boolean).join(' + ')
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Messaged customer (${via}): ${text}`
      extra = { channels }
      break
    }
    case 'send-message-tracked': {
      // Like 'send-message' but SMS-only and SID-aware: sends via Twilio
      // (Messaging Service when configured), captures the MessageSid + accept
      // status, logs to the booking communications history + message timeline as
      // an admin-initiated message, and (when pollStatus is set) polls Twilio for
      // the final delivery status. Refuses to re-send an identical message.
      const text = str(body.text, 2000)
      if (!text) return NextResponse.json({ error: 'Message text required.' }, { status: 400 })
      if (!b.customerPhone) return NextResponse.json({ error: 'No phone number on file for this customer.' }, { status: 400 })

      // Duplicate guard — refuse if this exact SMS is already in the log.
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
      if ((b.communications ?? []).some(c => c.channel !== 'email' && norm(c.body) === norm(text))) {
        return NextResponse.json({ error: 'This exact message was already sent for this booking.' }, { status: 409 })
      }

      const sent = await sendSmsDetailed(b.customerPhone, text)
      if (!sent.ok) {
        // Nothing logged on failure — surface the exact Twilio reason.
        return NextResponse.json({ error: `SMS failed: ${sent.error}`, code: sent.code }, { status: 502 })
      }

      const e164 = toE164(b.customerPhone) ?? b.customerPhone
      b.communications = [...(b.communications ?? []), {
        at: Date.now(), channel: 'sms' as const, body: text, by: 'admin', sms: true, ok: true, sid: sent.sid,
      }].slice(-100)
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Messaged customer (text, ${sent.sid}): ${text}`

      try {
        await recordMessage({
          direction: 'outbound', channel: 'sms', provider: 'twilio', providerMessageId: sent.sid,
          to: e164, body: text, customerName: b.customerName, customerPhone: toE164(b.customerPhone) ?? undefined,
          bookingToken: b.token, bookingNumber: b.bookingNumber, status: 'sent', tags: ['admin-message'],
        })
      } catch (e) { console.error('[send-message-tracked] log failed', e) }

      // Optional short server-side poll for the final delivery status.
      let finalStatus = sent.status
      let errorCode: number | null = null
      let errorMessage: string | null = null
      if (body.pollStatus) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2500))
          const s = await getSmsStatus(sent.sid)
          if (!s) break
          finalStatus = s.status; errorCode = s.errorCode; errorMessage = s.errorMessage
          if (['delivered', 'undelivered', 'failed'].includes(finalStatus)) break
        }
      }
      extra = { sms: { sid: sent.sid, acceptStatus: sent.status, finalStatus, errorCode, errorMessage } }
      break
    }
    case 'add-note': {
      const note = str(body.note, 1000)
      if (!note) return NextResponse.json({ error: 'note required' }, { status: 400 })
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] ${note}`
      break
    }
    case 'archive': {
      b.archived = true
      b.archivedAt = Date.now()
      break
    }
    case 'unarchive': {
      b.archived = false
      b.archivedAt = undefined
      break
    }
    // ── Sandbox test-record classification (OWNER only) ──────────────────────
    case 'mark-test':
    case 'unmark-test': {
      if (who?.role !== 'admin') return NextResponse.json({ error: 'Only the owner can manage test records.' }, { status: 403 })
      const on = action === 'mark-test'
      b.isTest = on
      b.testMarkedBy = on ? actor : undefined
      b.testMarkedAt = on ? Date.now() : undefined
      pushBookingEvent(b, { actor, action: on ? 'test.marked' : 'test.unmarked', result: on ? 'sandbox' : 'production' })
      break
    }
    case 'assign': {
      if ('assignedTo' in body) b.assignedTo = str(body.assignedTo, 80)
      if ('assignedHelper' in body) b.assignedHelper = str(body.assignedHelper, 80)
      break
    }
    case 'set-disposal': {
      if ('disposalEstimate' in body) b.disposalEstimateCents = dollarsToCents(body.disposalEstimate) || undefined
      if ('disposalActual' in body) b.disposalActualCents = dollarsToCents(body.disposalActual) || undefined
      break
    }
    case 'refund': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      // One-click Stripe refund for the eligible amount. Records a negative payment
      // so Amount Paid drops, and emails the customer. Zelle/cash refunds are manual.
      const refundCents = dollarsToCents(body.amount)
      if (refundCents <= 0) return NextResponse.json({ error: 'Enter a refund amount.' }, { status: 400 })
      if (!stripeConfigured()) return NextResponse.json({ error: 'Stripe is not configured — refund manually for Zelle/cash.' }, { status: 503 })

      const stripePaid = b.payments.filter(p => p.method === 'stripe' && p.status === 'confirmed' && p.amountCents > 0 && p.stripePaymentIntentId)
      if (stripePaid.length === 0) return NextResponse.json({ error: 'No Stripe payment to refund here — issue Zelle/cash refunds manually and use Void if needed.' }, { status: 400 })
      // Per-intent already-refunded (refund records carry their intent).
      const refundedByIntent = new Map<string, number>()
      for (const p of b.payments) if (p.amountCents < 0 && p.stripePaymentIntentId) refundedByIntent.set(p.stripePaymentIntentId, (refundedByIntent.get(p.stripePaymentIntentId) ?? 0) - p.amountCents)
      const availFor = (p: Payment) => p.amountCents - (refundedByIntent.get(p.stripePaymentIntentId!) ?? 0)
      const maxRefund = stripePaid.reduce((s, p) => s + Math.max(0, availFor(p)), 0)
      if (refundCents > maxRefund) return NextResponse.json({ error: `Max refundable on the Stripe charge${stripePaid.length > 1 ? 's' : ''} is $${(maxRefund / 100).toFixed(2)}.` }, { status: 400 })

      // Split the refund across charges (largest available first).
      const stripe = getStripe()
      let remaining = refundCents
      const ids: string[] = []
      try {
        for (const p of [...stripePaid].sort((a, c) => availFor(c) - availFor(a))) {
          if (remaining <= 0) break
          const amt = Math.min(remaining, Math.max(0, availFor(p)))
          if (amt <= 0) continue
          const refund = await stripe.refunds.create({ payment_intent: p.stripePaymentIntentId!, amount: amt })
          b.payments.push({
            id: crypto.randomUUID(), type: 'partial', method: 'stripe', status: 'confirmed',
            amountCents: -amt, feeCents: 0, totalChargedCents: -amt, netCents: -amt,
            stripePaymentIntentId: p.stripePaymentIntentId,
            note: 'Refund issued (Stripe)', reference: refund.id, createdAt: Date.now(), confirmedAt: Date.now(),
          })
          ids.push(refund.id); remaining -= amt
        }
      } catch (e) {
        console.error('[refund]', e)
        return NextResponse.json({ error: 'Stripe refund failed — check the dashboard and try again.' }, { status: 502 })
      }
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Refunded $${((refundCents - remaining) / 100).toFixed(2)} via Stripe (${ids.join(', ')})`
      extra = { refundIds: ids }
      refundedNowCents = refundCents - remaining
      break
    }
    // ── AI estimate: admin price override (recorded, never silent) ───────────
    case 'ai-override': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      if (!b.aiEstimate) return NextResponse.json({ error: 'No AI estimate on this booking.' }, { status: 400 })
      const overriddenUsd = Math.round(num(body.overriddenUsd) ?? 0)
      const reason = str(body.reason, 500)
      if (overriddenUsd <= 0) return NextResponse.json({ error: 'Enter an override price.' }, { status: 400 })
      if (!reason) return NextResponse.json({ error: 'A reason is required for an override.' }, { status: 400 })
      const originalUsd = b.aiEstimate.override?.overriddenUsd ?? b.aiEstimate.pricing.recommendedUsd
      b.aiEstimate.override = { overriddenUsd, reason, by: actor, at: new Date().toISOString() }
      pushBookingEvent(b, { actor, action: 'ai.override', result: `$${originalUsd}→$${overriddenUsd}`, meta: { originalUsd, overriddenUsd, reason } })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[AI price override by ${actor}] $${originalUsd} → $${overriddenUsd}: ${reason}`
      break
    }
    // ── AI estimate: re-run the deterministic pricing on the stored analysis ──
    // (no new AI call — cheap; picks up pricing-config changes).
    case 'ai-reprice': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      if (!b.aiEstimate?.analysis) return NextResponse.json({ error: 'No stored analysis to re-price.' }, { status: 400 })
      const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
      const d = decideQuote({ analysis: b.aiEstimate.analysis, settings, calibration, serviceType: b.serviceType })
      b.aiEstimate.decision = d.decision
      b.aiEstimate.reviewReasons = d.reviewReasons
      b.aiEstimate.pricing = { recommendedUsd: d.recommendedUsd, lowUsd: d.rangeUsd.low, highUsd: d.rangeUsd.high, breakdown: d.breakdown }
      b.disposalEstimateCents = d.breakdown.disposalCents
      pushBookingEvent(b, { actor, action: 'ai.reprice', result: d.decision, meta: { recommendedUsd: d.recommendedUsd } })
      break
    }
    // ── AI estimate: owner "Modify Estimate" (rich, recorded, never auto-sends) ─
    // Preserves the original analysis + reviewer output; stores the owner's changes
    // as an additive override with a required reason + who/when + an immutable
    // ai.modify timeline event. Does NOT send the quote — that's a separate approve.
    case 'ai-modify': {
      if (!who || !can(who.role, 'invoices:manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      if (!b.aiEstimate) return NextResponse.json({ error: 'No AI estimate on this booking.' }, { status: 400 })
      const reason = str(body.reason, 500) ?? ''
      const overriddenUsd = Math.round(num(body.overriddenUsd) ?? 0)
      const loadMin = num(body.loadMin), loadMax = num(body.loadMax)
      const laborUsd = num(body.laborUsd), disposalUsd = num(body.disposalUsd), trips = num(body.trips)
      const valid = validateEstimateModification({ overriddenUsd, loadMin, loadMax, laborUsd, disposalUsd, trips, reason })
      if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })
      const itemNotes = str(body.itemNotes, 1000) || undefined
      const customerExplanation = str(body.customerExplanation, 1200) || undefined
      const originalUsd = b.aiEstimate.override?.overriddenUsd ?? b.aiEstimate.pricing.recommendedUsd
      b.aiEstimate.override = {
        overriddenUsd, reason, by: actor, at: new Date().toISOString(),
        loadMin, loadMax, laborUsd, disposalUsd,
        trips: trips !== undefined ? Math.round(trips) : undefined,
        itemNotes, customerExplanation,
      }
      pushBookingEvent(b, {
        actor, action: 'ai.modify', result: `$${originalUsd}→$${overriddenUsd}`,
        meta: { originalUsd, overriddenUsd, loadMin, loadMax, laborUsd, disposalUsd, trips, reason },
      })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[Estimate modified by ${actor}] final $${originalUsd} → $${overriddenUsd}: ${reason}`
      try { await onEstimateModified(b, { by: actor, originalUsd, overriddenUsd }) } catch { /* fail-soft */ }
      break
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  if (action !== 'mark-completed' && action !== 'cancel') recompute(b)
  // Confirming a payment locks the booking in: if there's a single scheduled date
  // and the customer hasn't picked one yet, that date becomes the confirmed
  // service date (so it reads "confirmed" everywhere, not "awaiting customer").
  if (!b.selectedDate && b.amountPaidCents > 0 && b.availableDates.length === 1) {
    b.selectedDate = b.availableDates[0]
  }
  // On the transition to paid-in-full, issue a 10%-off loyalty/referral code (once)
  // before persisting so the receipt + email can show it.
  const nowPaidInFull = !wasPaidInFull && paymentSummaryStatus(b) === 'paid_in_full'
  if (nowPaidInFull && !b.loyaltyCode) {
    try { b.loyaltyCode = await ensureLoyaltyCode(b.token, b.bookingNumber, Date.now()) } catch (e) { console.error('[loyalty]', e) }
  }
  await saveBooking(b)

  // Side-effect notifications after persistence.
  if (action === 'reject-zelle' && rejectReplacementUrl && rejectReason) {
    await notifyCustomerZelleRejected(b, rejectReason, rejectReplacementUrl).catch(e => console.error('[reject-zelle notify]', e))
    await saveBooking(b)   // persist the customer-notified event
  }
  if (action === 'refund' && refundedNowCents > 0) await emailRefundCustomer(b, refundedNowCents)
  if (action === 'mark-completed') await notifyJobCompleted(b)
  if (!wasConfirmed && b.status === 'confirmed' && action !== 'send-link') await notifyBookingConfirmed(b)
  // On the transition to paid-in-full, send the customer their final paid receipt
  // link (which carries the optional review prompt + their loyalty code).
  if (nowPaidInFull) await notifyPaidInFull(b)

  return NextResponse.json({ ok: true, booking: b, ...extra })
}

async function sendReceipts(b: Booking, p: Payment): Promise<void> {
  recompute(b)
  await emailOpsPaymentReceived(b, p)
  await emailPaymentReceiptCustomer(b, p)
}

const STATUS_SET: Record<BookingStatus, true> = {
  quote_received: true, pending_payment: true, pending_zelle_verification: true, payment_received: true, booking_created: true,
  confirmation_link_sent: true, customer_viewed: true, time_verification_pending: true,
  time_verified: true, confirmed: true, in_progress: true, continued: true, completed: true,
  partially_completed: true, could_not_complete: true, cancelled: true, refunded: true,
}
