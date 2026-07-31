// Sprint 5 — the retail customer record: one traceable timeline joining a
// customer's bookings, payments, refunds and communications, plus the booking
// audit trail for readers authorized to see it.
//
// SCOPE. Retail booking customers only. Route invoices (`route-invoices.ts`) and
// claims (`claims.ts`) are keyed to `businessName` / `businessKey` / `routeToken`
// — the B2B lane — and carry no booking or retail-customer reference at all, so
// they cannot be joined here without inventing a relationship the data model does
// not have. B2B invoice history is deferred; see the roadmap.
//
// PROVENANCE. The customer→booking association is DERIVED (see `customer-link.ts`)
// and every entry says so. Everything inside a booking — payments, communications,
// events — is STORED on that booking and is marked `stored`. A reader must be able
// to tell which is which, because a derived link can change when an identity index
// changes, and a stored fact cannot.
//
// COMPLETENESS. Bookings have no per-customer index, so this scans the booking
// index. A truncated scan is reported, never hidden: `scan.complete` is false and
// the caller is expected to say so. "No payments found" and "we stopped looking"
// are different answers.
import {
  scanBookingIndexPage, countBookingIndex, readBookingsByTokens,
  type Booking, type Payment,
} from './bookings'
import { getCustomer, type Customer, type CustomerClient } from './customers'
import { redis } from './redis'
import { resolveCustomerLink, linksTo, type CustomerLink, type LinkBasis } from './customer-link'

/** Bounded like the punch-overlap scan, for the same reason: a hung page loop is
 *  worse than an explicitly incomplete answer. */
const SCAN_PAGE = 200
const SCAN_MAX = 20_000

export type EntryKind = 'booking' | 'payment' | 'refund' | 'communication' | 'audit'

export type TimelineEntry = {
  at: number
  kind: EntryKind
  bookingToken: string
  bookingNumber: string
  label: string
  detail?: string
  amountCents?: number
  /** 'derived' only for the customer↔booking association itself. */
  provenance: 'stored' | 'derived'
}

export type LinkedBooking = {
  token: string
  bookingNumber: string
  status: string
  serviceType: string
  createdAt: number
  invoiceAmountCents: number
  amountPaidCents: number
  basis: LinkBasis
}

export type TimelineConflict = {
  bookingToken: string
  bookingNumber: string
  emailCustomerId: string
  phoneCustomerId: string
}

export type CustomerTimeline = {
  customer: Customer
  linkProvenance: 'derived'
  bookings: LinkedBooking[]
  entries: TimelineEntry[]
  totals: { bookings: number; paidCents: number; refundedCents: number; communications: number }
  /** Bookings whose email and phone resolve to DIFFERENT customers. Surfaced for a
   *  human, never silently attributed to either side. */
  conflicts: TimelineConflict[]
  scan: {
    indexed: number
    scanned: number
    read: number
    complete: boolean
    pageLimitReached: boolean
    /** Bookings carrying neither email nor phone — unlinkable by construction. */
    unlinkedNoIdentifier: number
    /** Index entries whose record could not be read — the answer has holes. */
    missingRecords: number
  }
  /** True when the reader may see booking audit events. */
  includesAudit: boolean
}

export type TimelineOptions = {
  /** Booking audit events are admin-only (`audit:view`), matching rbac.ts. */
  includeAudit?: boolean
  pageSize?: number
  maxPages?: number
  client?: Pick<CustomerClient, 'get'>
}

const refunded = (p: Payment) => p.status === 'refunded'
const confirmed = (p: Payment) => p.status === 'confirmed'

function paymentEntries(b: Booking): TimelineEntry[] {
  const out: TimelineEntry[] = []
  for (const p of b.payments ?? []) {
    // A refund is its own event, not a payment with a flag — a reader scanning the
    // timeline for money movement must see it as a distinct line.
    const isRefund = refunded(p)
    out.push({
      at: p.confirmedAt ?? p.createdAt,
      kind: isRefund ? 'refund' : 'payment',
      bookingToken: b.token,
      bookingNumber: b.bookingNumber,
      label: isRefund
        ? `Refunded · ${p.method}`
        : `${p.type} payment · ${p.method} · ${p.status}`,
      detail: p.reference || undefined,
      amountCents: p.amountCents,
      provenance: 'stored',
    })
  }
  return out
}

function communicationEntries(b: Booking): TimelineEntry[] {
  return (b.communications ?? []).map(c => ({
    at: c.at,
    kind: 'communication' as const,
    bookingToken: b.token,
    bookingNumber: b.bookingNumber,
    label: `${c.ok ? 'Sent' : 'Failed'} · ${c.channel}`,
    // The message body is operator-authored content about this customer; it is
    // already visible on the booking to the same readers.
    detail: c.body.slice(0, 160),
    provenance: 'stored' as const,
  }))
}

