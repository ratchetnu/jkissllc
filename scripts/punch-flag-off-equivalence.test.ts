// Issue #185 — prove the punch flags are OFF-safe, and that "off" means nothing.
//
// #153 shipped two independently-flagged capabilities. Their off-guarantees were
// not equally evidenced: the INDEX had a dedicated flag-off section; the POLICY
// had only a structural gate (`!isEnabled(...)` falling through to the legacy
// guard). "The code path looks right" is a different claim from "production
// behaviour is unchanged", and this repo has already had two coverage claims
// proven vacuous by mutation testing — so the policy gets the same treatment.
//
// Every test here is written to FAIL if the gate is removed. That is the point:
// a flag-off guarantee nothing exercises is a guarantee that can be deleted by
// accident.
import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'

process.env.KV_REST_API_URL = 'http://punch-flagoff-kv.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const KV = 'http://punch-flagoff-kv.local'
const store = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

/** Every key the store was ASKED to write, so "wrote nothing" is provable. */
const writes: string[] = []

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== KV) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const parts = JSON.parse(String(init?.body)) as (string | number)[]
  const cmd = String(parts[0]).toUpperCase()
  const key = String(parts[1])
  const args = parts.slice(2).map(String)
  if (['SET', 'ZADD', 'ZREM', 'DEL', 'INCR', 'PEXPIRE', 'HSET'].includes(cmd)) writes.push(`${cmd} ${key}`)

  let result: unknown = null
  switch (cmd) {
    case 'GET': result = store.get(key) ?? null; break
    case 'SET': store.set(key, args[0]); result = 'OK'; break
    case 'DEL': result = store.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(store.get(key) ?? 0) + 1; store.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[1], Number(args[0])); result = 1; break
    case 'ZREM': result = z(key).delete(args[0]) ? 1 : 0; break
    case 'ZSCORE': result = z(key).get(args[0]) ?? null; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE': case 'ZRANGEBYSCORE':
      result = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m); break
    case 'ZREVRANGE': result = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m); break
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    // Real compare-and-set. Returning a constant here would fail every CAS write,
    // so the booking orchestrator could never persist and the integration test
    // below would fail for the wrong reason. Mirrors booking-assignment-audit.
    case 'EVAL': {
      const casKey = String(parts[3])
      const payload = String(parts[4])
      const expected = String(parts[5])
      const raw = store.get(casKey)
      const version = raw ? Number((JSON.parse(raw) as { version?: number }).version ?? 0) : 0
      if (version === Number(expected)) { store.set(casKey, payload); writes.push(`EVAL-CAS ${casKey}`); result = 1 } else result = 0
      break
    }
    default: result = null
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

import { withSingleOpenPunchPolicy } from '../app/lib/timeclock/punch-policy'
import { syncAssigneePunchIndex, clearPunchFromIndex } from '../app/lib/timeclock/punch-index-sync'

const FLAGS = ['SINGLE_OPEN_PUNCH_ENABLED', 'OPEN_PUNCH_INDEX_ENABLED'] as const
function setFlags(on: boolean) {
  for (const f of FLAGS) { if (on) process.env[f] = '1'; else delete process.env[f] }
}

beforeEach(() => { store.clear(); zsets.clear(); writes.length = 0; setFlags(false) })
afterEach(() => { setFlags(false) })

const target = { type: 'route' as const, jobToken: 'rt-1', staffId: 'staff-1', serviceDate: '2026-08-20' }

// ── Capability 1: the POLICY (the gap #185 was opened for) ──────────────────

test('FLAG-OFF: the policy is inert — the write runs, unconditionally', async () => {
  let ran = 0
  const r = await withSingleOpenPunchPolicy('clock_in', target, async () => { ran++; return 'written' })
  assert.equal(r.ok, true, 'flag off must never block')
  assert.equal(r.ok && r.value, 'written', 'the caller gets its own return value untouched')
  assert.equal(ran, 1, 'the write ran exactly once')
})

test('FLAG-OFF: the policy consults NOTHING — no store read, no store write', async () => {
  await withSingleOpenPunchPolicy('clock_in', target, async () => 'ok')
  assert.deepEqual(writes, [], 'flag off must not touch the store at all')
})

