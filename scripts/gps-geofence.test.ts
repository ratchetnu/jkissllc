// Wave I — GPS geofence verification: distance, thresholds, accuracy, invalid/stale/
// missing data, compliance selection + rollup, authorization.
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-admin-session-secret-0123456789'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import {
  haversineMeters, verifyLocation, accuracyBand, GEOFENCE_M, ALGO_VERSION,
} from '../app/lib/timeclock/geofence'
import { selectGpsRecords, gpsRollup, type GpsWorkItem } from '../app/lib/timeclock/gps-compliance'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { createUserSessionToken, requirePermission, COOKIE_NAME } from '../app/api/admin/_lib/session'
import type { Role } from '../app/lib/rbac'

const NOW = Date.UTC(2026, 2, 15, 12, 0, 0)
const EXP = { lat: 40.0000, lng: -75.0000 }   // ~0.001 deg lat ≈ 111 m
const cap = (o: Record<string, unknown>) => ({ lat: EXP.lat, lng: EXP.lng, accuracy: 10, at: NOW, ...o })

// ── Distance + core statuses ──────────────────────────────────────────────────

test('haversineMeters ≈ 111 m per 0.001° latitude', () => {
  const d = haversineMeters(40, -75, 40.001, -75)
  assert.ok(Math.abs(d - 111) < 3, `expected ~111 m, got ${d}`)
})

test('verifyLocation: on-site, off-site, and threshold boundary', () => {
  assert.equal(verifyLocation(cap({}), EXP, NOW).status, 'verified_on_site')        // 0 m
  assert.equal(verifyLocation(cap({ lat: 40.001 }), EXP, NOW).status, 'verified_on_site') // ~111 m
  const off = verifyLocation(cap({ lat: 40.005 }), EXP, NOW)                          // ~556 m
  assert.equal(off.status, 'outside_geofence')
  assert.ok(off.distanceM! > GEOFENCE_M)
})

test('accuracy adjustment: raw distance just outside but effective inside → verified (labeled)', () => {
  const v = verifyLocation(cap({ lat: 40.0015, accuracy: 100 }), EXP, NOW) // ~167 m raw, effective ~67
  assert.equal(v.status, 'verified_on_site')
  assert.equal(v.reason, 'within_threshold_accuracy_adjusted')
  assert.ok(v.distanceM! > GEOFENCE_M && v.effectiveDistanceM! <= GEOFENCE_M)
})

test('accuracy bands + low-accuracy is never called verified', () => {
  assert.equal(accuracyBand(30), 'good'); assert.equal(accuracyBand(120), 'fair')
  assert.equal(accuracyBand(300), 'poor'); assert.equal(accuracyBand(700), 'unusable')
  const v = verifyLocation(cap({ lat: 40.0005, accuracy: 600 }), EXP, NOW) // close, but unusable accuracy
  assert.equal(v.status, 'low_accuracy')
})

test('missing/invalid/stale never become a false positive', () => {
  assert.equal(verifyLocation(cap({ locationDenied: true }), EXP, NOW).status, 'location_unavailable')
  assert.equal(verifyLocation(cap({ lat: null, lng: null }), EXP, NOW).status, 'location_unavailable')
  assert.equal(verifyLocation(cap({ lat: 200 }), EXP, NOW).status, 'invalid_coordinates')
  assert.equal(verifyLocation(cap({ at: NOW - 13 * 3600_000 }), EXP, NOW).status, 'stale')
  // no expected coords → unverifiable, NOT verified
  const noExp = verifyLocation(cap({}), {}, NOW)
  assert.equal(noExp.status, 'expected_unavailable')
  assert.notEqual(noExp.status, 'verified_on_site')
})

test('deterministic + idempotent: same inputs → identical snapshot with algo version', () => {
  const a = verifyLocation(cap({ lat: 40.001 }), EXP, NOW)
  const b = verifyLocation(cap({ lat: 40.001 }), EXP, NOW)
  assert.deepEqual(a, b)
  assert.equal(a.algoVersion, ALGO_VERSION)
})

// ── Compliance selection + rollup ─────────────────────────────────────────────

const asg = (o: Record<string, unknown> = {}) => ({ staffId: 's1', name: 'Alex', clockInAt: NOW, clockInLat: EXP.lat, clockInLng: EXP.lng, clockInAccuracy: 10, ...o })

