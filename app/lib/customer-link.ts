// Sprint 5 — the retail customer ↔ booking join.
//
// A Booking carries `customerName`, `customerPhone` and `customerEmail` but NO
// customer id, and nothing back-fills one. So the association is DERIVED at read
// time from the identity indexes `customers.ts` already maintains
// (`cust:email:<normalized>` and `cust:phone:<digits>`), never stored. That choice
// is deliberate: it works on every historical booking, needs no migration, and
// needs no Production write. Callers must present it as derived — see
// `LINK_PROVENANCE`.
//
// DETERMINISM IS THE WHOLE POINT. This resolver:
//
//   • never matches on NAME. Two different people are routinely called
//     "Mike Smith"; merging them would silently join one customer's payment
//     history to another's, and no UI affordance can undo a bad merge the reader
//     cannot see.
//   • FAILS CLOSED when email and phone disagree. `customers.findCustomerId`
//     answers a different question — it returns the email match first and stops,
//     which is right for upsert (claim one identity) and wrong here (report the
//     truth). A disagreement means the indexes genuinely describe two records, so
//     this returns `conflict` for manual review rather than silently preferring
//     one side.
//   • treats a booking with NEITHER identifier as explicitly unlinked. Not
//     "probably this person" — unlinked, with a reason.
//
// Tenancy: every read goes through the injected client, which in production is the
// redis chokepoint. `cust:*` keys are tenant-owned and scoped there, so a lookup
// cannot cross a tenant boundary and fails closed with no tenant context.
import { normEmail, normPhone, type CustomerClient } from './customers'

/** Phone index threshold — matches `customers.findCustomerId`, so the two agree. */
const MIN_PHONE_DIGITS = 7

export const LINK_PROVENANCE = 'derived' as const

export type LinkBasis = 'email' | 'phone' | 'email+phone'

export type CustomerLink =
  /** Both present identifiers agree, or only one was resolvable. */
  | { kind: 'linked'; customerId: string; basis: LinkBasis; provenance: typeof LINK_PROVENANCE }
  /** Nothing to match on, or nothing matched. Never a guess. */
  | { kind: 'unlinked'; reason: 'no_identifier' | 'no_customer_record' }
  /** Email and phone resolve to DIFFERENT customers — a human decides. */
  | { kind: 'conflict'; emailCustomerId: string; phoneCustomerId: string }

export type Identifiers = { email?: string; phone?: string }

const emailIndex = (email: string) => `cust:email:${normEmail(email)}`
const phoneIndex = (phone: string) => `cust:phone:${normPhone(phone)}`

/**
 * Resolve one booking's customer identity. Reads BOTH indexes when both
 * identifiers are present — that is what makes a conflict detectable at all.
 */
export async function resolveCustomerLink(
  idy: Identifiers,
  client: Pick<CustomerClient, 'get'>,
): Promise<CustomerLink> {
  const hasEmail = normEmail(idy.email).length > 0
  const hasPhone = normPhone(idy.phone).length >= MIN_PHONE_DIGITS

  // A name alone is not an identifier. This is the branch that keeps it that way.
  if (!hasEmail && !hasPhone) return { kind: 'unlinked', reason: 'no_identifier' }

  const [byEmail, byPhone] = await Promise.all([
    hasEmail ? client.get(emailIndex(idy.email!)) : Promise.resolve(null),
    hasPhone ? client.get(phoneIndex(idy.phone!)) : Promise.resolve(null),
  ])

  if (byEmail && byPhone) {
    if (byEmail !== byPhone) return { kind: 'conflict', emailCustomerId: byEmail, phoneCustomerId: byPhone }
    return { kind: 'linked', customerId: byEmail, basis: 'email+phone', provenance: LINK_PROVENANCE }
  }
  if (byEmail) return { kind: 'linked', customerId: byEmail, basis: 'email', provenance: LINK_PROVENANCE }
  if (byPhone) return { kind: 'linked', customerId: byPhone, basis: 'phone', provenance: LINK_PROVENANCE }

  // Identifiers exist but no customer record does — distinct from having nothing
  // to match on, because this one becomes linked the moment a customer is minted.
  return { kind: 'unlinked', reason: 'no_customer_record' }
}

/** Does this link attribute the record to `customerId`? Conflicts never do. */
export function linksTo(link: CustomerLink, customerId: string): boolean {
  return link.kind === 'linked' && link.customerId === customerId
}