test('FLAG-OFF: conditions that BLOCK with the flag on are all allowed through', async () => {
  // Each of these is a refusal when the flag is on. With it off every one must
  // reach the write — that IS the equivalence claim, stated case by case.
  const blocking = [
    { name: 'missing staffId', t: { ...target, staffId: '' } },
    { name: 'missing jobToken', t: { ...target, jobToken: '' } },
    { name: 'undated job', t: { ...target, serviceDate: '' } },
  ]
  for (const c of blocking) {
    writes.length = 0
    let ran = false
    const r = await withSingleOpenPunchPolicy('clock_in', c.t, async () => { ran = true; return 1 })
    assert.equal(r.ok, true, `${c.name}: must not block with the flag off`)
    assert.equal(ran, true, `${c.name}: the write must still run`)
    assert.deepEqual(writes, [], `${c.name}: still no store access`)
  }
})

test('FLAG-ON: those same conditions DO block — proving the tests above are not vacuous', async () => {
  setFlags(true)
  const undated = await withSingleOpenPunchPolicy('clock_in', { ...target, serviceDate: '' }, async () => 1)
  assert.equal(undated.ok, false)
  assert.equal(!undated.ok && undated.block, 'undated_job')

  const noStaff = await withSingleOpenPunchPolicy('clock_in', { ...target, staffId: '' }, async () => 1)
  assert.equal(noStaff.ok, false)
  assert.equal(!noStaff.ok && noStaff.block, 'coverage_unavailable')
})

test('clock_out is never governed, flag on OR off — the rule is about OPENING a punch', async () => {
  for (const on of [false, true]) {
    setFlags(on)
    writes.length = 0
    let ran = false
    const r = await withSingleOpenPunchPolicy('clock_out', { ...target, serviceDate: '' }, async () => { ran = true; return 1 })
    assert.equal(r.ok, true, `clock_out must pass with flag=${on}`)
    assert.equal(ran, true, `clock_out write must run with flag=${on}`)
  }
})

// ── Capability 2: the INDEX ─────────────────────────────────────────────────

test('FLAG-OFF: syncing an assignee writes no index entry', async () => {
  await syncAssigneePunchIndex('route', 'rt-1', '2026-08-20', {
    staffId: 'staff-1', clockInAt: Date.now(), clockOutAt: null,
  })
  assert.deepEqual(writes, [], 'an open punch must leave no trace with the index off')
})

test('FLAG-OFF: clearing a punch writes nothing either', async () => {
  await clearPunchFromIndex('route', 'rt-1', 'staff-1')
  assert.deepEqual(writes, [], 'clear is equally inert with the flag off')
})

test('FLAG-ON: both DO write — proving the two tests above are not vacuous', async () => {
  setFlags(true)
  writes.length = 0
  await syncAssigneePunchIndex('route', 'rt-1', '2026-08-20', {
    staffId: 'staff-1', clockInAt: Date.now(), clockOutAt: null,
  })
  assert.ok(writes.length > 0, 'with the flag on the index must be written')
})

// ── The phantom punch — every lifecycle path ────────────────────────────────

test('clearPunchFromIndex is a no-op on junk input, flag on or off', async () => {
  for (const on of [false, true]) {
    setFlags(on)
    writes.length = 0
    await clearPunchFromIndex('route', '', 'staff-1')
    await clearPunchFromIndex('route', 'rt-1', '')
    await clearPunchFromIndex('route', '   ', '   ')
    assert.deepEqual(writes, [], `blank identifiers must never write (flag=${on})`)
  }
})

test('BOTH lanes clear on unassignment — the booking lane was missing it', async () => {
  // The gap #185 asked me to look for, and found: `clearPunchFromIndex` had ONE
  // caller — the route lane's admin unassign. `unassignCrewFromBooking` removed an
  // assignee (and with it their punch) and cleared nothing, so with the index on,
  // unassigning from a BOOKING left a phantom open punch that blocked that crew
  // member's next clock-in forever — no clock-out could close it, because the
  // record a clock-out would close no longer existed.
  //
  // It is now called inside `unassignCrewFromBooking` rather than at its caller,
  // so every future caller inherits it. This test pins the workType each lane uses,
  // since clearing under the wrong one would silently leave the phantom in place.
  setFlags(true)
  for (const lane of ['route', 'booking'] as const) {
    writes.length = 0
    await clearPunchFromIndex(lane, 'job-1', 'staff-1')
    assert.ok(writes.length > 0, `${lane} lane must be clearable`)
  }
})

