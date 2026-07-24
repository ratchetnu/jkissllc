// ── GPS compliance projection (pure) ─────────────────────────────────────────
// Derive verification records + a bounded rollup from work items (routes and, behind
// its flag, bookings). All derived on read via lib/timeclock/geofence — no raw capture
// is touched. Unavailable / invalid records are surfaced separately and NEVER counted as
// verification failures.

import { verifyLocation, accuracyBand, ELIGIBLE_STATUSES, type VerificationSnapshot, type VerifyStatus } from './geofence'

export type GpsAssignee = {
  staffId: string; name: string
  clockInAt?: number; clockInLat?: number; clockInLng?: number; clockInAccuracy?: number; clockInLocationDenied?: boolean
}
export type GpsWorkItem = {
  type: 'route' | 'booking'
  token: string; number: string; date: string
  expectedLat?: number; expectedLng?: number
  assignees?: GpsAssignee[]
}

export type GpsRecord = {
  type: 'route' | 'booking'
  jobToken: string; jobNumber: string
  staffId: string; staffName: string; date: string
  clockInAt: number | null
  status: VerifyStatus
  distanceM: number | null
  accuracyM: number | null
  accuracyBand: string
  reason: string
  snapshot: VerificationSnapshot
}

export type GpsFilter = { staffId?: string; status?: VerifyStatus; type?: 'route' | 'booking'; start?: string; end?: string }

const punched = (a: GpsAssignee): boolean =>
  a.clockInAt != null || a.clockInLat != null || a.clockInLng != null || a.clockInLocationDenied === true

export function selectGpsRecords(items: GpsWorkItem[], filter: GpsFilter, now: number): GpsRecord[] {
  const out: GpsRecord[] = []
  for (const it of items) {
    if (filter.type && it.type !== filter.type) continue
    if (filter.start && it.date < filter.start) continue
    if (filter.end && it.date > filter.end) continue
    for (const a of it.assignees ?? []) {
      if (!punched(a)) continue // an assigned-but-never-clocked crew member is not a GPS record
      if (filter.staffId && a.staffId !== filter.staffId) continue
      const snapshot = verifyLocation(
        { lat: a.clockInLat, lng: a.clockInLng, accuracy: a.clockInAccuracy, locationDenied: a.clockInLocationDenied, at: a.clockInAt },
        { lat: it.expectedLat, lng: it.expectedLng }, now,
      )
      if (filter.status && snapshot.status !== filter.status) continue
      out.push({
        type: it.type, jobToken: it.token, jobNumber: it.number,
        staffId: a.staffId, staffName: a.name, date: it.date, clockInAt: a.clockInAt ?? null,
        status: snapshot.status, distanceM: snapshot.distanceM, accuracyM: snapshot.accuracyM,
        accuracyBand: accuracyBand(snapshot.accuracyM), reason: snapshot.reason, snapshot,
      })
    }
  }
  return out.sort((a, b) => (b.clockInAt ?? 0) - (a.clockInAt ?? 0))
}

export type GpsRollup = {
  total: number
  eligible: number          // resolvable verifications (the rate denominator)
  verified: number
  outside: number
  lowAccuracy: number
  unavailable: number       // location off / no expected coords
  invalid: number           // malformed capture — excluded from the rate, labeled
  stale: number
  verificationRate: number  // verified / eligible, 0 when no eligible records
}

export function gpsRollup(records: GpsRecord[]): GpsRollup {
  const r: GpsRollup = { total: records.length, eligible: 0, verified: 0, outside: 0, lowAccuracy: 0, unavailable: 0, invalid: 0, stale: 0, verificationRate: 0 }
  for (const rec of records) {
    if (ELIGIBLE_STATUSES.has(rec.status)) r.eligible++
    switch (rec.status) {
      case 'verified_on_site': r.verified++; break
      case 'outside_geofence': r.outside++; break
      case 'low_accuracy': r.lowAccuracy++; break
      case 'location_unavailable': case 'expected_unavailable': r.unavailable++; break
      case 'invalid_coordinates': r.invalid++; break
      case 'stale': r.stale++; break
    }
  }
  r.verificationRate = r.eligible ? Math.round((r.verified / r.eligible) * 100) : 0
  return r
}
