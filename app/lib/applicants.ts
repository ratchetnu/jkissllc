// ── Applicant store — hiring ATS records in Upstash Redis ─────────────────────
// Mirrors app/lib/bookings.ts exactly: one JSON blob per record under app:{id},
// a human-readable number (JK-A-1001) with a reverse index, and a sorted-set
// index (app:index, score=updatedAt) for newest-first admin listing. No DB.

import { redis } from './redis'
import { scoreApplicant } from './ats-scoring'
import type { ScoreInput, ScoreResult } from './ats-scoring'
import type { DocKind, ExperienceLevel, Position } from './ats-config'
import { releaseIfOwned } from './kv-lock'

export type ApplicantStatus =
  | 'new' | 'reviewed' | 'information_requested' | 'interview' | 'second_interview'
  | 'waitlist' | 'hired' | 'rejected' | 'withdrawn' | 'archived'

export const APPLICANT_STATUS_LABEL: Record<ApplicantStatus, string> = {
  new: 'New',
  reviewed: 'Under Review',
  information_requested: 'Information Requested',
  interview: 'Interviewing',
  second_interview: 'Second Interview',
  waitlist: 'Waitlist',
  hired: 'Approved',
  rejected: 'Denied',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
}

// A terminal/inactive applicant no longer sits in the active review queue.
export const APPLICANT_INACTIVE: ApplicantStatus[] = ['rejected', 'withdrawn', 'archived']

// An append-only activity log for the applicant lifecycle (submitted, status
// changes, notes, info requests, decisions, crew activation). Mirrors the
// AuditEntry convention used on routes/claims.
export type ApplicantEvent = { at: number; actor: string; action: string; note?: string }

export function pushApplicantEvent(a: Applicant, actor: string, action: string, note?: string): void {
  if (!Array.isArray(a.events)) a.events = []
  a.events.push({ at: Date.now(), actor, action, note: note?.trim() || undefined })
  a.events = a.events.slice(-200)
}

export type Recommendation = 'hire' | 'second_interview' | 'waitlist' | 'reject'

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  hire: 'Approve',
  second_interview: 'Second Interview',
  waitlist: 'Waitlist',
  reject: 'Reject',
}

export type SkillRating = { level: ExperienceLevel; confidence: number }
export type ApplicantDoc = { kind: DocKind; url: string; uploadedAt: number; approved?: boolean }
export type ScenarioResponse = { key: string; answer: string }
export type ContractorOnboarding = {
  requestedAt: number
  delivery: 'sent' | 'failed'
  deliveryAttemptedAt?: number
  deliveryError?: string
  // The counsel-approved template version this request pinned. Replacing the
  // published template later mints a NEW version and must never change what an
  // outstanding request asked its contractor to sign.
  agreementVersion?: number
  agreementDownloadedAt?: number
  electronicSignature?: {
    consentVersion: string
    consentedAt: number
    contractor: {
      name: string
      email: string
      signedAt: number
      sourceIp: string
      userAgent: string
      agreementVersion: number
      agreementSha256: string
      requestedAt: number
    }
    company?: {
      name: string
      title: string
      actorId: string
      signedAt: number
      sourceIp: string
      userAgent: string
    }
    certificateId?: string
    executedSha256?: string
  }
  submittedAt?: number
  verifiedAt?: number
  verifiedBy?: string
  legalName?: string
  businessName?: string
  taxClassification?: 'individual' | 'business'
  tinLast4?: string
  signatureName?: string
  agreementAcceptedAt?: number
  drivingAuthorized?: boolean
  usesPersonalVehicle?: boolean
  documentKinds?: DocKind[]
}

