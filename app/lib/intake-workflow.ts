// ── Intake workflow orchestration (fail-soft, flag-gated) ────────────────────
//
// The seam between the existing booking flow and the governed platform. Live
// code (persistQuoteRequest, record-payment) calls ONE function per checkpoint;
// this module fans that out into: Customer identity upsert, Lead projection, and
// business events (LeadCreated / QuoteRequested / QuoteGenerated / DepositPaid /
// PaymentReceived / BookingCreated).
//
// Two hard guarantees:
//   • FLAG-GATED — every entry point returns immediately when
//     INTAKE_WORKFLOW_ENABLED is off, so the live flow is byte-identical to today.
//   • FAIL-SOFT — every entry point swallows its own errors; a failure here can
//     never break a customer's quote, booking, or payment.

import { randomUUID } from 'node:crypto'
import { isEnabled } from './platform/flags'
import { publishEvent } from './platform/events/publish'
import { currentTenantId } from './platform/tenancy/context'
import { DEFAULT_TENANT_ID } from './platform/tenancy/types'
import { upsertCustomer } from './customers'
import { projectLead } from './leads'
import { saveApproval, getApproval } from './approvals-store'
import { bumpQuoteGenerated, bumpQuoteAccepted } from './intake-metrics'
import { transition, riskFloorForAction } from './platform/approvals/machine'
import type { ApprovalRequest, RiskClass } from './platform/approvals/types'
import { authorizeWorkerAction } from './platform/ai-workers/governance'
import { getWorker } from './platform/ai-workers/registry'
import type { Role } from './rbac'
import type { StoredAiEstimate } from './ai/estimate-store'
import type { Booking } from './bookings'

// When an AI-drafted quote crosses this recommended amount it always needs owner
// sign-off before it's sent. TODO(Phase 5): source from the tenant's industry pack.
const HIGH_VALUE_USD = 2000

const CUSTOMER_ACTOR = { type: 'system' as const, id: 'public-intake' }
const PAYMENTS_ACTOR = { type: 'system' as const, id: 'payments' }

function tenant(): string {
  try { return currentTenantId() ?? DEFAULT_TENANT_ID } catch { return DEFAULT_TENANT_ID }
}

/**
 * A public quote request was just persisted (booking in `quote_received`).
 * Upserts the Customer, projects the Lead, and publishes LeadCreated +
 * QuoteRequested (+ QuoteGenerated when the AI estimate is attached).
 */
export async function onLeadPersisted(booking: Booking): Promise<void> {
  if (!isEnabled('INTAKE_WORKFLOW_ENABLED')) return
  try {
    const t = tenant()
    let customerId: string | undefined
    try {
      const { customer } = await upsertCustomer({
        name: booking.customerName, email: booking.customerEmail, phone: booking.customerPhone,
        tenantId: t, bookingToken: booking.token,
      })
      customerId = customer.id
    } catch (e) { console.warn('[intake] customer upsert (soft):', e instanceof Error ? e.message : e) }

    await publishEvent({
      eventType: 'LeadCreated', entityId: booking.token, tenantId: t, actor: CUSTOMER_ACTOR,
      payload: { source: booking.source ?? 'online', serviceType: booking.serviceType, bookingNumber: booking.bookingNumber, customerId },
    })
    await publishEvent({
      eventType: 'QuoteRequested', entityId: booking.token, tenantId: t, actor: CUSTOMER_ACTOR,
      payload: { serviceType: booking.serviceType, customerId },
    })

    const est = booking.aiEstimate
    if (est) {
      await publishEvent({
        eventType: 'QuoteGenerated', entityId: booking.token, tenantId: t,
        actor: { type: 'ai', id: `ai:${est.model ?? 'estimate'}` },
        payload: {
          amountCents: Math.round((est.pricing.recommendedUsd ?? 0) * 100),
          lowCents: Math.round((est.pricing.lowUsd ?? 0) * 100),
          highCents: Math.round((est.pricing.highUsd ?? 0) * 100),
          decision: est.decision,
          confidence: est.analysis?.confidence?.overall,
        },
      })
      await bumpQuoteGenerated()

      // The ai-sales worker produced a draft quote (L2, writes:false).
      await publishEvent({
        eventType: 'AIActionDrafted', entityId: booking.token, tenantId: t, actor: { type: 'ai', id: 'ai:ai-sales' },
        payload: { workerId: 'ai-sales', decision: est.decision, amountCents: Math.round((est.pricing.recommendedUsd ?? 0) * 100) },
      })

      // Governed approval gate: low-confidence / manual-review / high-value quotes
      // require recorded owner sign-off before the firm quote is sent.
      const assessment = assessQuoteApproval(est)
      if (assessment.needsApproval) {
        try {
          const approval = buildQuoteApproval(booking, est, assessment, t)
          await saveApproval(approval)
          await publishEvent({
            eventType: 'AIActionApprovalRequested', entityId: booking.token, tenantId: t, actor: { type: 'system', id: 'intake' },
            payload: { approvalId: approval.id, riskClass: approval.riskClass, reasons: assessment.reasons },
          })
        } catch (e) { console.warn('[intake] approval create (soft):', e instanceof Error ? e.message : e) }
      }
    }

    try { await projectLead(booking, { customerId, tenantId: t }) } catch (e) { console.warn('[intake] lead projection (soft):', e instanceof Error ? e.message : e) }
  } catch (e) {
    console.warn('[intake] onLeadPersisted (soft):', e instanceof Error ? e.message : e)
  }
}

