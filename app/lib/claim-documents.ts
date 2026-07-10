// Native claim documents — generated inside OpsPilot, free, for EVERY claim.
//
// INBOUND claims (a customer says our crew caused a loss) get documents built from
// data only OpsPilot has — the crew member, their responsibility split, the payroll-
// deduction plan. OUTBOUND claims (a broker/platform shorted us) get the dispute and
// demand letters — chargeback rebuttal, non-payment demand, deduction dispute,
// freight/detention demand, late-delivery dispute. All produced here so the operator
// never leaves OpsPilot and never hits a paywall.
//
// Pure module: {{placeholder}} templates + a populate() and a value-builder. No I/O,
// no React — the detail page renders the filled text and offers copy/print/download.
import { directionOf, type ClaimType } from './claim-types'

export type ClaimDocScope = 'inbound' | 'outbound' | 'all'

export type ClaimDocTemplate = {
  id: string
  title: string
  blurb: string              // one-line description shown in the picker
  scope: ClaimDocScope       // which claim direction it applies to
  claimTypes?: ClaimType[]   // if set, only offered for these specific types
  needsAssignment?: boolean  // true → must be generated for a specific crew member
  body: string               // document text with {{placeholder}} tokens
}

export type ClaimDocValues = Record<string, string>

// Minimal structural shapes so this module doesn't couple to the client Claim type.
export type DocClaim = {
  claimNumber: string
  claimTypeLabel: string
  claimDate: string
  businessName: string
  totalCents: number
  description: string
  routeNumber?: string
  routeDate?: string
  responseDeadline?: string
}
export type DocAssignment = {
  name: string
  responsibilityCents: number
  responsibilityPct?: number
  weeklyDeductionCents?: number
  startDate?: string
}

export type DocCompany = { legalName: string; phone: string; email: string }

const money = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Fill {{tokens}}; unknown tokens collapse to empty so a document never shows raw
// braces to a customer. The value-builder below supplies every token the templates
// use, so this only trims optional fields that happen to be blank.
export function populateClaimDoc(tpl: ClaimDocTemplate, v: ClaimDocValues): string {
  return tpl.body
    .replace(/{{\s*(\w+)\s*}}/g, (_, k: string) => (k in v ? v[k] : ''))
    .replace(/[ \t]+\n/g, '\n')      // tidy trailing spaces left by empty tokens
    .replace(/\n{3,}/g, '\n\n')      // collapse gaps where an optional line vanished
    .trim()
}

export function buildClaimDocValues(
  claim: DocClaim,
  company: DocCompany,
  today: string,
  assignment?: DocAssignment,
): ClaimDocValues {
  const routeNumber = claim.routeNumber || claim.routeDate || ''
  return {
    today,
    company: company.legalName,
    companyPhone: company.phone,
    companyEmail: company.email,
    claimNumber: claim.claimNumber,
    claimType: claim.claimTypeLabel,
    claimDate: claim.claimDate,
    business: claim.businessName,
    amount: money(claim.totalCents),
    description: claim.description,
    routeLine: routeNumber ? `Route/Job: ${routeNumber}\n` : '',
    deadlineLine: claim.responseDeadline ? ` A response is requested by ${claim.responseDeadline}.` : '',
    // Assignment (crew responsibility) — only present on the acknowledgment.
    crewName: assignment?.name ?? '',
    responsibility: assignment ? money(assignment.responsibilityCents) : '',
    responsibilityPct: assignment?.responsibilityPct ? `${assignment.responsibilityPct}%` : '',
    weekly: assignment?.weeklyDeductionCents ? money(assignment.weeklyDeductionCents) : '',
    weeklyLine: assignment?.weeklyDeductionCents
      ? `Agreed weekly payroll deduction: ${money(assignment.weeklyDeductionCents)}, beginning ${assignment.startDate || 'the next pay period'}, until the balance above is satisfied.\n`
      : '',
    startDate: assignment?.startDate ?? '',
  }
}