test('selectGpsRecords verifies route punches; a never-clocked assignee is skipped', () => {
  const items: GpsWorkItem[] = [{
    type: 'route', token: 'r1', number: 'R-1', date: '2026-03-15', expectedLat: EXP.lat, expectedLng: EXP.lng,
    assignees: [asg(), { staffId: 's2', name: 'Bo' } as never], // s2 never punched
  }]
  const recs = selectGpsRecords(items, {}, NOW)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].status, 'verified_on_site')
})

test('booking with no stored coords → expected_unavailable (never a false positive); flag-off contributes nothing', () => {
  const booking: GpsWorkItem = { type: 'booking', token: 'b1', number: 'JK-B-1', date: '2026-03-15', assignees: [asg()] } // no expectedLat/Lng
  assert.equal(selectGpsRecords([booking], {}, NOW)[0].status, 'expected_unavailable')
  // "flag off" is modeled by the API passing NO booking items → empty
  assert.equal(selectGpsRecords([], { type: 'booking' }, NOW).length, 0)
})

test('filters: staff / status / date window', () => {
  const items: GpsWorkItem[] = [
    { type: 'route', token: 'r1', number: 'R-1', date: '2026-03-10', expectedLat: EXP.lat, expectedLng: EXP.lng, assignees: [asg()] },
    { type: 'route', token: 'r2', number: 'R-2', date: '2026-03-20', expectedLat: EXP.lat, expectedLng: EXP.lng, assignees: [asg({ staffId: 's9', name: 'Cy', clockInLat: 40.01 })] }, // off-site
  ]
  assert.equal(selectGpsRecords(items, { staffId: 's1' }, NOW).length, 1)
  assert.equal(selectGpsRecords(items, { status: 'outside_geofence' }, NOW).length, 1)
  assert.equal(selectGpsRecords(items, { start: '2026-03-15' }, NOW).length, 1) // only r2
})

test('rollup: rate = verified/eligible; unavailable + invalid excluded from the rate', () => {
  const items: GpsWorkItem[] = [{
    type: 'route', token: 'r1', number: 'R-1', date: '2026-03-15', expectedLat: EXP.lat, expectedLng: EXP.lng,
    assignees: [
      asg(),                                            // verified
      asg({ staffId: 's2', name: 'B', clockInLat: 40.01 }), // off-site (eligible)
      asg({ staffId: 's3', name: 'C', clockInLocationDenied: true, clockInLat: undefined, clockInLng: undefined }), // unavailable
    ],
  }]
  const roll = gpsRollup(selectGpsRecords(items, {}, NOW))
  assert.equal(roll.verified, 1); assert.equal(roll.outside, 1); assert.equal(roll.unavailable, 1)
  assert.equal(roll.eligible, 2)                    // verified + off-site (NOT the unavailable one)
  assert.equal(roll.verificationRate, 50)           // 1 / 2
})

// ── Authorization ─────────────────────────────────────────────────────────────

async function reqAs(role: Role, tenantId?: string): Promise<NextRequest> {
  const token = await createUserSessionToken({ id: role === 'admin' ? 'owner' : `u_${role}`, role, tenantId })
  return new NextRequest('http://localhost/api/admin/gps-compliance', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
}
const allowed = (x: unknown) => !(x instanceof NextResponse)

test('gps-compliance is gated routes:view: admin+manager ok, crew 403, anon 401; tenant-bound', async () => {
  assert.ok(allowed(await requirePermission(await reqAs('admin'), 'routes:view')))
  assert.ok(allowed(await requirePermission(await reqAs('manager'), 'routes:view')))
  assert.equal((await requirePermission(await reqAs('crew'), 'routes:view') as NextResponse).status, 403)
  assert.equal((await requirePermission(new NextRequest('http://localhost/api/admin/gps-compliance'), 'routes:view') as NextResponse).status, 401)
  assert.equal(((await requirePermission(await reqAs('admin', 'acme'), 'routes:view')) as { tenantId: string }).tenantId, 'acme')
})

test('gps-verification capability is full, gated routes:view', () => {
  const g = CAPABILITY_REGISTRY['gps-verification']
  assert.equal(g.status, 'full')
  assert.ok(g.requiredPermissions.includes('routes:view'))
})
