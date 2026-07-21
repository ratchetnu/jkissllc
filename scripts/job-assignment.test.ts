// Shared crew + equipment assignment model for operational work. Pure functions
// only — no Redis, no clock. The load-bearing guarantees under test:
//
//   1. lib/routes.Assignee structurally satisfies JobAssignee (one shared shape,
//      not two parallel ones) — enforced at compile time by the assignment below.
//   2. The legacy assignedTo/assignedHelper strings a customer sees are derived
//      from the crew list identically to what an owner would have typed.
//   3. Pay snapshots freeze and never silently zero.
//   4. The flag is off by default, so nothing about a booking changes today.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type JobAssignee, type JobEquipment,
  isDriverRole, isHelperRole, activeCrew,
  deriveLegacyCrewNames, makeJobAssignee, applyPaySnapshot, clearJobPay,
  jobCrewGap, hasEquipment, validateAssignees, sanitizeCompletionPhotos,
} from '../app/lib/job-assignment'
import type { Assignee } from '../app/lib/routes'
import { fmtCents } from '../app/lib/finance'
import { FLAG_DEFAULTS, isEnabled } from '../app/lib/platform/flags'

// ── helpers ──────────────────────────────────────────────────────────────────
const crew = (o: Partial<JobAssignee> & { staffId: string }): JobAssignee =>
  ({ name: o.staffId, token: 't_' + o.staffId, ...o })

// ── The shared-shape contract ────────────────────────────────────────────────
test('a routes Assignee structurally satisfies JobAssignee (one shape, not two)', () => {
  const routeAssignee: Assignee = {
    staffId: 's1', name: 'Marcus', token: 'tok1', role: 'Driver',
    payCents: 17500, paySource: 'crew_default', pay: '$175.00',
    clockInAt: 1000, reminderSentAt: 500,
  } as Assignee

  // If Assignee ever drifts from the shared shape this line stops compiling —
  // which is the point. The portal/timeclock/pay layers are written once.
  const shared: JobAssignee = routeAssignee
  assert.equal(shared.staffId, 's1')
  assert.equal(shared.payCents, 17500)

  // And the derivation works on route crew unchanged.
  assert.deepEqual(deriveLegacyCrewNames([shared]), { assignedTo: 'Marcus', assignedHelper: undefined })
})

// ── Role matching ────────────────────────────────────────────────────────────
test('role matching is substring + case-insensitive, like routes.crewGap', () => {
  assert.equal(isDriverRole('Driver'), true)
  assert.equal(isDriverRole('lead driver'), true)
  assert.equal(isDriverRole('DRIVER / Loader'), true)
  assert.equal(isDriverRole('Helper'), false)
  assert.equal(isDriverRole(undefined), false)

  assert.equal(isHelperRole('Helper / Loader'), true)
  assert.equal(isHelperRole('helper'), true)
  assert.equal(isHelperRole('Driver'), false)
})

test('declined crew are not active', () => {
  const list = [crew({ staffId: 'a' }), crew({ staffId: 'b', declinedAt: 123 })]
  assert.deepEqual(activeCrew(list).map(a => a.staffId), ['a'])
  assert.deepEqual(activeCrew(undefined), [])
})

// ── The legacy compatibility bridge — the customer-facing guarantee ──────────
test('empty crew derives undefined, never empty strings', () => {
  // An unassigned booking must stay indistinguishable from one never touched, or
  // the confirmation page starts rendering an empty "Assigned to:" line.
  assert.deepEqual(deriveLegacyCrewNames([]), { assignedTo: undefined, assignedHelper: undefined })
  assert.deepEqual(deriveLegacyCrewNames(undefined), { assignedTo: undefined, assignedHelper: undefined })
})

test('the first driver becomes the lead, regardless of list order', () => {
  const out = deriveLegacyCrewNames([
    crew({ staffId: 's1', name: 'Dre', role: 'Helper' }),
    crew({ staffId: 's2', name: 'Marcus', role: 'Driver' }),
  ])
  assert.deepEqual(out, { assignedTo: 'Marcus', assignedHelper: 'Dre' })
})

test('with no driver on the job the first crew member leads', () => {
  const out = deriveLegacyCrewNames([
    crew({ staffId: 's1', name: 'Dre', role: 'Helper' }),
    crew({ staffId: 's2', name: 'Tay', role: 'Helper' }),
  ])
  assert.deepEqual(out, { assignedTo: 'Dre', assignedHelper: 'Tay' })
})

