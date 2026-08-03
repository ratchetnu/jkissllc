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
  countBookingIndex,
  effectiveServiceDate,
  readBookingsByTokens,
  scanBookingIndexPage,
  type Booking,
} from '../bookings'
import { isEnabled } from '../platform/flags'
import { withLock } from '../kv-lock'
import { effectivePunch, listCorrectionsForPunches, punchId } from '../time-corrections'

const BOOKING_SCAN_MAX = 20_000
const BOOKING_READ_PAGE = 500

export type PunchTarget = {
  type: 'route' | 'booking'
  jobToken: string
  staffId: string
  serviceDate: string
}

export type PunchPolicyBlock = 'other_open_punch' | 'coverage_unavailable' | 'busy'

export type PunchPolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; block: PunchPolicyBlock }

type Candidate = {
  id: string
  clockInAt: number | null
  clockOutAt: number | null
}

async function scanAllBookings(): Promise<{ complete: true; bookings: Booking[] } | { complete: false }> {
  const total = await countBookingIndex()
  if (total > BOOKING_SCAN_MAX) return { complete: false }

  const opening = total ? await scanBookingIndexPage(0, total) : []
  const unique = Array.from(new Set(opening))
  if (opening.length !== total || unique.length !== total) return { complete: false }

  const bookings: Booking[] = []
  for (let start = 0; start < unique.length; start += BOOKING_READ_PAGE) {
    const page = unique.slice(start, start + BOOKING_READ_PAGE)
    const loaded = await readBookingsByTokens(page)
    if (loaded.missing) return { complete: false }
    bookings.push(...loaded.bookings)
  }

  const closingTotal = await countBookingIndex()
  const closing = closingTotal ? await scanBookingIndexPage(0, closingTotal) : []
  if (
    closingTotal !== total ||
    closing.length !== opening.length ||
    !closing.every((token, index) => token === opening[index])
  ) return { complete: false }

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

  for (const route of routes.routes) {
    if (route.routeDate !== target.serviceDate) continue
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
    if (effectiveServiceDate(booking) !== target.serviceDate) continue
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

async function hasOtherEffectiveOpenPunch(target: PunchTarget): Promise<boolean | null> {
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
  if (!target.staffId.trim() || !target.jobToken.trim() || !target.serviceDate.trim()) {
    return { ok: false, block: 'coverage_unavailable' }
  }

  return withLock<PunchPolicyResult<T>>(
    `time:staff-lock:${target.staffId}`,
    async lock => {
      const otherOpen = await hasOtherEffectiveOpenPunch(target)
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
      ttlMs: 10_000,
      attempts: 40,
      backoffMs: 50,
      renew: true,
      holder: `punch-${target.staffId}`,
      onStoreError: 'busy',
      onBusy: () => ({ ok: false, block: 'busy' }),
    },
  )
}