function auditEntries(b: Booking): TimelineEntry[] {
  return (b.events ?? []).map(e => ({
    at: e.at,
    kind: 'audit' as const,
    bookingToken: b.token,
    bookingNumber: b.bookingNumber,
    label: e.action,
    detail: e.result ? `${e.actor} · ${e.result}` : e.actor,
    provenance: 'stored' as const,
  }))
}

/**
 * Build one customer's timeline. Returns null when the customer id is unknown —
 * the caller turns that into a 404 rather than an empty timeline, because "no such
 * customer" and "a customer with no activity" are different answers.
 */
export async function buildCustomerTimeline(
  customerId: string,
  opts: TimelineOptions = {},
): Promise<CustomerTimeline | null> {
  const customer = await getCustomer(customerId)
  if (!customer) return null

  const client = opts.client ?? redis
  const pageSize = opts.pageSize ?? SCAN_PAGE
  const maxPages = opts.maxPages ?? Math.ceil(SCAN_MAX / pageSize)

  const indexed = await countBookingIndex()
  let scanned = 0
  let read = 0
  let pageLimitReached = false
  let missingRecords = 0
  let unlinkedNoIdentifier = 0

  const bookings: LinkedBooking[] = []
  const entries: TimelineEntry[] = []
  const conflicts: TimelineConflict[] = []
  let paidCents = 0
  let refundedCents = 0
  let communications = 0

  for (let page = 0; ; page++) {
    if (page >= maxPages) { pageLimitReached = true; break }
    const tokens = await scanBookingIndexPage(page * pageSize, pageSize)
    if (!tokens.length) break
    scanned += tokens.length

    const { bookings: records, missing } = await readBookingsByTokens(tokens)
    // An unreadable record is a hole in the answer, not a booking with no activity.
    missingRecords += missing
    for (const b of records) {
      read++

      const link = await resolveCustomerLink({ email: b.customerEmail, phone: b.customerPhone }, client)

      if (link.kind === 'unlinked') {
        if (link.reason === 'no_identifier') unlinkedNoIdentifier++
        continue
      }
      if (link.kind === 'conflict') {
        // Report it against THIS customer only when they are one of the two sides;
        // otherwise it is someone else's ambiguity and none of this reader's business.
        if (link.emailCustomerId === customerId || link.phoneCustomerId === customerId) {
          conflicts.push({
            bookingToken: b.token, bookingNumber: b.bookingNumber,
            emailCustomerId: link.emailCustomerId, phoneCustomerId: link.phoneCustomerId,
          })
        }
        continue
      }
      if (!linksTo(link, customerId)) continue

      bookings.push({
        token: b.token, bookingNumber: b.bookingNumber, status: b.status,
        serviceType: b.serviceType, createdAt: b.createdAt,
        invoiceAmountCents: b.invoiceAmountCents, amountPaidCents: b.amountPaidCents,
        basis: link.basis,
      })

      // The booking itself is the only entry whose ATTRIBUTION is derived.
      entries.push({
        at: b.createdAt,
        kind: 'booking',
        bookingToken: b.token,
        bookingNumber: b.bookingNumber,
        label: `Booking ${b.bookingNumber} · ${b.serviceType}`,
        detail: b.status,
        amountCents: b.invoiceAmountCents,
        provenance: 'derived',
      })

      const pays = paymentEntries(b)
      entries.push(...pays)
      for (const p of b.payments ?? []) {
        if (confirmed(p)) paidCents += p.amountCents
        if (refunded(p)) refundedCents += p.amountCents
      }

      const comms = communicationEntries(b)
      communications += comms.length
      entries.push(...comms)

      if (opts.includeAudit) entries.push(...auditEntries(b))
    }

    if (tokens.length < pageSize) break
  }

  entries.sort((a, b) => b.at - a.at || a.bookingToken.localeCompare(b.bookingToken))
  bookings.sort((a, b) => b.createdAt - a.createdAt)

  return {
    customer,
    linkProvenance: 'derived',
    bookings,
    entries,
    totals: { bookings: bookings.length, paidCents, refundedCents, communications },
    conflicts,
    scan: {
      indexed, scanned, read,
      complete: !pageLimitReached && missingRecords === 0 && scanned >= Math.min(indexed, SCAN_MAX),
      pageLimitReached,
      unlinkedNoIdentifier,
      missingRecords,
    },
    includesAudit: !!opts.includeAudit,
  }
}

export type { CustomerLink }
