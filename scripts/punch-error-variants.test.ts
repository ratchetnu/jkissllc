// Issue #184 — every punch failure reaches the crew member as itself.
//
// `/api/portal/clock` used to map six variants explicitly and then
// `return 404 not_found` for everything else. Two consequences, both silent:
//
//   • A DEACTIVATED crew member (`inactive_staff`) was told the job did not
//     exist, so the one message that would tell them to call dispatch never
//     appeared.
//   • Any variant added later inherited that 404. TypeScript cannot see through
//     an if/else fallthrough, so nothing would have failed to warn us — which is
//     precisely how this shipped in the first place.
//
// The contract is now a `Record` over the union (exhaustive by type) plus a
// `never`-guarded switch for policy blocks. These tests pin the behaviour AND the
// exhaustiveness, because a type-level guarantee that no test exercises is a
// guarantee that can be deleted by accident.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PUNCH_ERROR, punchError, policyBlockToPunchError,
  type PunchErrorCode, type PunchErrorResponse,
} from '../app/lib/timeclock/punch-errors'

// The full union, written out by hand ON PURPOSE. If someone adds a variant and
// forgets this list, the `Record` lookup below still type-checks — but the count
// assertion fails, so the omission surfaces here rather than in production.
const ALL_CODES: PunchErrorCode[] = [
  'disabled', 'not_found', 'unknown_staff', 'inactive_staff', 'unknown_equipment',
  'duplicate_staff', 'not_assigned', 'conflict', 'invalid',
  'not_confirmed', 'not_clocked_in', 'other_open_punch',
  'punch_policy_unavailable', 'undated_job',
]

test('every variant in the union has a response — none falls through', () => {
  const mapped = Object.keys(PUNCH_ERROR) as PunchErrorCode[]
  assert.equal(mapped.length, ALL_CODES.length, 'PUNCH_ERROR covers exactly the union')
  for (const code of ALL_CODES) {
    const r = PUNCH_ERROR[code]
    assert.ok(r, `${code} has no response`)
    assert.ok(r.status >= 400 && r.status < 600, `${code} status ${r.status} is not an error status`)
    assert.ok(r.message.trim().length > 0, `${code} has an empty message`)
  }
})

test('no variant is answered with a bare machine code — every message is human', () => {
  // The old fallthrough returned the literal string "not_found" as the body. A
  // crew member on a phone at 7am reads the message, not the enum.
  for (const code of ALL_CODES) {
    const { message } = PUNCH_ERROR[code]
    assert.ok(!/^[a-z_]+$/.test(message), `${code} answers with a machine code: "${message}"`)
    assert.match(message, /[.!]$/, `${code} message is not a sentence: "${message}"`)
  }
})

// ── The specific bug #184 was opened for ────────────────────────────────────

test('a deactivated crew member is told their account is inactive, not "not found"', () => {
  const r = PUNCH_ERROR.inactive_staff
  assert.equal(r.status, 403, 'inactive_staff must not be a 404')
  assert.match(r.message, /inactive/i)
  assert.match(r.message, /dispatch/i, 'must tell them who to contact')
})

test('variants that must NOT confirm a job exists stay 404', () => {
  // Deliberate, and different from the bug above: these people have no business
  // learning whether the job is real, so an honest 403 would itself be a leak.
  for (const code of ['not_assigned', 'unknown_staff', 'not_found', 'disabled'] as const) {
    assert.equal(PUNCH_ERROR[code].status, 404, `${code} should stay 404`)
  }
})

// ── Retryability is a promise, not a decoration ─────────────────────────────

test('only genuinely transient failures are retryable 503s', () => {
  const retryable = ALL_CODES.filter(c => PUNCH_ERROR[c].status === 503)
  assert.deepEqual(retryable, ['punch_policy_unavailable'],
    'a 503 tells the client to retry — only "we could not check" qualifies')
})

test('undated_job is 409, never 503 — retrying cannot fix it', () => {
  // Permanent until dispatch sets a date. A 503 would invite a retry loop against
  // a condition the crew member has no power to change.
  assert.equal(PUNCH_ERROR.undated_job.status, 409)
  assert.match(PUNCH_ERROR.undated_job.message, /dispatch/i)
})

test('other_open_punch tells them what to DO, not just what failed', () => {
  const m = PUNCH_ERROR.other_open_punch.message
  assert.match(m, /clock out/i, 'must name the action that unblocks them')
  assert.equal(PUNCH_ERROR.other_open_punch.status, 409)
})

// ── Policy blocks ───────────────────────────────────────────────────────────

test('every policy block maps to a punch error', () => {
  assert.equal(policyBlockToPunchError('other_open_punch'), 'other_open_punch')
  assert.equal(policyBlockToPunchError('undated_job'), 'undated_job')
  assert.equal(policyBlockToPunchError('busy'), 'punch_policy_unavailable')
  assert.equal(policyBlockToPunchError('coverage_unavailable'), 'punch_policy_unavailable')
})

test('an unknown policy block THROWS rather than silently becoming retryable', () => {
  // The old code ended in `: 'punch_policy_unavailable'`, so a new block became a
  // 503 with no signal. Now the `never` guard makes it a compile error — and at
  // runtime, a loud throw instead of a quiet wrong answer.
  assert.throws(
    // @ts-expect-error — deliberately outside the union, which is the point
    () => policyBlockToPunchError('some_future_permanent_block'),
    /unhandled punch policy block/,
  )
})

test('busy and coverage_unavailable collapse deliberately, and both stay retryable', () => {
  for (const b of ['busy', 'coverage_unavailable'] as const) {
    const code = policyBlockToPunchError(b)
    assert.equal(PUNCH_ERROR[code].status, 503, `${b} must remain retryable`)
  }
})

// ── Per-surface overrides ───────────────────────────────────────────────────

test('an override changes only the code it names', () => {
  const overrides: Partial<Record<PunchErrorCode, PunchErrorResponse>> = {
    conflict: { status: 503, message: 'The job is being updated — please try again.' },
  }
  assert.equal(punchError('conflict', overrides).status, 503, 'override applies')
  assert.equal(punchError('conflict').status, 409, 'default is untouched')
  assert.deepEqual(punchError('inactive_staff', overrides), PUNCH_ERROR.inactive_staff,
    'an unrelated code is unaffected by the override')
})

test('the /api/portal/clock divergence is carried deliberately, not accidentally', () => {
  // clock answers a CAS conflict with a retryable 503; jobs/[id] answers 409.
  // Both are live and both are defensible. This test exists so that if someone
  // unifies them later it is a decision with a failing test in front of it,
  // rather than a silent change to a crew-facing endpoint.
  assert.equal(PUNCH_ERROR.conflict.status, 409, 'the shared default is 409')
})
