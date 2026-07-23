// Stable-id payroll migration (tenant-isolation doc 07 §businesses, roadmap Phase 2).
//
// The property that matters is money: after this migration a crew member is paid
// exactly what they were paid before, and a business RENAME stops silently erasing
// their per-business override. Both are asserted here, along with the doctrine that
// makes the cutover reversible — nothing is deleted and nothing conflicting is
// overwritten.

import assert from 'node:assert/strict'
import test from 'node:test'

import { planPayRekey, applyRekey, type BizIdentity, type StaffPayMap } from '../scripts/tenant-migration/payroll-lib'
import { resolveCrewPay } from '../app/lib/finance'

// Deterministic minter so a plan is reproducible in assertions.
const minter = () => { let n = 0; return () => `biz_${String(++n).padStart(32, '0')}` }

const BIZ: BizIdentity[] = [
  { key: 'amazon dsp', name: 'Amazon DSP' },
  { key: 'sysco', name: 'Sysco' },
]
const STAFF = (): StaffPayMap[] => [
  { id: 's1', name: 'Ana', payByBusiness: { 'amazon dsp': 20000, sysco: 18000 } },
  { id: 's2', name: 'Ben', payByBusiness: { 'amazon dsp': 22500 } },
  { id: 's3', name: 'Cal' },
]

test('plan mints one id per business and adds one override per legacy entry', () => {
  const plan = planPayRekey(BIZ, STAFF(), minter())
  assert.equal(plan.assignments.length, 2)
  assert.equal(plan.rekeys.length, 2, 'only staff with overrides are touched')
  assert.deepEqual(plan.skips, [])
  assert.equal(plan.noop, false)

  const amazonId = plan.assignments.find((a) => a.key === 'amazon dsp')!.stableId
  const ana = plan.rekeys.find((r) => r.staffId === 's1')!
  assert.equal(ana.add[amazonId], 20000, 'the new key carries the same cents')
})

test('pay resolves identically before and after the migration', () => {
  const staff = STAFF()
  const plan = planPayRekey(BIZ, staff, minter())
  const amazonId = plan.assignments.find((a) => a.key === 'amazon dsp')!.stableId

  const before = resolveCrewPay({ payByBusiness: staff[0].payByBusiness }, 'Amazon DSP')
  const migrated = { payByBusiness: applyRekey(staff[0].payByBusiness, plan.rekeys[0].add) }

  // Resolved by the new id, and still by the old name — both must agree with before.
  assert.deepEqual(resolveCrewPay(migrated, 'Amazon DSP', amazonId), before)
  assert.deepEqual(resolveCrewPay(migrated, 'Amazon DSP'), before, 'legacy path is untouched')
})

test('a rename loses the override on the legacy path and keeps it on the stable id', () => {
  // This is the defect the migration exists to fix — asserted directly so it cannot
  // silently regress or be declared fixed without evidence.
  const staff = STAFF()
  const plan = planPayRekey(BIZ, staff, minter())
  const amazonId = plan.assignments.find((a) => a.key === 'amazon dsp')!.stableId
  const migrated = { defaultPayCents: 15000, payByBusiness: applyRekey(staff[0].payByBusiness, plan.rekeys[0].add) }

  // The owner renames "Amazon DSP" → "Amazon Logistics".
  const byName = resolveCrewPay(migrated, 'Amazon Logistics')
  assert.deepEqual(byName, { cents: 15000, source: 'crew_default' }, 'name path silently falls back to the default rate')

  const byId = resolveCrewPay(migrated, 'Amazon Logistics', amazonId)
  assert.deepEqual(byId, { cents: 20000, source: 'crew_business' }, 'the stable id survives the rename')
})