/**
 * A payment was captured against a booking. Publishes PaymentReceived always,
 * plus DepositPaid + BookingCreated the moment the booking first becomes confirmed.
 */
export async function onPaymentCaptured(
  booking: Booking,
  opts: { amountCents: number; method?: string; justConfirmed: boolean },
): Promise<void> {
  if (!isEnabled('INTAKE_WORKFLOW_ENABLED')) return
  try {
    const t = tenant()
    await publishEvent({
      eventType: 'PaymentReceived', entityId: booking.token, tenantId: t, actor: PAYMENTS_ACTOR,
      payload: { amountCents: opts.amountCents, method: opts.method ?? 'stripe' },
    })
    if (opts.justConfirmed) {
      // Paying the deposit IS the customer's acceptance of the quote.
      await publishEvent({
        eventType: 'QuoteAccepted', entityId: booking.token, tenantId: t, actor: { type: 'user', id: 'customer' },
        payload: { via: 'deposit', amountCents: opts.amountCents },
      })
      await bumpQuoteAccepted()
      await publishEvent({
        eventType: 'DepositPaid', entityId: booking.token, tenantId: t, actor: PAYMENTS_ACTOR,
        payload: { amountCents: opts.amountCents, method: opts.method ?? 'stripe' },
      })
      await publishEvent({
        eventType: 'BookingCreated', entityId: booking.token, tenantId: t, actor: { type: 'system', id: 'intake' },
        payload: { bookingNumber: booking.bookingNumber, serviceType: booking.serviceType },
      })
    }
  } catch (e) {
    console.warn('[intake] onPaymentCaptured (soft):', e instanceof Error ? e.message : e)
  }
}

// ── Approval assessment + orchestration ──────────────────────────────────────

export type QuoteAssessment = { needsApproval: boolean; reasons: string[]; risk: RiskClass }

/** Pure: does this AI-drafted quote need owner sign-off before it's sent? */
export function assessQuoteApproval(est: StoredAiEstimate): QuoteAssessment {
  const reasons: string[] = []
  if (est.decision === 'manual_review') reasons.push('AI flagged this for manual review')
  const criticVerdict = est.critic?.recommend
  if (criticVerdict && criticVerdict !== 'accept') reasons.push(`independent reviewer verdict: ${criticVerdict}`)
  const rec = est.pricing.recommendedUsd ?? 0
  if (rec >= HIGH_VALUE_USD) reasons.push(`high-value quote ($${Math.round(rec)})`)
  const risk: RiskClass = rec >= HIGH_VALUE_USD ? 'high' : est.decision === 'manual_review' ? 'medium' : 'low'
  return { needsApproval: reasons.length > 0, reasons, risk }
}