export type Applicant = {
  id: string
  applicantNumber: string // JK-A-1001
  position: Position
  // contact
  name: string
  email: string
  phone: string
  // eligibility attestations
  age21plus?: boolean
  reliableTransport?: boolean
  canOperateBoxTruck?: boolean
  canLiftHeavy?: boolean
  smartphone?: boolean
  // availability
  availableStart?: string
  availableDays?: string[]
  availabilityNotes?: string
  // free text
  experienceSummary?: string
  // assessment: categoryKey -> questionKey -> rating
  skills: Record<string, Record<string, SkillRating>>
  // scenarios
  scenarios: ScenarioResponse[]
  // documents + the approved white-background headshot kept separately for badges
  documents: ApplicantDoc[]
  badgeHeadshotUrl?: string
  // computed readiness score (snapshot taken at submit; recomputable)
  score: ScoreResult
  // admin/review
  status: ApplicantStatus
  managerNotes?: string
  recommendation?: Recommendation
  promotedStaffId?: string // set when "Approve/Hire" promotes them into the crew roster
  events?: ApplicantEvent[] // activity timeline
  informationRequest?: { message: string; requestedAt: number; delivery: 'sent' | 'failed' }
  informationResponse?: { message: string; submittedAt: number }
  contractorOnboarding?: ContractorOnboarding
  duplicateApplicantNumbers?: string[]
  archivedAt?: number
  // The start of the CURRENT rejection episode. It is immutable while rejected,
  // but cleared when review reopens so a later rejection receives a fresh clock.
  // Append-only status events retain the complete rejection history.
  rejectedAt?: number
  // An approval matched an EXISTING active crew record that is not W-9 verified.
  // Linking it would pull a working person off the roster, so approval stops and
  // waits for an explicit admin decision instead of doing it silently.
  pendingCrewLink?: { staffId: string; staffName: string; detectedAt: number }
  contractEndedAt?: number
  legalHold?: { active: boolean; placedAt: number; placedBy: string; reason: string; releasedAt?: number; releasedBy?: string }
  // meta
  source?: string
  createdAt: number
  updatedAt: number
}

// ── Redis keys ────────────────────────────────────────────────────────────────
const KEY_PREFIX = 'app:'
const KEY_NUM = 'app:num:' // app:num:{applicantNumber} -> id
const KEY_INDEX = 'app:index' // sorted set, score=updatedAt, member=id
const KEY_COUNTER = 'app:counter'
const KEY_SUBMISSION = (key: string) => `app:submit:${key}`

const COMMIT_APPLICATION = `
if redis.call('get', KEYS[4]) ~= ARGV[5] then return 0 end
redis.call('set', KEYS[1], ARGV[1])
redis.call('set', KEYS[2], ARGV[2])
redis.call('zadd', KEYS[3], ARGV[3], ARGV[2])
redis.call('set', KEYS[4], ARGV[4], 'PX', ARGV[6])
return 1
`
const SUBMISSION_TTL_MS = 7 * 24 * 60 * 60_000
const SUBMISSION_CLAIM_MS = 60_000

// ── Promotion identity claim (APP-1) ─────────────────────────────────────────
//
// Approving an applicant used to be: read applicant → `if (!promotedStaffId)` →
// look for a duplicate → saveStaff → saveApplicant. Three concurrent approvals all
// read "not promoted", all found no duplicate, and all minted a crew member — the
// applicant then recorded ONE id, leaving real, assignable orphan people on the
// roster (reproduced 3/3 in the race audit).
//
// The applicant's promotion is now an identity that must be CLAIMED atomically
// before any crew record is minted. The key is tenant-scoped by the redis
// chokepoint like every other `app:` key.
//
// The claim doubles as the durable applicant → staff mapping: while a promotion is
// in flight it holds a short-lived token, and on success it is overwritten with the
// staff id and no TTL. That is what lets a loser converge on the winner's record,
// and what lets a retry recover if the process died between saveStaff and
// saveApplicant (findStaffDuplicate({ applicantId }) is the second, independent
// recovery path — the staff record carries applicantId).
const PROMOTION_CLAIM_TTL_MS = 60_000
const CLAIM_TOKEN_PREFIX = 'claiming:'
export const PROMOTION_KEY = (applicantId: string) => `app:promoted:${applicantId}`

const RELEASE_IF_OWNED = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export type PromotionClaim =
  | { won: true; token: string }
  | { won: false; staffId: string | null }   // staffId when the winner already committed

