// ClaimGuard Assist — the recommendation engine.
//
// Pure logic over a claim's TYPE: what to do next, what evidence to gather, and
// which ClaimGuard document/tool fits the situation. No Redis, no I/O — the claim
// detail renders this alongside the claim.
//
// The `claimGuardPath` values were verified to exist on claimguardhelp.com. Do not
// invent a path; if a situation has no dedicated ClaimGuard page, route it to the
// general dispute builder (/tools/dispute-builder), which does.
//
// Framing depends on DIRECTION (see lib/claims.directionOf):
//   inbound  — someone claims OUR crew/service caused a loss. ClaimGuard helps us
//              respond and rebut before we accept liability.
//   outbound — a broker/platform/customer shorted US. ClaimGuard helps us demand
//              and recover.
// Direction + types come from the pure leaf module lib/claim-types.ts (no I/O), so
// this client component shares the exact same source of truth as the server claims
// core WITHOUT pulling claims.ts's runtime graph (redis/finance/routes) into the
// browser bundle. scripts/claim-assist.test.ts guards that every type has a playbook
// whose direction matches directionOf.
import type { ClaimType, ClaimDirection } from './claim-types'
import { directionOf } from './claim-types'

export const CLAIMGUARD_BASE = 'https://claimguardhelp.com'
export const claimGuardUrl = (path: string): string => `${CLAIMGUARD_BASE}${path}`

export type ClaimPlaybook = {
  direction: ClaimDirection
  headline: string          // one-line framing of the situation
  nextAction: string        // the immediate recommended step
  evidence: string[]        // what to gather — a checklist
  document: string          // the ClaimGuard document/template that fits
  claimGuardPath: string    // deep-link path on claimguardhelp.com (verified to exist)
  claimGuardHref: string    // absolute deep link WITH claim context (see claimGuardHref)
}

type Play = Omit<ClaimPlaybook, 'direction' | 'claimGuardHref'>

const PLAYBOOKS: Record<ClaimType, Play> = {
  // ── Inbound: claimed against us — defend and rebut ──────────────────────────
  property_damage: {
    headline: 'A customer says our crew caused property damage.',
    nextAction: 'Gather the crew’s proof and send a response before you accept liability.',
    evidence: ['Before/after photos from the crew', 'The signed route/delivery confirmation', 'The crew member’s written account', 'Any condition report or damage waiver'],
    document: 'Dispute Response Letter',
    claimGuardPath: '/damage-claim',
  },
  vehicle_damage: {
    headline: 'Damage to a vehicle has been claimed.',
    nextAction: 'Document the damage and the pre-trip condition, then respond.',
    evidence: ['Photos of the damage', 'Pre-trip inspection record', 'Dashcam footage if any', 'The driver’s account'],
    document: 'Dispute Response Letter',
    claimGuardPath: '/damage-claim',
  },
  cargo_damage: {
    headline: 'Cargo was reported damaged in our care.',
    nextAction: 'Pull the delivery paperwork and photos, then respond to the claim.',
    evidence: ['Bill of lading / delivery receipt', 'Photos of the cargo condition', 'Packaging condition notes', 'Signed proof of delivery'],
    document: 'Freight Claim / Dispute Response Letter',
    claimGuardPath: '/damage-claim',
  },
  lost_item: {
    headline: 'An item is reported lost or missing.',
    nextAction: 'Reconcile the manifest against the signed delivery before responding.',
    evidence: ['Item manifest / inventory', 'Signed proof of delivery', 'The crew’s account', 'Site access log'],
    document: 'Dispute Response Letter',
    claimGuardPath: '/damage-claim',
  },
  injury: {
    headline: 'An injury has been claimed.',
    nextAction: 'Document everything and notify your insurer immediately — do not admit fault.',
    evidence: ['Incident report', 'Photos of the scene', 'Witness statements', 'Your insurance policy details'],
    document: 'Insurance Disclosure Request',
    claimGuardPath: '/arbitration-prep',
  },
  service_failure: {
    headline: 'The customer says the service wasn’t done right.',
    nextAction: 'Show completion proof against the agreed scope, then respond.',
    evidence: ['Job completion proof / photos', 'The service agreement / scope', 'Arrival + completion timestamps', 'Customer communication log'],
    document: 'Dispute Response Letter',
    claimGuardPath: '/damage-claim',
  },

  // ── Outbound: we're disputing — demand and recover ──────────────────────────
  chargeback: {
    headline: 'A payment was reversed via chargeback.',
    nextAction: 'Build the chargeback rebuttal with your proof of service before the bank’s deadline.',
    evidence: ['Signed proof of delivery / completion', 'The invoice + payment record', 'Customer authorization / agreement', 'Messages showing the service was accepted'],
    document: 'Chargeback Rebuttal (Dispute Builder)',
    claimGuardPath: '/tools/dispute-builder',
  },
  unfair_deduction: {
    headline: 'Pay was withheld or deducted unfairly.',
    nextAction: 'Demand the documentation behind the deduction, then challenge the SOP basis.',
    evidence: ['Pay statement showing the deduction', 'The SOP / policy they cited', 'Proof you followed procedure', 'The original agreement / rate con'],
    document: 'SOP Challenge / Documentation Request Letter',
    claimGuardPath: '/deduction-from-pay',
  },
  detention: {
    headline: 'Detention time is owed and unpaid.',
    nextAction: 'Send a freight demand with your time-stamped detention proof.',
    evidence: ['Check-in / check-out timestamps', 'Rate confirmation with detention terms', 'BOL / gate logs', 'Communication with the broker'],
    document: 'Freight Demand Letter',
    claimGuardPath: '/freight/start',
  },
  accessorial_dispute: {
    headline: 'An accessorial charge is disputed or unpaid.',
    nextAction: 'Document the accessorial and send a freight demand.',
    evidence: ['Rate confirmation with accessorial terms', 'Proof it occurred (lumper receipt, layover log…)', 'BOL', 'Broker communication'],
    document: 'Freight Demand Letter',
    claimGuardPath: '/freight/start',
  },
  late_delivery: {
    headline: 'A late-delivery penalty is being disputed.',
    nextAction: 'Show the cause was outside your control and dispute the penalty.',
    evidence: ['Delivery timestamps', 'Scheduled vs actual window', 'Proof of the delay’s cause (weather, dock, appointment)', 'Communication log'],
    document: 'Dispute Response / Documentation Request',
    claimGuardPath: '/tools/dispute-builder',
  },
  non_payment: {
    headline: 'An invoice hasn’t been paid.',
    nextAction: 'Send a non-payment demand with the invoice and proof of service.',
    evidence: ['The unpaid invoice', 'Signed proof of delivery / completion', 'The agreement / rate con', 'Payment terms + due date'],
    document: 'Non-Payment Demand Letter',
    claimGuardPath: '/non-payment',
  },

  other: {
    headline: 'Review the situation and pick the closest fit.',
    nextAction: 'Open the ClaimGuard dispute builder to find the right template.',
    evidence: ['Any signed agreement', 'Proof of what happened', 'Financial records', 'Communication log'],
    document: 'Dispute Builder',
    claimGuardPath: '/tools/dispute-builder',
  },
}

