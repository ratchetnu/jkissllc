// ── Moving pricing settings ──────────────────────────────────────────────────
// Fifteen numbers that ARE the price of every move. The tests below care about
// three things: that a bad value never lands, that a good one does, and that a
// tenant can only ever see its own.
//
// Run: npx tsx --test scripts/moving-settings.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MOVING, MOVING_SETTING_KEYS, MOVING_SETTING_BOUNDS,
  sanitizeMovingSettingsPatch, parseMovingSettings, MOVING_SETTINGS_KEY,
  type MovingSettings,
} from '../app/lib/pricing/moving-quote'
import { scopeKey } from '../app/lib/platform/tenancy/keys'
import { PLATFORM_GLOBAL_PREFIXES } from '../app/lib/platform/tenancy/keys'

// ── validation ───────────────────────────────────────────────────────────────

test('all fifteen configurable fields are writable and bounded', () => {
  assert.equal(MOVING_SETTING_KEYS.length, 15)
  // Every declared setting must appear in the bounds table — a field added to the
  // type but not here is silently unwritable, so the count is pinned.
  for (const k of Object.keys(DEFAULT_MOVING) as (keyof MovingSettings)[]) {
    assert.ok(MOVING_SETTING_BOUNDS[k], `${k} has no declared bounds and cannot be configured`)
  }
})

test('negative rates, hours and percentages are REJECTED, never clamped', () => {
  const { patch, rejected } = sanitizeMovingSettingsPatch({
    crewRatePerHourCents: -1, minimumHours: -0.5, marginPct: -0.2, stairsPerFlightCents: -100,
  })
  assert.equal(Object.keys(patch).length, 0, 'nothing negative may reach the rate card')
  assert.equal(rejected.length, 4)
  // Clamping a negative rate to 0 would quote every move at the minimum charge and
  // read as a pricing bug for weeks. Rejection tells the admin immediately.
  for (const r of rejected) assert.match(r, /below the minimum/)
})

test('out-of-range and non-numeric values fail safely', () => {
  const { patch, rejected } = sanitizeMovingSettingsPatch({
    marginPct: 0.95,                    // above the 0.9 ceiling
    minimumHours: 48,                   // above the 24h ceiling
    crewRatePerHourCents: 'free',       // not a number
    truckFeeCents: NaN,
  })
  assert.equal(Object.keys(patch).length, 0)
  assert.equal(rejected.length, 4)
  assert.deepEqual(sanitizeMovingSettingsPatch(null).patch, {})
  assert.deepEqual(sanitizeMovingSettingsPatch('nope').patch, {})
})

test('valid values are accepted, integers rounded, unknown keys ignored', () => {
  const { patch, rejected } = sanitizeMovingSettingsPatch({
    crewRatePerHourCents: 7250.4, marginPct: 0.4, minimumHours: 2.5,
    somethingElse: 'ignored', truckCapacityCuFt: 9999,   // a junk-lane field
  })
  assert.deepEqual(rejected, [], 'an unknown key must not fail an otherwise valid write')
  assert.equal(patch.crewRatePerHourCents, 7250, 'cents are integers')
  assert.equal(patch.marginPct, 0.4, 'percentages keep their precision')
  assert.equal(patch.minimumHours, 2.5, 'hours keep their precision')
  assert.ok(!('truckCapacityCuFt' in patch), 'a disposal setting cannot be written through the moving surface')
})

test('absent fields are left alone — absent is not zero', () => {
  const { patch } = sanitizeMovingSettingsPatch({ crewRatePerHourCents: 7000 })
  assert.deepEqual(Object.keys(patch), ['crewRatePerHourCents'])
  // Explicit zero IS a legitimate value (a tenant that does not charge for stairs).
  const { patch: zeroed } = sanitizeMovingSettingsPatch({ stairsPerFlightCents: 0 })
  assert.equal(zeroed.stairsPerFlightCents, 0)
})

// ── persistence + tenancy ────────────────────────────────────────────────────
// Tested at the chokepoint rather than over a live store: `scopeKey` is the single
// place every Redis key passes through, so what it returns IS the isolation.

test('defaults are returned when no config has been saved', () => {
  assert.deepEqual(parseMovingSettings(null), DEFAULT_MOVING,
    'an unconfigured tenant prices on the documented defaults')
  assert.deepEqual(parseMovingSettings('{ not json'), DEFAULT_MOVING,
    'a corrupt record falls back to defaults rather than throwing into a quote')
})

test('a saved config merges over the defaults, field by field', () => {
  const s = parseMovingSettings(JSON.stringify({ crewRatePerHourCents: 8000 }))
  assert.equal(s.crewRatePerHourCents, 8000, 'the written field takes')
  assert.equal(s.truckFeeCents, DEFAULT_MOVING.truckFeeCents, 'every unset field keeps its default')
  assert.equal(Object.keys(s).length, MOVING_SETTING_KEYS.length, 'no field is lost in the merge')
})

test('tenant A cannot read or write tenant B settings', () => {
  const a = scopeKey(MOVING_SETTINGS_KEY, { enabled: true, tenantId: 'tenant-a' })
  const b = scopeKey(MOVING_SETTINGS_KEY, { enabled: true, tenantId: 'tenant-b' })
  assert.equal(a, 't:tenant-a:cfg:moving')
  assert.notEqual(a, b, "A and B must not resolve to the same key")
  // `cfg:` is NOT on the platform-global allowlist, so it is tenant-owned — the
  // same classification `cfg:disposal` already relies on.
  assert.ok(!PLATFORM_GLOBAL_PREFIXES.some(p => MOVING_SETTINGS_KEY.startsWith(p)),
    'cfg: must stay tenant-owned; adding it to the global allowlist would share one rate card across every tenant')
})

test('a tenant-owned settings read without a tenant context fails CLOSED', () => {
  // Not "falls back to the platform default" — throws. Silently serving an
  // unscoped rate card is how one tenant ends up quoting on another's numbers.
  assert.throws(() => scopeKey(MOVING_SETTINGS_KEY, { enabled: true, tenantId: undefined }),
    /tenant context required/)
})

// ── access control ───────────────────────────────────────────────────────────

test('the management route is admin-only on BOTH verbs', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../app/api/admin/moving-settings/route.ts', import.meta.url), 'utf8'))
  // A rate card is not customer-facing and not crew-editable. requireAdmin refuses
  // every non-admin role, so "crew cannot update settings" holds by construction
  // rather than by a role list this test would have to keep in sync.
  assert.equal((src.match(/requireAdmin\(req\)/g) ?? []).length, 2, 'GET and POST must both require admin')
  assert.ok(!src.includes('requireStaffSession'), 'staff-level access would let crew read the rate card')
  assert.ok(src.includes('withTenantRoute'), 'the route must run inside a tenant context')
  assert.ok(src.includes('recordAudit'), 'a pricing change must be audited')
})