test('re-running the plan is a no-op', () => {
  const staff = STAFF()
  const first = planPayRekey(BIZ, staff, minter())

  // Simulate the applied state: businesses carry ids, staff carry both keys.
  const after: BizIdentity[] = BIZ.map((b) => ({ ...b, stableId: first.assignments.find((a) => a.key === b.key)!.stableId }))
  const staffAfter: StaffPayMap[] = staff.map((s) => {
    const r = first.rekeys.find((x) => x.staffId === s.id)
    return r ? { ...s, payByBusiness: applyRekey(s.payByBusiness, r.add) } : s
  })

  const second = planPayRekey(after, staffAfter, minter())
  assert.equal(second.noop, true, 'second run changes nothing')
  assert.equal(second.assignments.length, 0, 'no business is given a second identity')
  assert.equal(second.rekeys.length, 0)
  assert.equal(second.alreadyMigrated, 3, 'all three legacy overrides are recognised as done')
})

test('an override for an unknown business is reported, never dropped', () => {
  const staff: StaffPayMap[] = [{ id: 's1', payByBusiness: { 'closed client': 19000 } }]
  const plan = planPayRekey(BIZ, staff, minter())
  assert.equal(plan.rekeys.length, 0)
  assert.equal(plan.skips.length, 1)
  assert.equal(plan.skips[0].reason, 'no_such_business')
  // The legacy value is still resolvable — the plan simply declined to twin it.
  assert.deepEqual(resolveCrewPay({ payByBusiness: staff[0].payByBusiness }, 'Closed Client'), { cents: 19000, source: 'crew_business' })
})

test('a disagreeing existing value is never overwritten', () => {
  const withId: BizIdentity[] = [{ key: 'amazon dsp', name: 'Amazon DSP', stableId: 'biz_aaaa' }]
  const staff: StaffPayMap[] = [{ id: 's1', payByBusiness: { 'amazon dsp': 20000, biz_aaaa: 17500 } }]
  const plan = planPayRekey(withId, staff, minter())
  assert.equal(plan.rekeys.length, 0, 'money that disagrees is left for a human')
  assert.equal(plan.skips[0].reason, 'value_conflict')
})

test('a non-numeric or negative override is skipped, not migrated', () => {
  const staff = [
    { id: 's1', payByBusiness: { 'amazon dsp': -1 } },
    { id: 's2', payByBusiness: { 'amazon dsp': 'free' as unknown as number } },
  ]
  const plan = planPayRekey(BIZ, staff, minter())
  assert.equal(plan.rekeys.length, 0)
  assert.deepEqual(plan.skips.map((s) => s.reason), ['invalid_value', 'invalid_value'])
})

test('applyRekey is additive — every legacy entry survives verbatim', () => {
  const legacy = { 'amazon dsp': 20000, sysco: 18000 }
  const out = applyRekey(legacy, { biz_x: 20000 })
  assert.equal(out['amazon dsp'], 20000)
  assert.equal(out.sysco, 18000)
  assert.equal(out.biz_x, 20000)
  assert.equal(Object.keys(out).length, 3)
  assert.deepEqual(legacy, { 'amazon dsp': 20000, sysco: 18000 }, 'input is not mutated')
})

test('resolveCrewPay without an id is byte-identical to the pre-migration behaviour', () => {
  // The guarantee that makes shipping this inert: no caller passes an id yet, and
  // no live pay map contains a stableId key until the migration is run.
  const s = { defaultPayCents: 17500, payByBusiness: { 'amazon dsp': 20000 } }
  assert.deepEqual(resolveCrewPay(s, 'Amazon DSP'), { cents: 20000, source: 'crew_business' })
  assert.deepEqual(resolveCrewPay(s, 'AMAZON   DSP'), { cents: 20000, source: 'crew_business' })
  assert.deepEqual(resolveCrewPay(s, 'Sysco'), { cents: 17500, source: 'crew_default' })
  assert.equal(resolveCrewPay({ payActive: false, payByBusiness: { 'amazon dsp': 20000 } }, 'Amazon DSP'), null)
  // An id that resolves to nothing must fall back to the name, not to the default.
  assert.deepEqual(resolveCrewPay(s, 'Amazon DSP', 'biz_unknown'), { cents: 20000, source: 'crew_business' })
})