function buildQuoteApproval(booking: Booking, est: StoredAiEstimate, assessment: QuoteAssessment, tenantId: string): ApprovalRequest {
  const now = Date.now()
  const rec = Math.round(est.pricing.recommendedUsd ?? 0)
  const draft: ApprovalRequest = {
    id: `appr_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    tenantId,
    requestedAction: 'quote.send',
    requestingWorkerId: 'ai-sales',
    approverRole: 'admin' as Role,
    riskClass: riskFloorForAction('quote.send', assessment.risk),
    actionPreview: `Send firm quote ~$${rec} to ${booking.customerName} (${booking.serviceType})`,
    explanation: assessment.reasons.join('; '),
    evidence: [`booking:${booking.token}`, `range:$${Math.round(est.pricing.lowUsd)}-$${Math.round(est.pricing.highUsd)}`, `decision:${est.decision}`],
    confidence: est.analysis?.confidence?.overall ?? 0.5,
    expectedImpact: `Customer quoted $${Math.round(est.pricing.lowUsd)}–$${Math.round(est.pricing.highUsd)}`,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    status: 'draft',
    rollbackMetadata: { bookingToken: booking.token, bookingNumber: booking.bookingNumber },
    createdAt: now,
  }
  return transition(draft, 'pending') // draft → pending via the state machine
}

/**
 * Owner decides a pending quote approval. Transitions via the state machine (throws
 * on an illegal transition, surfaced as 409), records a governed ai-worker audit,
 * and publishes AIActionApproved/Rejected (+ QuoteSent on approve). Not flag-gated
 * itself — an admin acting on an existing approval always works; the events are
 * still fail-soft (a no-op if the workflow flag is off).
 */
export type DecideApprovalResult =
  | { ok: true; approval: ApprovalRequest }
  | { ok: false; error: string; status: number }

export async function decideApproval(input: {
  approvalId: string; decision: 'approve' | 'reject'; decidedBy: string; decidedByRole: Role; callerTenantId: string; reason?: string
}): Promise<DecideApprovalResult> {
  const req = await getApproval(input.approvalId)
  if (!req) return { ok: false, error: 'approval not found', status: 404 }
  // Tenant isolation: a staff member may only decide approvals in their own tenant.
  if (req.tenantId !== input.callerTenantId) return { ok: false, error: 'forbidden', status: 403 }

  const to = input.decision === 'approve' ? 'approved' : 'rejected'
  let next: ApprovalRequest
  try {
    next = transition(req, to, { decidedBy: input.decidedBy, decisionReason: input.reason })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'illegal transition', status: 409 }
  }
  await saveApproval(next)

  const bookingToken = (req.rollbackMetadata?.bookingToken as string) || req.id
  const actor = { type: 'user' as const, id: input.decidedBy, role: input.decidedByRole }

  // Governed audit: authorize the ai-sales worker's quote action under the deciding
  // owner (a real staff actor holding the permissions). Best-effort — never blocks.
  let workerAudit: Record<string, unknown> | undefined
  try {
    const worker = getWorker('ai-sales')
    if (worker) {
      const d = authorizeWorkerAction({
        worker, actor: { sub: input.decidedBy, role: input.decidedByRole, tenantId: req.tenantId },
        tenant: { id: req.tenantId }, autonomyLevel: 3, capability: 'quotes', action: 'quote.send', workforceEnabled: true,
      })
      workerAudit = { ...d.audit }
    }
  } catch { /* governed audit is best-effort */ }

  await publishEvent({
    eventType: input.decision === 'approve' ? 'AIActionApproved' : 'AIActionRejected',
    entityId: bookingToken, tenantId: req.tenantId, actor,
    payload: { approvalId: req.id, reason: input.reason },
    metadata: workerAudit ? { workerAudit } : undefined,
  })
  if (input.decision === 'approve') {
    await publishEvent({ eventType: 'QuoteSent', entityId: bookingToken, tenantId: req.tenantId, actor, payload: { approvalId: req.id } })
  }
  return { ok: true, approval: next }
}
