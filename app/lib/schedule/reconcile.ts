// ─────────────────────────────────────────────────────────────────────────────
// Existing-data reconciliation — SAFE, DRY-RUN-FIRST classifier.
//
// Because Book Now already persists every request as a canonical Booking (bk:*),
// there is no historical mass-conversion to run and no separate job table to
// back-fill. This tool instead CLASSIFIES existing bookings so the owner can see,
// at a glance, which records are pure requests, which are accepted-but-unscheduled,
// which are cleanly scheduled, which look duplicated, and which are ambiguous and
// must go to human review. It is PURE (no Redis) and never mutates anything — the
// runner (scripts/reconcile-book-now.ts) only reads and prints. Rollback is
// therefore trivial: nothing is written.
// ─────────────────────────────────────────────────────────────────────────────

import type { Booking } from '../bookings'
import { effectiveServiceDate, isClosed } from '../bookings'

export type ReconClass =
  | 'request_only'              // an intake request, not accepted, no date
  | 'accepted_but_unscheduled'  // paid/accepted but no service date yet
  | 'scheduled_and_linked'      // has a date AND is confirmed operational work
  | 'scheduled_but_missing_job' // has a date but is NOT confirmed work (needs wiring)
  | 'duplicate'                 // shares customer+date+service (or idem key) with another
  | 'completed'                 // terminal — done
  | 'cancelled'                 // terminal — cancelled/refunded
  | 'ambiguous'                 // conflicting signals — owner review, never auto-touched

export const RECON_CLASS_LABEL: Record<ReconClass, string> = {
  request_only: 'Request only',
  accepted_but_unscheduled: 'Accepted but unscheduled',
  scheduled_and_linked: 'Scheduled and linked',
  scheduled_but_missing_job: 'Scheduled but not confirmed work',
  duplicate: 'Possible duplicate',
  completed: 'Completed',
  cancelled: 'Cancelled',
  ambiguous: 'Ambiguous — needs review',
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const norm = (s?: string): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const CANCELLED = new Set<Booking['status']>(['cancelled', 'refunded'])
const COMPLETED = new Set<Booking['status']>(['completed', 'partially_completed', 'could_not_complete'])
// Confirmed operational work (a real, committed job on the board).
const CONFIRMED_WORK = new Set<Booking['status']>(['booking_created', 'confirmed', 'in_progress', 'continued'])
// Signals the customer has accepted / paid (so it should become scheduled work).
const ACCEPTED = new Set<Booking['status']>(['payment_received', 'time_verified', 'confirmed'])

function realDate(b: Booking): boolean {
  return ISO.test(effectiveServiceDate(b) || '')
}
function isAccepted(b: Booking): boolean {
  return b.amountPaidCents > 0 || ACCEPTED.has(b.status)
}

// Build the set of tokens that are part of a duplicate cluster — same customer +
// service date + service type (among non-cancelled records), or a shared
// idempotency key. Deterministic and order-independent.
export function findDuplicateTokens(bookings: Booking[]): Set<string> {
  const dup = new Set<string>()
  const byKey = new Map<string, Booking[]>()
  const byIdem = new Map<string, Booking[]>()
  for (const b of bookings) {
    if (CANCELLED.has(b.status)) continue
    const d = effectiveServiceDate(b) || ''
    if (ISO.test(d)) {
      const k = `${norm(b.customerName)}|${d}|${b.serviceType}`
      ;(byKey.get(k) ?? byKey.set(k, []).get(k)!).push(b)
    }
    const idem = b.idempotencyKey?.trim()
    if (idem) (byIdem.get(idem) ?? byIdem.set(idem, []).get(idem)!).push(b)
  }
  for (const group of [...byKey.values(), ...byIdem.values()]) {
    const tokens = new Set(group.map(b => b.token))
    if (tokens.size > 1) for (const t of tokens) dup.add(t)
  }
  return dup
}

// Classify ONE booking given the precomputed duplicate set. Precedence is
// deliberate: terminal states first, then duplicates, then scheduled vs not.
export function classifyBooking(b: Booking, duplicates: Set<string>): ReconClass {
  if (CANCELLED.has(b.status)) return 'cancelled'
  if (COMPLETED.has(b.status) || isClosed(b)) return 'completed'
  if (duplicates.has(b.token)) return 'duplicate'

  if (realDate(b)) {
    return CONFIRMED_WORK.has(b.status) || b.status === 'confirmed'
      ? 'scheduled_and_linked'
      : 'scheduled_but_missing_job'
  }
  // No real service date.
  if (isAccepted(b)) return 'accepted_but_unscheduled'
  // Pure intake states with nothing paid and no date.
  if (b.status === 'quote_received' || b.status === 'pending_payment' ||
      b.status === 'pending_zelle_verification' || b.status === 'confirmation_link_sent' ||
      b.status === 'customer_viewed' || b.status === 'time_verification_pending') {
    return 'request_only'
  }
  return 'ambiguous'
}

export type ReconRecord = { token: string; number: string; customer: string; status: string; date: string; class: ReconClass; source?: string }
export type ReconReport = {
  scannedAt: number
  total: number
  counts: Record<ReconClass, number>
  records: ReconRecord[]
  // Records that must NOT be auto-touched — ambiguous or flagged duplicate.
  reviewRequired: ReconRecord[]
}

export function reconcile(bookings: Booking[], scannedAt: number): ReconReport {
  const duplicates = findDuplicateTokens(bookings)
  const counts = {
    request_only: 0, accepted_but_unscheduled: 0, scheduled_and_linked: 0,
    scheduled_but_missing_job: 0, duplicate: 0, completed: 0, cancelled: 0, ambiguous: 0,
  } as Record<ReconClass, number>

  const records: ReconRecord[] = bookings.map(b => {
    const cls = classifyBooking(b, duplicates)
    counts[cls]++
    return {
      token: b.token, number: b.bookingNumber, customer: b.customerName,
      status: b.status, date: effectiveServiceDate(b) || '', class: cls,
      source: b.source,
    }
  })

  return {
    scannedAt,
    total: bookings.length,
    counts,
    records,
    reviewRequired: records.filter(r => r.class === 'ambiguous' || r.class === 'duplicate'),
  }
}
