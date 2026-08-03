// Sprint 3.1 Phase C — one shared, race-safe open-punch policy.
//
// Scope is deliberately SAME SERVICE DATE. That is the rule the crew portal has
// enforced since before Phase A; applying it to every ingress closes the public-link
// divergence without silently introducing the stricter global payroll rule. The
// Phase A report continues to expose both same-date and global overlap counts.
//
// Correctness properties:
//   • default OFF: no lock, scan, or behavioural change;
//   • one tenant-scoped lock per staff member serializes competing clock-ins on
//     different jobs (a check followed by two per-job locks is otherwise racy);
//   • complete route + booking scans, with fail-closed coverage checks;
//   • effective (correction-adjusted) punches, matching Timesheets and Phase A;
//   • no identifiers leave this module.

import { scanAllRoutes } from '../routes'
import {
  effectiveServiceDate,
  readBookingsByTokens,
  type Booking,
} from '../bookings'
import { isEnabled } from '../platform/flags'
import { withLock } from '../kv-lock'
import { effectivePunch, listCorrectionsForPunches, punchId } from '../time-corrections'
import { UNDATED_BUCKET, bucketFor, indexIsAuthoritative, lookupOtherOpenPunch } from './open-punch-index'
import { snapshotBookingTokens } from './open-punch-backfill'

const BOOKING_READ_PAGE = 500

export type PunchTarget = {
  type: 'route' | 'booking'
  jobToken: string
  staffId: string
  serviceDate: string
}

export type PunchPolicyBlock = 'other_open_punch' | 'coverage_unavailable' | 'busy' | 'undated_job'

export type PunchPolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; block: PunchPolicyBlock }

type Candidate = {
  id: string
  clockInAt: number | null
  clockOutAt: number | null
}

// The booking index is captured in ONE command by `snapshotBookingTokens`, so
// completeness is judged on count and uniqueness only. The previous version took
// two ZREVRANGE passes and compared their ORDER — and because `bk:index` is scored
// by updatedAt, any concurrent booking write reordered it and failed the check,
// turning ordinary booking traffic into clock-in refusals.
async function scanAllBookings(): Promise<{ complete: true; bookings: Booking[] } | { complete: false }> {
  const snap = await snapshotBookingTokens()
  if (!snap.ok) return { complete: false }

  const bookings: Booking[] = []
  for (let start = 0; start < snap.tokens.length; start += BOOKING_READ_PAGE) {
    const page = snap.tokens.slice(start, start + BOOKING_READ_PAGE)
    const loaded = await readBookingsByTokens(page)
    if (loaded.missing) return { complete: false }
    bookings.push(...loaded.bookings)
  }

  return { complete: true, bookings }
}

async function inspectOtherEffectiveOpenPunch(target: PunchTarget): Promise<boolean | null> {
  const routes = await scanAllRoutes()
  if (!routes.complete) return null

  // Historical booking punches remain payroll evidence even if the booking
  // assignment feature is later switched off, so the policy always reads them.
  const bookingScan = await scanAllBookings()
  if (!bookingScan.complete) return null

  const targetId = punchId(target.type, target.jobToken, target.staffId)
  const candidates: Candidate[] = []

  // An UNDATED candidate conflicts with everything. We cannot prove it belongs to
  // a different day, and letting it fall out of the comparison is exactly how a
  // real open punch disappears from enforcement. The index applies the same rule
  // via its `__undated__` bucket, so both paths answer identically.
  const conflictsWithTarget = (serviceDate: string) =>
    bucketFor(serviceDate) === UNDATED_BUCKET || serviceDate === target.serviceDate

  for (const route of routes.routes) {
    if (!conflictsWithTarget(route.routeDate)) continue
    for (const assignee of route.assignees ?? []) {
      if (assignee.staffId !== target.staffId) continue
      const id = punchId('route', route.token, assignee.staffId)
      if (id === targetId) continue
      candidates.push({
        id,
        clockInAt: assignee.clockInAt ?? null,
        clockOutAt: assignee.clockOutAt ?? null,
      })
    }
  }

  for (const booking of bookingScan.bookings) {
    if (!conflictsWithTarget(effectiveServiceDate(booking))) continue
    for (const assignee of booking.assignees ?? []) {
      if (assignee.staffId !== target.staffId) continue
      const id = punchId('booking', booking.token, assignee.staffId)
      if (id === targetId) continue
      candidates.push({
        id,
        clockInAt: assignee.clockInAt ?? null,
        clockOutAt: assignee.clockOutAt ?? null,
      })
    }
  }

  if (!candidates.length) return false

  let corrections: Awaited<ReturnType<typeof listCorrectionsForPunches>>
  try {
    corrections = await listCorrectionsForPunches(candidates.map(candidate => candidate.id))
  } catch {
    return null
  }

  return candidates.some(candidate => {
    const effective = effectivePunch(candidate, corrections.get(candidate.id) ?? [])
    return effective.clockInAt != null && effective.clockOutAt == null
  })
}

