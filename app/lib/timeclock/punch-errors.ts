// ── The punch engine's error contract ────────────────────────────────────────
//
// #153 consolidated the punch ENGINE. This consolidates how its failures reach a
// crew member, which had drifted into two shapes:
//
//   portal/jobs/[id]  a Record over the full union — exhaustive, so adding a
//                     variant breaks the build until it is handled.
//   portal/clock      an if/else chain ending in `return 404 not_found` — every
//                     unlisted variant silently became "job not found".
//
// The second is the failure mode issue #184 was opened for. A deactivated crew
// member (`inactive_staff`) was told the job did not exist, and any variant added
// later would inherit that same misleading 404 with nothing failing to warn us —
// TypeScript cannot see through an if/else fallthrough.
//
// One exhaustive map fixes both: the compiler now refuses a missing case.
import type { AssignmentError } from '../booking-assignment'
import type { PunchPolicyBlock } from './punch-policy'

/** Every failure `punchBookingClock` can return. Mirrors `BookingPunch`. */
export type PunchErrorCode =
  | AssignmentError
  | 'not_confirmed'
  | 'not_clocked_in'
  | 'other_open_punch'
  | 'punch_policy_unavailable'
  | 'undated_job'

export type PunchErrorResponse = { status: number; message: string }

/**
 * The default status + copy per failure. Exhaustive BY TYPE — a new member of
 * `AssignmentError` or of the punch variants fails compilation here first, which
 * is the whole point of the file.
 *
 * The 404s are deliberate and are not laziness: `not_assigned`, `unknown_staff`
 * and `disabled` must never confirm that a job exists to someone who has no
 * business knowing. `inactive_staff` is the one that legitimately differs — that
 * person IS on the roster, so telling them their account is inactive leaks
 * nothing and is the only way they learn to call dispatch.
 */
export const PUNCH_ERROR: Record<PunchErrorCode, PunchErrorResponse> = {
  disabled:          { status: 404, message: 'Not found.' },
  not_found:         { status: 404, message: 'Job not found.' },
  not_assigned:      { status: 404, message: 'Job not found.' },
  unknown_staff:     { status: 404, message: 'Job not found.' },
  inactive_staff:    { status: 403, message: 'Your account is inactive. Contact dispatch.' },
  unknown_equipment: { status: 400, message: 'That equipment is not on the roster.' },
  duplicate_staff:   { status: 409, message: 'You are already on this job.' },
  conflict:          { status: 409, message: 'This job is being updated — please try again.' },
  invalid:           { status: 400, message: 'That action is not valid.' },
  not_confirmed:     { status: 409, message: 'Accept the job before you clock in.' },
  not_clocked_in:    { status: 409, message: 'Clock in before you clock out.' },
  other_open_punch:  { status: 409, message: 'You’re still clocked into another job on this service date. Clock out there first.' },
  punch_policy_unavailable: { status: 503, message: 'Could not verify your other punches — please try again.' },
  // Permanent until dispatch sets a date, so 409 rather than a retryable 503 —
  // "try again" would invite a loop against a condition the crew cannot change.
  undated_job:       { status: 409, message: 'This job has no service date yet. Ask dispatch to set one before clocking in.' },
}

/**
 * Resolve a failure, allowing a surface to keep copy or a status it already ships.
 *
 * This exists for one real case rather than as generic flexibility: `/api/portal/clock`
 * has always returned `conflict` as a retryable **503**, while `/api/portal/jobs/[id]`
 * returns **409**. Both are defensible and both are live. Unifying them would be an
 * unreviewed behaviour change to a crew-facing endpoint, so the divergence is carried
 * deliberately and visibly instead of being quietly normalised by this refactor.
 */
export function punchError(
  code: PunchErrorCode,
  overrides?: Partial<Record<PunchErrorCode, PunchErrorResponse>>,
): PunchErrorResponse {
  return overrides?.[code] ?? PUNCH_ERROR[code]
}

/**
 * Map a policy block to a punch error. An exhaustive `switch` with a `never`
 * guard, NOT an `else`.
 *
 * `PunchPolicyBlock` has four members but only three outcomes: `busy` and
 * `coverage_unavailable` both mean "we could not prove anything right now", which
 * is a retryable 503. That collapse is correct — but before this it happened via a
 * trailing `else`, so a fifth block (a PERMANENT one, say) would silently inherit
 * "try again" and invite a retry loop against something the crew cannot change.
 * The `never` check turns that into a compile error instead.
 */
export function policyBlockToPunchError(block: PunchPolicyBlock): PunchErrorCode {
  switch (block) {
    case 'other_open_punch': return 'other_open_punch'
    case 'undated_job': return 'undated_job'
    case 'busy':
    case 'coverage_unavailable': return 'punch_policy_unavailable'
    default: {
      const never: never = block
      throw new Error(`unhandled punch policy block: ${String(never)}`)
    }
  }
}