test('declined crew never surface to the customer', () => {
  const out = deriveLegacyCrewNames([
    crew({ staffId: 's1', name: 'Marcus', role: 'Driver' }),
    crew({ staffId: 's2', name: 'Dre', role: 'Helper', declinedAt: 999 }),
  ])
  assert.deepEqual(out, { assignedTo: 'Marcus', assignedHelper: undefined })
})

test('a solo driver yields a lead and no helper', () => {
  const out = deriveLegacyCrewNames([crew({ staffId: 's1', name: 'Marcus', role: 'Driver' })])
  assert.deepEqual(out, { assignedTo: 'Marcus', assignedHelper: undefined })
})

test('only the first two crew are represented — that is the legacy field shape', () => {
  const out = deriveLegacyCrewNames([
    crew({ staffId: 's1', name: 'Marcus', role: 'Driver' }),
    crew({ staffId: 's2', name: 'Dre', role: 'Helper' }),
    crew({ staffId: 's3', name: 'Tay', role: 'Helper' }),
  ])
  assert.deepEqual(out, { assignedTo: 'Marcus', assignedHelper: 'Dre' })
})

test('derived names are trimmed and capped at 80 chars, matching the admin validator', () => {
  const long = 'M'.repeat(120)
  const out = deriveLegacyCrewNames([crew({ staffId: 's1', name: '  ' + long + '  ', role: 'Driver' })])
  assert.equal(out.assignedTo?.length, 80)
  // A derived value can never exceed what a typed one could.
  assert.equal(out.assignedTo, 'M'.repeat(80))
})

test('blank-named crew are skipped rather than rendering an empty assignment', () => {
  const out = deriveLegacyCrewNames([
    crew({ staffId: 's1', name: '   ', role: 'Driver' }),
    crew({ staffId: 's2', name: 'Dre', role: 'Helper' }),
  ])
  assert.deepEqual(out, { assignedTo: 'Dre', assignedHelper: undefined })
})

// ── Construction + pay snapshot ──────────────────────────────────────────────
test('makeJobAssignee carries the roster identity and the supplied token', () => {
  const a = makeJobAssignee({ id: 's1', name: 'Marcus', phone: '555', role: 'Driver' }, 'tok_abc')
  // Pay is deliberately absent — rate policy belongs to lib/finance. Asserted
  // BEFORE the deepEqual below, which narrows `a` to its expected literal shape.
  assert.equal(a.payCents, undefined)
  assert.deepEqual(a, { staffId: 's1', name: 'Marcus', phone: '555', role: 'Driver', token: 'tok_abc' })
})

test('makeJobAssignee lets the job override the roster role', () => {
  const a = makeJobAssignee({ id: 's1', name: 'Marcus', role: 'Driver' }, 'tok', { role: 'Helper' })
  assert.equal(a.role, 'Helper')
})

test('applyPaySnapshot freezes cents, source, and the legacy display mirror', () => {
  const a = crew({ staffId: 's1' })
  applyPaySnapshot(a, { cents: 17500, source: 'crew_default' }, fmtCents)
  assert.equal(a.payCents, 17500)
  assert.equal(a.paySource, 'crew_default')
  assert.equal(a.pay, '$175.00')   // route-pay.ts parses this form back correctly
})

test('a failed rate lookup never wipes an existing snapshot', () => {
  const a = crew({ staffId: 's1', payCents: 17500, paySource: 'manual', pay: '$175.00' })
  applyPaySnapshot(a, null, fmtCents)
  assert.equal(a.payCents, 17500, 'null must no-op, not zero the frozen amount')
  assert.equal(a.paySource, 'manual')
})

test('clearJobPay unconditionally returns a crew member to unpriced', () => {
  const a = crew({ staffId: 's1', payCents: 17500, paySource: 'manual', pay: '$175.00' })
  clearJobPay(a)
  assert.equal(a.payCents, undefined)
  assert.equal(a.paySource, undefined)
  assert.equal(a.pay, undefined)
})

// ── Gaps ─────────────────────────────────────────────────────────────────────
test('an unassigned job needs crew', () => {
  const g = jobCrewGap([], 2)
  assert.equal(g.needsCrew, true)
  assert.equal(g.short, true)
  assert.equal(g.incomplete, true)
  assert.equal(g.assigned, 0)
  assert.equal(g.required, 2)
})

test('a job with no crewSize only requires that someone is on it', () => {
  assert.equal(jobCrewGap([crew({ staffId: 's1' })]).incomplete, false)
  assert.equal(jobCrewGap([crew({ staffId: 's1' })], 0).required, 1)
})