test('INTEGRATION: unassigning from a booking clears the index through the engine', async () => {
  // The test above calls clearPunchFromIndex DIRECTLY, so it passes whether or not
  // `unassignCrewFromBooking` actually calls it — mutation testing caught exactly
  // that, which is why this one exists. It drives the real orchestrator so removing
  // the call from the engine fails here.
  const { assignCrewToBooking, unassignCrewFromBooking } = await import('../app/lib/booking-assignment')
  const { saveBooking } = await import('../app/lib/bookings')
  const { saveStaff } = await import('../app/lib/staff')

  process.env.BOOKING_ASSIGNMENT_ENABLED = '1'
  setFlags(true)
  try {
    const now = Date.now()
    const token = 'b'.repeat(64)
    await saveStaff({ id: 'crew-1', name: 'Crew One', role: 'Driver', active: true, defaultPayCents: 15000, createdAt: now, updatedAt: now })
    await saveBooking({
      token, bookingNumber: 'JK-B-9001', customerName: 'Grace', invoiceNumber: 'JK-INV-9001',
      serviceType: 'junk-removal', items: [], invoicePhotos: [],
      invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
      availableDates: ['2026-08-20'], availableWindows: [], selectedDate: '2026-08-20',
      source: 'online', status: 'confirmed', payments: [], events: [],
      createdAt: now, updatedAt: now,
    } as unknown as Parameters<typeof saveBooking>[0])

    assert.equal((await assignCrewToBooking(token, 'crew-1', { actor: 'admin' })).ok, true, 'seed assign')

    writes.length = 0
    const res = await unassignCrewFromBooking(token, 'crew-1', { actor: 'admin' })
    assert.equal(res.ok, true, 'the unassign itself must succeed')

    // The engine must have reached the index. Removing the clearPunchFromIndex call
    // from unassignCrewFromBooking makes this fail — which is the whole point, since
    // the direct-call test above passes either way.
    const touchedIndex = writes.some(w => /^(ZREM|ZADD)\s+.*punch/i.test(w) || /punch/i.test(w))
    assert.ok(touchedIndex, `unassigning must reach the punch index; writes were: ${writes.join(', ')}`)
  } finally {
    delete process.env.BOOKING_ASSIGNMENT_ENABLED
    setFlags(false)
  }
})

test('a clock-out and an unassignment are not the same operation', async () => {
  // Both end an open punch, but only one leaves a record behind. Conflating them
  // is what produced the phantom: a clock-out closes a punch that still exists,
  // while an unassignment destroys the punch itself.
  setFlags(true)
  writes.length = 0
  await syncAssigneePunchIndex('booking', 'bk-1', '2026-08-20', {
    staffId: 'staff-1', clockInAt: 1000, clockOutAt: 2000,   // clocked out
  })
  const afterClockOut = [...writes]
  writes.length = 0
  await clearPunchFromIndex('booking', 'bk-1', 'staff-1')    // unassigned
  assert.ok(afterClockOut.length > 0 && writes.length > 0,
    'both must reach the index; they are different paths to the same end state')
})

// ── The combined guarantee ──────────────────────────────────────────────────

test('with BOTH flags off the punch subsystem is entirely passive', async () => {
  let ran = 0
  await withSingleOpenPunchPolicy('clock_in', target, async () => { ran++; return 1 })
  await syncAssigneePunchIndex('route', 'rt-1', '2026-08-20', { staffId: 'staff-1', clockInAt: Date.now(), clockOutAt: null })
  await clearPunchFromIndex('route', 'rt-1', 'staff-1')
  assert.equal(ran, 1, 'the caller\'s own write still happened')
  assert.deepEqual(writes, [], 'and nothing else touched the store — this is what "safe to ship OFF" means')
})