export const CLAIM_DOC_TEMPLATES: ClaimDocTemplate[] = [
  {
    id: 'crew-responsibility-acknowledgment',
    title: 'Crew Responsibility & Deduction Acknowledgment',
    blurb: 'Crew member acknowledges responsibility and the weekly payroll-deduction plan.',
    scope: 'inbound',
    needsAssignment: true,
    body: `CREW RESPONSIBILITY & PAYROLL-DEDUCTION ACKNOWLEDGMENT

Date: {{today}}
Claim reference: {{claimNumber}}
Company: {{company}}

Crew member: {{crewName}}
Customer/Business: {{business}}
{{routeLine}}Type of claim: {{claimType}}
Date of incident: {{claimDate}}

Summary of what happened:
{{description}}

Acknowledgment
I, {{crewName}}, acknowledge the incident described above in connection with work
performed for {{company}}. I accept responsibility in the amount of {{responsibility}}{{responsibilityPct}} toward the total claimed amount of {{amount}}.

{{weeklyLine}}I understand this acknowledgment authorizes {{company}} to recover the amount above
through the agreed payroll deductions, that deductions will never reduce a paycheck
below the applicable minimum, and that the balance and every deduction are recorded
and available to me on request.

Signed: ______________________________   Date: ______________
{{crewName}}

For {{company}}: ______________________   Date: ______________

This is an internal record between {{company}} and its crew member. Questions:
{{companyPhone}} · {{companyEmail}}.`,
  },
  {
    id: 'damage-claim-acknowledgment',
    title: 'Claim Acknowledgment & Documentation Request',
    blurb: 'Reply to the customer acknowledging the claim and requesting documentation before any liability is accepted.',
    scope: 'inbound',
    body: `{{today}}

Re: Claim {{claimNumber}} — {{business}}

To whom it may concern,

Thank you for notifying {{company}} of your claim dated {{claimDate}} regarding {{claimType}}. We take every claim seriously and are reviewing the matter.

{{routeLine}}Claim as described to us:
{{description}}

Amount claimed: {{amount}}

So that we can fairly and promptly evaluate this claim, please provide the following
at your earliest convenience:

  • Photographs or video of the reported damage or loss
  • The date, time, and location it was identified
  • Any repair estimate, receipt, or proof of value
  • The name of anyone present who observed the incident

Acknowledging your claim is not an admission of liability. {{company}} will review the
documentation provided and respond promptly. If you have questions in the meantime,
contact us at {{companyPhone}} or {{companyEmail}}.

Sincerely,
{{company}}`,
  },

  // ── Outbound: we're disputing — demand and recover ─────────────────────────
  // ClaimGuard's dispute/demand letters, generated natively so OpsPilot users get
  // them free without a ClaimGuard login.
  {
    id: 'non-payment-demand',
    title: 'Non-Payment Demand Letter',
    blurb: 'Formal demand for a past-due invoice, with proof of service and a payment deadline.',
    scope: 'outbound',
    claimTypes: ['non_payment'],
    body: `{{today}}

Re: Past-Due Payment — {{business}} — Claim {{claimNumber}}

To Accounts Payable, {{business}},

{{company}} completed the work described below and payment of {{amount}} remains outstanding. This letter is a formal demand for payment.

{{routeLine}}Service: {{claimType}}
Date of service: {{claimDate}}
Details: {{description}}
Amount due: {{amount}}

Please remit the full amount due within ten (10) business days of this notice.{{deadlineLine}} If payment is not received, {{company}} will pursue every remedy available under our agreement, including collection, interest, and fees.

Proof of completion is available on request. Contact {{companyPhone}} or {{companyEmail}} to resolve this immediately.

Sincerely,
{{company}}`,
  },
  {
    id: 'chargeback-rebuttal',
    title: 'Chargeback Rebuttal Statement',
    blurb: 'Rebuttal to the bank/processor showing the service was ordered, delivered, and accepted.',
    scope: 'outbound',
    claimTypes: ['chargeback'],
    body: `{{today}}

Re: Chargeback Rebuttal — {{business}} — Claim {{claimNumber}}

To the reviewing bank / payment processor,

{{company}} disputes the chargeback of {{amount}} initiated by {{business}}. The service was ordered, delivered, and accepted; this statement and the evidence below support reversing the chargeback in {{company}}'s favor.

{{routeLine}}Transaction / service: {{claimType}}
Date of service: {{claimDate}}
What was provided: {{description}}
Amount charged: {{amount}}

Evidence supporting the charge:
  • Signed proof of delivery / completion
  • The invoice and the authorized payment
  • The customer's agreement / authorization
  • Communications showing the service was accepted

{{company}} respectfully requests the chargeback be reversed.{{deadlineLine}} Questions: {{companyPhone}} · {{companyEmail}}.

{{company}}`,
  },
  {
    id: 'deduction-dispute',
    title: 'Deduction Dispute & Documentation Request',
    blurb: 'Disputes a withheld/deducted amount and demands the SOP or contract basis behind it.',
    scope: 'outbound',
    claimTypes: ['unfair_deduction'],
    body: `{{today}}

Re: Disputed Deduction — {{business}} — Claim {{claimNumber}}

To {{business}},

{{company}} disputes the deduction of {{amount}} applied to our pay/settlement and requests the documentation that supports it.

{{routeLine}}Deduction reason given: {{claimType}}
Date: {{claimDate}}
Our account: {{description}}
Amount deducted: {{amount}}

Please provide, within ten (10) business days:{{deadlineLine}}
  • The specific policy, SOP, or contract clause the deduction relies on
  • The evidence that the cited condition actually occurred
  • The calculation used to arrive at {{amount}}

Absent documentation establishing a valid basis, {{company}} requests the deduction be reversed and the amount released. Contact {{companyPhone}} or {{companyEmail}}.

{{company}}`,
  },
  {
    id: 'freight-demand',
    title: 'Detention / Accessorial Demand Letter',
    blurb: 'Demands payment for detention, layover, lumper, or other accessorials owed on a load.',
    scope: 'outbound',
    claimTypes: ['detention', 'accessorial_dispute'],
    body: `{{today}}

Re: Unpaid {{claimType}} — {{business}} — Claim {{claimNumber}}

To {{business}},

{{company}} is owed {{amount}} for {{claimType}} incurred on the load referenced below, and it remains unpaid. This is a formal demand for payment.

{{routeLine}}Date: {{claimDate}}
Details: {{description}}
Amount owed: {{amount}}

This charge is supported by our time-stamped records and the rate confirmation terms. Please remit {{amount}} within ten (10) business days.{{deadlineLine}}

Supporting records (check-in/out times, BOL, rate confirmation) are available on request. Contact {{companyPhone}} or {{companyEmail}} to resolve.

{{company}}`,
  },
  {
    id: 'late-delivery-dispute',
    title: 'Late-Delivery Penalty Dispute',
    blurb: 'Disputes a late-delivery penalty where the delay was outside your control.',
    scope: 'outbound',
    claimTypes: ['late_delivery'],
    body: `{{today}}

Re: Disputed Late-Delivery Penalty — {{business}} — Claim {{claimNumber}}

To {{business}},

{{company}} disputes the late-delivery penalty of {{amount}} applied to the load below. The cause of the delay was outside our reasonable control, and we request the penalty be removed.

{{routeLine}}Date: {{claimDate}}
What happened: {{description}}
Penalty amount: {{amount}}

We can document the scheduled vs. actual delivery window and the cause of the delay. Please reverse the penalty of {{amount}}.{{deadlineLine}} Contact {{companyPhone}} or {{companyEmail}}.

{{company}}`,
  },
]

// Templates offered for a specific claim — filtered by the claim's direction AND,
// when a template targets specific types, by the claim's type. Every claim type
// (inbound or outbound) resolves to at least one native document.
export function templatesForClaim(claimType: ClaimType): ClaimDocTemplate[] {
  const dir = directionOf(claimType)
  return CLAIM_DOC_TEMPLATES.filter(t =>
    (t.scope === 'all' || t.scope === dir) &&
    (!t.claimTypes || t.claimTypes.includes(claimType)),
  )
}

export function templatesForScope(direction: ClaimDocScope): ClaimDocTemplate[] {
  return CLAIM_DOC_TEMPLATES.filter(t => t.scope === 'all' || t.scope === direction)
}