/** Try to own this applicant's promotion. Atomic — never a read-then-write. */
export async function claimPromotion(applicantId: string): Promise<PromotionClaim> {
  const token = `${CLAIM_TOKEN_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  if (await redis.setNxPx(PROMOTION_KEY(applicantId), token, PROMOTION_CLAIM_TTL_MS)) return { won: true, token }
  const held = await redis.get(PROMOTION_KEY(applicantId))
  return { won: false, staffId: held && !held.startsWith(CLAIM_TOKEN_PREFIX) ? held : null }
}

/** Commit the promotion: the claim becomes the permanent applicant → staff mapping. */
export async function commitPromotion(applicantId: string, staffId: string): Promise<void> {
  await redis.set(PROMOTION_KEY(applicantId), staffId)
}

/** Release a claim that minted nothing, so a retry can promote. Owner-only. */
export async function releasePromotionClaim(applicantId: string, token: string): Promise<void> {
  try { await redis.eval(RELEASE_IF_OWNED, [PROMOTION_KEY(applicantId)], [token]) } catch { /* it self-expires */ }
}

/** The committed staff id for an applicant, or null while unpromoted/in flight. */
export async function promotedStaffIdFor(applicantId: string): Promise<string | null> {
  const v = await redis.get(PROMOTION_KEY(applicantId))
  return v && !v.startsWith(CLAIM_TOKEN_PREFIX) ? v : null
}

/**
 * A loser waits briefly for the winner to commit, then converges on its staff id.
 * Returns null if the winner never committed (it died mid-promotion), in which case
 * the caller may take the promotion over.
 */
export async function awaitPromotedStaffId(applicantId: string, attempts = 6, delayMs = 50): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const id = await promotedStaffIdFor(applicantId)
    if (id) return id
    await new Promise<void>(r => setTimeout(r, delayMs))
  }
  return null
}

// ── IDs ───────────────────────────────────────────────────────────────────────
export function generateApplicantId(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}

// No Redis fallback on purpose — see the note in lib/bookings.ts.
export async function nextApplicantNumber(): Promise<string> {
  const n = await redis.incr(KEY_COUNTER)
  return `JK-A-${1000 + n}`
}

// Build the ScoreInput view of an applicant for the scoring engine.
export function toScoreInput(a: Applicant): ScoreInput {
  return {
    position: a.position,
    skills: a.skills || {},
    scenarios: Array.isArray(a.scenarios) ? a.scenarios : [],
    documents: (Array.isArray(a.documents) ? a.documents : []).map(d => ({ kind: d.kind })),
    eligibility: {
      age21plus: a.age21plus,
      reliableTransport: a.reliableTransport,
      canOperateBoxTruck: a.canOperateBoxTruck,
      canLiftHeavy: a.canLiftHeavy,
      smartphone: a.smartphone,
    },
    availability: { start: a.availableStart, days: a.availableDays, notes: a.availabilityNotes },
    experienceSummary: a.experienceSummary,
  }
}

export function rescore(a: Applicant): Applicant {
  a.score = scoreApplicant(toScoreInput(a))
  return a
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
export async function getApplicant(id: string): Promise<Applicant | null> {
  if (!id || !/^[a-f0-9]{16,}$/i.test(id)) return null
  const raw = await redis.get(`${KEY_PREFIX}${id}`)
  if (!raw) return null
  try { return normalize(JSON.parse(raw) as Applicant) } catch { return null }
}

export async function getApplicantByNumber(applicantNumber: string): Promise<Applicant | null> {
  const num = applicantNumber.trim().toUpperCase()
  if (!num) return null
  const id = await redis.get(`${KEY_NUM}${num}`)
  if (!id) return null
  return getApplicant(id)
}

export async function saveApplicant(a: Applicant): Promise<void> {
  a.updatedAt = Date.now()
  await redis.set(`${KEY_PREFIX}${a.id}`, JSON.stringify(a))
  await redis.set(`${KEY_NUM}${a.applicantNumber.toUpperCase()}`, a.id)
  await redis.zadd(KEY_INDEX, a.updatedAt, a.id)
}

export type ApplicantSubmissionResult =
  | { ok: true; applicant: Applicant; replayed: boolean }
  | { ok: false; reason: 'busy' }

/**
 * Public intake commit. A browser-generated submission key claims exactly one
 * application, and the record + reverse index + list index + committed receipt are
 * written in one Lua transaction. An ambiguous client retry receives the original
 * applicant rather than allocating a duplicate.
 */
export async function submitApplicantOnce(
  submissionKey: string,
  create: () => Promise<Applicant>,
): Promise<ApplicantSubmissionResult> {
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(submissionKey)) throw new Error('invalid submission key')
  const key = KEY_SUBMISSION(submissionKey)
  const token = `claiming:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  if (!(await redis.setNxPx(key, token, SUBMISSION_CLAIM_MS))) {
    const held = await redis.get(key)
    if (held?.startsWith('committed:')) {
      const prior = await getApplicant(held.slice('committed:'.length))
      if (prior) return { ok: true, applicant: prior, replayed: true }
    }
    return { ok: false, reason: 'busy' }
  }

  try {
    const applicant = await create()
    applicant.updatedAt = Date.now()
    const committed = `committed:${applicant.id}`
    const result = await redis.eval(COMMIT_APPLICATION, [
      `${KEY_PREFIX}${applicant.id}`,
      `${KEY_NUM}${applicant.applicantNumber.toUpperCase()}`,
      KEY_INDEX,
      key,
    ], [
      JSON.stringify(applicant), applicant.id, String(applicant.updatedAt), committed, token, String(SUBMISSION_TTL_MS),
    ])
    if (result !== 1 && result !== '1') return { ok: false, reason: 'busy' }
    return { ok: true, applicant, replayed: false }
  } catch (error) {
    await releaseIfOwned(key, token)
    throw error
  }
}

