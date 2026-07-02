// ── Applicant store — hiring ATS records in Upstash Redis ─────────────────────
// Mirrors app/lib/bookings.ts exactly: one JSON blob per record under app:{id},
// a human-readable number (JK-A-1001) with a reverse index, and a sorted-set
// index (app:index, score=updatedAt) for newest-first admin listing. No DB.

import { redis } from './redis'
import { scoreApplicant } from './ats-scoring'
import type { ScoreInput, ScoreResult } from './ats-scoring'
import type { DocKind, ExperienceLevel, Position } from './ats-config'

export type ApplicantStatus =
  | 'new' | 'reviewed' | 'interview' | 'second_interview' | 'waitlist' | 'hired' | 'rejected'

export const APPLICANT_STATUS_LABEL: Record<ApplicantStatus, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  interview: 'Interview',
  second_interview: 'Second Interview',
  waitlist: 'Waitlist',
  hired: 'Hired',
  rejected: 'Rejected',
}

export type Recommendation = 'hire' | 'second_interview' | 'waitlist' | 'reject'

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  hire: 'Hire',
  second_interview: 'Second Interview',
  waitlist: 'Waitlist',
  reject: 'Reject',
}

export type SkillRating = { level: ExperienceLevel; confidence: number }
export type ApplicantDoc = { kind: DocKind; url: string; uploadedAt: number; approved?: boolean }
export type ScenarioResponse = { key: string; answer: string }

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
  promotedStaffId?: string // set when "Hire" promotes them into the crew roster
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

// ── IDs ───────────────────────────────────────────────────────────────────────
export function generateApplicantId(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}

export async function nextApplicantNumber(): Promise<string> {
  let n: number
  try {
    n = await redis.incr(KEY_COUNTER)
  } catch {
    n = Date.now() % 100000
  }
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

export async function deleteApplicant(id: string): Promise<void> {
  const a = await getApplicant(id)
  await redis.del(`${KEY_PREFIX}${id}`)
  if (a) await redis.del(`${KEY_NUM}${a.applicantNumber.toUpperCase()}`)
  await redis.zrem(KEY_INDEX, id)
}

export async function listApplicants(limit = 500): Promise<Applicant[]> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(i => redis.get(`${KEY_PREFIX}${i}`)))
  return raws
    .filter(Boolean)
    .map(r => { try { return normalize(JSON.parse(r as string) as Applicant) } catch { return null } })
    .filter((a): a is Applicant => a !== null)
}

// Backfill defaults so older records never crash newer code.
function normalize(a: Applicant): Applicant {
  a.skills = a.skills && typeof a.skills === 'object' ? a.skills : {}
  a.scenarios = Array.isArray(a.scenarios) ? a.scenarios : []
  a.documents = Array.isArray(a.documents) ? a.documents : []
  a.status = a.status || 'new'
  if (!a.score || typeof a.score.score !== 'number') a.score = scoreApplicant(toScoreInput(a))
  return a
}
