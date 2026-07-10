// Pure claim taxonomy — the SINGLE source of truth for claim types and their
// direction. This module has NO I/O imports (no redis/finance/routes), so both
// the server-side claims core (lib/claims.ts) and the client-side ClaimGuard
// Assist engine (lib/claim-assist.ts) can import it directly without dragging the
// server runtime graph into the browser bundle. Before this existed, the type
// union and the OUTBOUND list were copy-pasted in both files and could silently
// drift; scripts/claim-assist.test.ts now guards that they don't.

export type ClaimType =
  // INBOUND — someone says our crew/service caused a loss; we may recover from crew.
  | 'property_damage' | 'vehicle_damage' | 'cargo_damage' | 'lost_item'
  | 'injury' | 'service_failure'
  // OUTBOUND — a broker/platform/customer shorted US; we dispute to recover from them.
  | 'chargeback' | 'unfair_deduction' | 'detention' | 'accessorial_dispute'
  | 'late_delivery' | 'non_payment'
  | 'other'

// Every claim type in display order. Iterating this (rather than Object.keys on a
// label map) lets the sync test assert exhaustiveness — each type has a label, a
// playbook, and a direction consistent across modules.
export const CLAIM_TYPES: readonly ClaimType[] = [
  'property_damage', 'vehicle_damage', 'cargo_damage', 'lost_item', 'injury', 'service_failure',
  'chargeback', 'unfair_deduction', 'detention', 'accessorial_dispute', 'late_delivery', 'non_payment',
  'other',
]

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  property_damage: 'Property Damage',
  vehicle_damage: 'Vehicle Damage',
  cargo_damage: 'Cargo Damage',
  lost_item: 'Lost / Missing Item',
  injury: 'Injury',
  service_failure: 'Service Failure',
  chargeback: 'Chargeback',
  unfair_deduction: 'Unfair Deduction',
  detention: 'Detention',
  accessorial_dispute: 'Accessorial Dispute',
  late_delivery: 'Late Delivery',
  non_payment: 'Non-Payment',
  other: 'Other',
}

// A claim's DIRECTION is a property of its type, not a separate stored field — a
// chargeback is always something WE dispute (outbound); property damage is always
// something claimed against US (inbound). Inbound claims recover from the crew;
// outbound claims are disputes we send to a broker/platform (→ ClaimGuard tools).
export type ClaimDirection = 'inbound' | 'outbound'

export const OUTBOUND_TYPES: readonly ClaimType[] = [
  'chargeback', 'unfair_deduction', 'detention', 'accessorial_dispute', 'late_delivery', 'non_payment',
]

export const directionOf = (t: ClaimType): ClaimDirection =>
  OUTBOUND_TYPES.includes(t) ? 'outbound' : 'inbound'