export async function listApplicants(limit?: number): Promise<Applicant[]> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, limit === undefined ? -1 : Math.max(0, limit - 1))
  if (!ids.length) return []
  const raws = await redis.mget(ids.map(i => `${KEY_PREFIX}${i}`))
  return raws
    .filter(Boolean)
    .map(r => { try { return normalize(JSON.parse(r as string) as Applicant) } catch { return null } })
    .filter((a): a is Applicant => a !== null)
}

// Retention-only hard deletion. UI/API deletes remain prohibited. Callers must
// first enforce the legal-hold and age policy and delete linked blobs.
export async function purgeApplicantAfterRetention(a: Pick<Applicant, 'id' | 'applicantNumber'>): Promise<void> {
  await redis.del(`${KEY_PREFIX}${a.id}`)
  await redis.del(`${KEY_NUM}${a.applicantNumber.toUpperCase()}`)
  await redis.zrem(KEY_INDEX, a.id)
  await redis.del(PROMOTION_KEY(a.id))
}

// Backfill defaults so older records never crash newer code.
function normalize(a: Applicant): Applicant {
  a.skills = a.skills && typeof a.skills === 'object' ? a.skills : {}
  a.scenarios = Array.isArray(a.scenarios) ? a.scenarios : []
  a.documents = Array.isArray(a.documents) ? a.documents : []
  a.events = Array.isArray(a.events) ? a.events : []
  a.status = a.status || 'new'
  if (!a.score || typeof a.score.score !== 'number') a.score = scoreApplicant(toScoreInput(a))
  // Legacy rejection clocks are persisted by the retention pass. Do not synthesize
  // the field here: doing so only in memory would make a test look backfilled while
  // leaving the stored record unchanged.
  return a
}

/** The timestamp of the event that put this applicant into `rejected`, if recorded. */
export function rejectionEventAt(a: Pick<Applicant, 'events'>): number | undefined {
  return [...(a.events ?? [])]
    .reverse()
    .find(event => /denied|rejected/i.test(`${event.action} ${event.note ?? ''}`))?.at
}

const norm = (s: string | undefined) => (s || '').trim().toLowerCase()
const digits = (s: string | undefined) => (s || '').replace(/\D/g, '')

// Find prior applicant records that look like the same person (same email, or same
// 10-digit phone). Used at apply time to flag a repeat application and at review
// time so an admin never silently creates a second profile for one person.
export async function findApplicantDuplicates(
  email: string, phone: string, excludeId?: string,
): Promise<Applicant[]> {
  const e = norm(email), p = digits(phone)
  if (!e && !p) return []
  const all = await listApplicants()
  return all.filter(a => a.id !== excludeId && (
    (e && norm(a.email) === e) || (p && p.length >= 10 && digits(a.phone).endsWith(p.slice(-10)))
  ))
}
