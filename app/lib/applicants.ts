// ── Applicant store — hiring ATS records in Upstash Redis ─────────────────────
// Mirrors app/lib/bookings.ts exactly: one JSON blob per record under app:{id},
// a human-readable number (JK-A-1001) with a reverse index, and a sorted-set
// index (app:index, score=updatedAt) for newest-first admin listing. No DB.

import { redis } from './redis'
import { scoreApplicant } from './ats-scoring'
import type { ScoreInput, ScoreResult } from './ats-scoring'
import type { DocKind, ExperienceLevel, Position } from './ats-config'

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
  promotedStaffId?: string // set when "Approve/Hire" promotes them into the crew roster
  events?: ApplicantEvent[] // activity timeline
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
  a.events = Array.isArray(a.events) ? a.events : []
  a.status = a.status || 'new'
  if (!a.score || typeof a.score.score !== 'number') a.score = scoreApplicant(toScoreInput(a))
  return a
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
  const all = await listApplicants(1000)
  return all.filter(a => a.id !== excludeId && (
    (e && norm(a.email) === e) || (p && p.length >= 10 && digits(a.phone).endsWith(p.slice(-10)))
  ))
}