/**
 * Answer from the INDEX when it is authoritative, otherwise from the complete
 * scan. `null` means the answer is unknown and the caller must fail closed.
 *
 * The index is authoritative only when its flag is on AND a completion marker
 * from a successful backfill exists, so a half-built index is never consulted. A
 * store failure on the indexed path returns `null` rather than falling back to the
 * scan: silently swapping in a lookup that costs thousands of Redis commands is
 * how a degraded store becomes an outage.
 */
async function hasOtherEffectiveOpenPunch(target: PunchTarget, indexed: boolean): Promise<boolean | null> {
  if (indexed) {
    const hit = await lookupOtherOpenPunch(
      target.staffId,
      target.serviceDate,
      punchId(target.type, target.jobToken, target.staffId),
    )
    return hit.ok ? hit.otherOpen : null
  }
  try {
    return await inspectOtherEffectiveOpenPunch(target)
  } catch {
    // A store/parse failure means coverage is unknown. Callers surface a retryable
    // 503 and write nothing; enforcement never degrades to an unlocked guess.
    return null
  }
}

/**
 * Run a clock-in under the Phase C policy. Clock-outs and flag-off calls execute
 * directly because they cannot create a second open punch. The callback performs
 * the existing per-job locked write only after the staff lock and complete scan
 * have established that no other effective punch is open.
 */
export async function withSingleOpenPunchPolicy<T>(
  action: 'clock_in' | 'clock_out',
  target: PunchTarget,
  write: () => Promise<T>,
): Promise<PunchPolicyResult<T>> {
  if (action !== 'clock_in' || !isEnabled('SINGLE_OPEN_PUNCH_ENABLED')) {
    return { ok: true, value: await write() }
  }
  if (!target.staffId.trim() || !target.jobToken.trim()) {
    return { ok: false, block: 'coverage_unavailable' }
  }
  // A job with no service date has no "same service date" to compare against, so
  // the rule is undefined for it. Refusing is the fail-closed answer, and it is a
  // PERMANENT condition rather than a retryable one — dispatch has to set a date —
  // so it gets its own block reason instead of the retryable 503. An undated punch
  // that is already OPEN still blocks others; only opening a new one is refused.
  if (!target.serviceDate.trim()) {
    return { ok: false, block: 'undated_job' }
  }

  // Lock timing follows the critical section it protects. The indexed lookup is two
  // sorted-set reads, so a holder is gone in milliseconds and a short, snappy retry
  // clears contention. The scan fallback loads every route and booking, so it keeps
  // the long lease and the patient retry — using the indexed timings there would
  // turn every concurrent clock-in into a spurious `busy`.
  const indexed = await indexIsAuthoritative()
  const timings = indexed
    ? { ttlMs: 5_000, attempts: 25, backoffMs: 20 }
    : { ttlMs: 10_000, attempts: 40, backoffMs: 50 }

  return withLock<PunchPolicyResult<T>>(
    `time:staff-lock:${target.staffId}`,
    async lock => {
      const otherOpen = await hasOtherEffectiveOpenPunch(target, indexed)
      if (otherOpen == null) return { ok: false, block: 'coverage_unavailable' }
      if (otherOpen) return { ok: false, block: 'other_open_punch' }
      try {
        await lock?.assertHeld()
      } catch {
        return { ok: false, block: 'busy' }
      }
      return { ok: true, value: await write() }
    },
    {
      ...timings,
      renew: true,
      holder: `punch-${target.staffId}`,
      onStoreError: 'busy',
      onBusy: () => ({ ok: false, block: 'busy' }),
    },
  )
}