// Where an OpsPilot claim type maps onto the dispute builder's own preset modes
// (claimguardhelp.com/tools/dispute-builder?dispute=…). Only the builder reads this
// param, so it's appended only when the recommended path IS the builder. Its valid
// values are damage-claim | chargeback | arbitration; types with a dedicated landing
// page (property damage, deductions, etc.) route straight there and need no preset.
const DISPUTE_PRESET: Partial<Record<ClaimType, string>> = {
  chargeback: 'chargeback',
}

export type ClaimContext = {
  claimType: ClaimType
  refCode?: string      // e.g. JK-C-1042 — lets ClaimGuard attribute/trace the lead
  amountCents?: number  // the claim amount, for pre-fill where supported
}

// Build the deep link to claimguardhelp.com carrying claim context:
//   • source=opspilot + ref  → ClaimGuard can attribute and trace the lead
//   • dispute=<preset>       → the dispute builder pre-selects the matching flow
//   • amount=<dollars>       → pre-fill where the destination supports it
// Unknown params are simply ignored by pages that don't read them, so this is safe
// for every destination.
export function claimGuardHref(ctx: ClaimContext): string {
  const path = (PLAYBOOKS[ctx.claimType] ?? PLAYBOOKS.other).claimGuardPath
  const params = new URLSearchParams({ source: 'opspilot' })
  if (ctx.refCode) params.set('ref', ctx.refCode)
  if (typeof ctx.amountCents === 'number' && ctx.amountCents > 0) params.set('amount', (ctx.amountCents / 100).toFixed(2))
  if (path.startsWith('/tools/dispute-builder')) {
    const preset = DISPUTE_PRESET[ctx.claimType]
    if (preset) params.set('dispute', preset)
  }
  return claimGuardUrl(`${path}?${params.toString()}`)
}

export function recommendForClaim(claim: ClaimContext): ClaimPlaybook {
  const play = PLAYBOOKS[claim.claimType] ?? PLAYBOOKS.other
  return { direction: directionOf(claim.claimType), ...play, claimGuardHref: claimGuardHref(claim) }
}
