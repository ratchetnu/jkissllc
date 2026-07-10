import { redis } from './redis'

// Lightweight crew/staff roster. Names here populate the booking "Assigned To"
// picker; assignment itself is stored on the booking (assignedTo).

// How this person is engaged. driver/helper also decide which payout bucket their
// pay lands in on the finance dashboard; contractor/employee fall back to the role
// stamped on the route (see lib/finance.bucketOf).
export type PayKind = 'driver' | 'helper' | 'contractor' | 'employee'

// One entry per pay change, newest last. Old routes keep their snapshotted pay —
// this is the audit trail of what the person's *rate* was over time.
export type PayHistoryEntry = {
  at: number
  defaultPayCents?: number
  payByBusiness?: Record<string, number>
  effectiveDate?: string     // YYYY-MM-DD
  active: boolean
  notes?: string
}

export type Staff = {
  id: string
  name: string
  phone?: string
  email?: string          // carried over from an applicant on hire; contact only
  role?: string
  photoUrl?: string
  active: boolean
  applicantId?: string    // back-link to the Applicant this crew member was hired from

  // ── Onboarding ──
  // Set when a crew member is created from an approved applicant but hasn't finished
  // onboarding (docs, start date, etc.). Undefined = fully active. UI-only signal.
  onboarding?: boolean

  // ── Pay settings ──
  // What this person earns per route. A per-business override (keyed by bizKey)
  // beats defaultPayCents. Snapshotted onto the route when they're assigned —
  // see lib/finance.snapshotCrewPay. Admin-only.
  payKind?: PayKind
  defaultPayCents?: number
  payByBusiness?: Record<string, number>   // bizKey → cents
  payNotes?: string
  payEffectiveDate?: string                // YYYY-MM-DD
  payActive?: boolean                      // false = don't auto-apply their rate
  payHistory?: PayHistoryEntry[]

  // ── Year-end / 1099 (Part 6) ──
  // W-9 collection status for 1099 readiness. We deliberately do NOT store the full
  // TIN (SSN/EIN) — only whether it's on file + the last 4, which is enough for a
  // readiness/missing-info view without holding sensitive PII. Admin-managed.
  w9?: {
    status: 'not_collected' | 'on_file' | 'verified'
    addressComplete?: boolean
    tinLast4?: string
    collectedAt?: number
  }

  // ── Timeclock ──
  // Whether this crew member clocks in/out on their route link. Undefined = on
  // (the default): the owner opts specific people OUT (e.g. salaried staff, or a
  // helper who rides with a driver who already punches). Read live at punch time,
  // so flipping it takes effect on routes already assigned.
  usesTimeclock?: boolean

  createdAt: number
  updatedAt: number
}

// True unless the owner explicitly turned the timeclock off for this person.
export const staffUsesTimeclock = (s: Pick<Staff, 'usesTimeclock'> | null | undefined): boolean =>
  s?.usesTimeclock !== false

const KEY = (id: string) => `staff:${id}`
const INDEX = 'staff:index'

export async function listStaff(limit = 200): Promise<Staff[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as Staff } catch { return null } })
    .filter((x): x is Staff => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getStaff(id: string): Promise<Staff | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as Staff } catch { return null }
}

// Existing crew member that looks like the same person — same applicant back-link,
// same email, or same 10-digit phone. Used when approving an applicant so hiring the
// same person twice links to the one record instead of creating a duplicate.
export async function findStaffDuplicate(opts: { applicantId?: string; email?: string; phone?: string }): Promise<Staff | null> {
  const e = (opts.email || '').trim().toLowerCase()
  const p = (opts.phone || '').replace(/\D/g, '')
  const all = await listStaff(500)
  return all.find(s =>
    (opts.applicantId && s.applicantId === opts.applicantId) ||
    (e && (s.email || '').trim().toLowerCase() === e) ||
    (p.length >= 10 && (s.phone || '').replace(/\D/g, '').endsWith(p.slice(-10))),
  ) ?? null
}

export async function saveStaff(s: Staff): Promise<void> {
  s.updatedAt = Date.now()
  await redis.set(KEY(s.id), JSON.stringify(s))
  await redis.zadd(INDEX, s.createdAt, s.id)
}

export async function deleteStaff(id: string): Promise<void> {
  await redis.del(KEY(id))
  await redis.zrem(INDEX, id)
}