test('a 2-person job with nobody driving is flagged', () => {
  const g = jobCrewGap([crew({ staffId: 's1', role: 'Helper' }), crew({ staffId: 's2', role: 'Helper' })], 2)
  assert.equal(g.needsDriver, true)
  assert.equal(g.short, false)
  assert.equal(g.incomplete, true)
})

test('a fully crewed 2-person job with a driver is complete', () => {
  const g = jobCrewGap([crew({ staffId: 's1', role: 'Driver' }), crew({ staffId: 's2', role: 'Helper' })], 2)
  assert.equal(g.incomplete, false)
})

test('declined crew count against the requirement', () => {
  const g = jobCrewGap([
    crew({ staffId: 's1', role: 'Driver' }),
    crew({ staffId: 's2', role: 'Helper', declinedAt: 1 }),
  ], 2)
  assert.equal(g.assigned, 1)
  assert.equal(g.short, true, 'a declined helper leaves the job short')
})

test('a fractional crewSize floors rather than demanding a partial person', () => {
  assert.equal(jobCrewGap([crew({ staffId: 's1' })], 1.9).required, 1)
})

// ── Equipment ────────────────────────────────────────────────────────────────
test("crew's own equipment counts as equipped", () => {
  assert.equal(hasEquipment({ vehicle: "Crew's own equipment" }), true)
  assert.equal(hasEquipment({ equipmentId: 'eq_1' }), true)
  assert.equal(hasEquipment({ vehicle: '   ' }), false)
  assert.equal(hasEquipment({}), false)
  assert.equal(hasEquipment(undefined), false)
})

test('JobEquipment matches the RouteRecord convention', () => {
  const e: JobEquipment = { equipmentId: 'eq_1', vehicle: '26ft Box Truck #1' }
  assert.equal(hasEquipment(e), true)
})

// ── Validation ───────────────────────────────────────────────────────────────
test('the same person cannot be assigned twice', () => {
  const problems = validateAssignees([crew({ staffId: 's1' }), crew({ staffId: 's1', token: 't2' })])
  assert.deepEqual(problems, ['duplicate_staff'])
})

test('a crew member with no roster link is rejected — that is the old free-text bug', () => {
  assert.deepEqual(validateAssignees([{ staffId: '', name: 'Marcus', token: 't' }]), ['missing_staff_id'])
  assert.deepEqual(validateAssignees([{ staffId: '  ', name: 'Marcus', token: 't' }]), ['missing_staff_id'])
})

test('a missing or reused job-link token is rejected', () => {
  assert.deepEqual(validateAssignees([{ staffId: 's1', name: 'M', token: '' }]), ['missing_token'])
  assert.deepEqual(
    validateAssignees([{ staffId: 's1', name: 'M', token: 'same' }, { staffId: 's2', name: 'D', token: 'same' }]),
    ['duplicate_token'],
  )
})

test('a well-formed crew list has no problems', () => {
  assert.deepEqual(validateAssignees([crew({ staffId: 's1' }), crew({ staffId: 's2' })]), [])
  assert.deepEqual(validateAssignees([]), [])
  assert.deepEqual(validateAssignees(undefined), [])
})

// ── Completion proof ─────────────────────────────────────────────────────────
test('completion photos accept only http(s) urls, deduped', () => {
  const out = sanitizeCompletionPhotos([
    'https://blob.vercel-storage.com/a.jpg',
    'https://blob.vercel-storage.com/a.jpg',   // dup
    'javascript:alert(1)',                      // rejected
    'data:image/png;base64,AAAA',               // rejected
    '  https://blob.vercel-storage.com/b.jpg ', // trimmed
    42,                                         // rejected
  ])
  assert.deepEqual(out, ['https://blob.vercel-storage.com/a.jpg', 'https://blob.vercel-storage.com/b.jpg'])
})

test('completion photos are capped and non-arrays are safe', () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://x/${i}.jpg`)
  assert.equal(sanitizeCompletionPhotos(many).length, 20)
  assert.equal(sanitizeCompletionPhotos(many, 3).length, 3)
  assert.deepEqual(sanitizeCompletionPhotos(null), [])
  assert.deepEqual(sanitizeCompletionPhotos('nope'), [])
})

// ── The flag-off guarantee ───────────────────────────────────────────────────
test('BOOKING_ASSIGNMENT_ENABLED is off by default', () => {
  assert.equal(FLAG_DEFAULTS.BOOKING_ASSIGNMENT_ENABLED, false)
  assert.equal(isEnabled('BOOKING_ASSIGNMENT_ENABLED', {}), false)
  assert.equal(isEnabled('BOOKING_ASSIGNMENT_ENABLED', { BOOKING_ASSIGNMENT_ENABLED: 'true' }), true)
})
