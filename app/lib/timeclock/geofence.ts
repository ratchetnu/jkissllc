// ── GPS geofence verification — PURE, deterministic ──────────────────────────
//
// Given a crew member's captured clock coordinates and the job's EXPECTED coordinates,
// derive whether the punch happened on site. Derived on read from the already-stored raw
// capture — nothing here mutates a punch, so legacy records (and records with no expected
// coords) are handled safely and the result is idempotent. There is NO external geocoding:
// expected coordinates must already be stored (route.reportLat/reportLng); when they are
// not, the result is `expected_unavailable`, never a false "verified".
//
// This is OPERATIONAL EVIDENCE, not proof of misconduct or a payroll input. A missing or
// low-accuracy fix never invalidates a punch and never triggers a deduction.

export const ALGO_VERSION = 'geofence-v1'

// Documented threshold: within 150 m of the job counts as on site (covers a large
// property / parking + typical consumer-GPS wobble). Accuracy bands below.
export const GEOFENCE_M = 150
export const ACCURACY_GOOD_M = 50
export const ACCURACY_FAIR_M = 150
export const ACCURACY_POOR_M = 500        // worse than this → too imprecise to verify
export const STALE_MS = 12 * 60 * 60 * 1000 // a capture older than a shift window is stale

export type VerifyStatus =
  | 'verified_on_site' | 'outside_geofence' | 'low_accuracy'
  | 'location_unavailable' | 'expected_unavailable' | 'stale' | 'invalid_coordinates'

export type CapturedLocation = { lat?: number | null; lng?: number | null; accuracy?: number | null; locationDenied?: boolean; at?: number | null }
export type ExpectedLocation = { lat?: number | null; lng?: number | null }

export type VerificationSnapshot = {
  status: VerifyStatus
  reason: string
  distanceM: number | null
  accuracyM: number | null
  effectiveDistanceM: number | null // distance minus reported accuracy, floored at 0
  thresholdM: number
  expectedLat: number | null
  expectedLng: number | null
  verifiedAt: number
  algoVersion: string
}

const validLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90
const validLng = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180
const validAcc = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const R = 6_371_000 // earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

// The single verification decision. Order matters: no-capture → invalid → stale →
// no-expected → too-imprecise → on-site (accuracy-adjusted) → outside.
export function verifyLocation(captured: CapturedLocation, expected: ExpectedLocation, now: number): VerificationSnapshot {
  const base = {
    thresholdM: GEOFENCE_M, verifiedAt: now, algoVersion: ALGO_VERSION,
    expectedLat: validLat(expected.lat) ? (expected.lat as number) : null,
    expectedLng: validLng(expected.lng) ? (expected.lng as number) : null,
    distanceM: null as number | null, accuracyM: null as number | null, effectiveDistanceM: null as number | null,
  }

  if (captured.locationDenied || captured.lat == null || captured.lng == null) {
    return { ...base, status: 'location_unavailable', reason: 'no_location_captured' }
  }
  if (!validLat(captured.lat) || !validLng(captured.lng)) {
    return { ...base, status: 'invalid_coordinates', reason: 'captured_coords_out_of_range' }
  }
  if (captured.at != null && Number.isFinite(captured.at) && now - (captured.at as number) > STALE_MS) {
    return { ...base, status: 'stale', reason: 'capture_older_than_shift_window' }
  }
  if (base.expectedLat == null || base.expectedLng == null) {
    // Keep the punch valid; we simply can't verify without a stored destination coord.
    return { ...base, status: 'expected_unavailable', reason: 'no_expected_coordinates' }
  }

  const accuracyM = validAcc(captured.accuracy) ? Math.round(captured.accuracy as number) : null
  const distanceM = Math.round(haversineMeters(captured.lat, captured.lng, base.expectedLat, base.expectedLng))
  const effectiveDistanceM = accuracyM != null ? Math.max(0, distanceM - accuracyM) : distanceM
  const filled = { ...base, distanceM, accuracyM, effectiveDistanceM }

  // Too imprecise to confidently place them anywhere — never call this verified.
  if (accuracyM != null && accuracyM > ACCURACY_POOR_M) {
    return { ...filled, status: 'low_accuracy', reason: 'accuracy_worse_than_policy' }
  }
  if (effectiveDistanceM <= GEOFENCE_M) {
    // Accuracy-adjusted only when the raw distance alone would have been outside.
    const reason = accuracyM != null && distanceM > GEOFENCE_M ? 'within_threshold_accuracy_adjusted' : 'within_threshold'
    return { ...filled, status: 'verified_on_site', reason }
  }
  return { ...filled, status: 'outside_geofence', reason: 'beyond_threshold' }
}

// Human-readable accuracy band (for the compliance UI labeling).
export function accuracyBand(accuracyM: number | null): 'good' | 'fair' | 'poor' | 'unusable' | 'unknown' {
  if (accuracyM == null) return 'unknown'
  if (accuracyM <= ACCURACY_GOOD_M) return 'good'
  if (accuracyM <= ACCURACY_FAIR_M) return 'fair'
  if (accuracyM <= ACCURACY_POOR_M) return 'poor'
  return 'unusable'
}

// Statuses that count as an eligible, resolvable verification (denominator for the
// verification rate). Unavailable / invalid are surfaced separately, never as failures.
export const ELIGIBLE_STATUSES: ReadonlySet<VerifyStatus> = new Set(['verified_on_site', 'outside_geofence', 'low_accuracy'])
