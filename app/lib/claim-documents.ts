// Native claim documents — the OpsPilot-side complement to ClaimGuard Assist.
//
// ClaimGuard (claimguardhelp.com) handles the OUTBOUND, customer/broker-facing
// letters. But an INBOUND claim (a customer says our crew caused a loss) needs
// documents built from data ONLY OpsPilot has — the crew member, their agreed
// responsibility split, and the weekly payroll-deduction plan. Those are generated
// here, natively, so the operator never has to leave to assemble them.
//
// Pure module: {{placeholder}} templates + a populate() and a value-builder. No I/O,
// no React — the detail page renders the filled text and offers copy/print.

export type ClaimDocScope = 'inbound' | 'outbound' | 'all'

export type ClaimDocTemplate = {
  id: string
  title: string
  blurb: string              // one-line description shown in the picker
  scope: ClaimDocScope       // which claim direction it applies to
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
]

export function templatesForScope(direction: ClaimDocScope): ClaimDocTemplate[] {
  return CLAIM_DOC_TEMPLATES.filter(t => t.scope === 'all' || t.scope === direction)
}
