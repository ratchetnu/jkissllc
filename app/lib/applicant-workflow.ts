import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ApplicantStatus } from './applicants'
import type { DocKind } from './ats-config'

const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000
const DRAFT_RE = /^[a-zA-Z0-9-]{16,100}$/
const SEALED_DOCUMENT_PATH = /^(?:tenants\/([a-z0-9][a-z0-9-]{0,63})\/)?driver-docs\/[a-z_]+\/[a-zA-Z0-9-]+\.(jpg|png|webp|heic|heif)\.enc$/

export const APPLICANT_TERMINAL_STATUSES = new Set<ApplicantStatus>(['hired', 'rejected', 'withdrawn', 'archived'])

const TRANSITIONS: Record<ApplicantStatus, ReadonlySet<ApplicantStatus>> = {
  new: new Set(['reviewed', 'information_requested', 'interview', 'second_interview', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived']),
  reviewed: new Set(['information_requested', 'interview', 'second_interview', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived']),
  information_requested: new Set(['reviewed', 'interview', 'withdrawn', 'archived']),
  interview: new Set(['information_requested', 'second_interview', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived']),
  second_interview: new Set(['information_requested', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived']),
  waitlist: new Set(['reviewed', 'information_requested', 'interview', 'second_interview', 'hired', 'rejected', 'withdrawn', 'archived']),
  hired: new Set([]),
  rejected: new Set(['reviewed', 'archived']),
  withdrawn: new Set(['reviewed', 'archived']),
  archived: new Set(['reviewed']),
}

export function validApplicationDraftId(value: unknown): value is string {
  return typeof value === 'string' && DRAFT_RE.test(value)
}

export function validSealedApplicantDocumentPath(path: string, tenantId?: string | null): boolean {
  if (path.includes('..')) return false
  const match = SEALED_DOCUMENT_PATH.exec(path)
  if (!match) return false
  return !match[1] || Boolean(tenantId && match[1] === tenantId)
}

export function canTransitionApplicant(from: ApplicantStatus, to: ApplicantStatus): boolean {
  return from === to || TRANSITIONS[from]?.has(to) === true
}

export function transitionApplicantStatus(
  from: ApplicantStatus,
  to: ApplicantStatus,
  opts: { canDecide: boolean; viaHireAction?: boolean },
): { ok: true } | { ok: false; error: string } {
  if (to === 'hired' && !opts.viaHireAction) return { ok: false, error: 'Use Approve → Crew to hire an applicant.' }
  if ((to === 'rejected' || to === 'hired') && !opts.canDecide) return { ok: false, error: 'You do not have permission to make that decision.' }
  if (!canTransitionApplicant(from, to)) return { ok: false, error: `Invalid applicant transition: ${from} → ${to}.` }
  return { ok: true }
}

type DocumentReceipt = {
  v: 1
  draftId: string
  kind: DocKind
  path: string
  expiresAt: number
}

type InformationRequestClaims = {
  v: 1
  applicantId: string
  email: string
  requestedAt: number
  expiresAt: number
}

function secret(): string {
  const value = process.env.ADMIN_SESSION_SECRET?.trim() ?? ''
  if (value.length < 16) throw new Error('applicant workflow signing secret is not configured')
  return value
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode<T>(value: string): T | null {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T } catch { return null }
}

function signature(scope: string, payload: string): string {
  return createHmac('sha256', secret()).update(`jkiss/applicant/${scope}/v1:${payload}`).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b)
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}

function createToken(scope: string, claims: object): string {
  const payload = encode(claims)
  return `${payload}.${signature(scope, payload)}`
}

function verifyToken<T>(scope: string, token: string): T | null {
  const [payload, sig, extra] = token.split('.')
  if (!payload || !sig || extra) return null
  try {
    if (!safeEqual(sig, signature(scope, payload))) return null
  } catch { return null }
  return decode<T>(payload)
}

export function createApplicantDocumentReceipt(input: {
  draftId: string
  kind: DocKind
  path: string
  now?: number
}): string {
  if (!validApplicationDraftId(input.draftId)) throw new Error('invalid application draft id')
  const now = input.now ?? Date.now()
  return createToken('document', { v: 1, ...input, expiresAt: now + TOKEN_TTL_MS } satisfies DocumentReceipt)
}

export function verifyApplicantDocumentReceipt(input: {
  receipt: string
  draftId: string
  kind: DocKind
  path: string
  now?: number
}): boolean {
  const claims = verifyToken<DocumentReceipt>('document', input.receipt)
  const now = input.now ?? Date.now()
  return claims?.v === 1
    && claims.draftId === input.draftId
    && claims.kind === input.kind
    && claims.path === input.path
    && Number.isFinite(claims.expiresAt)
    && claims.expiresAt >= now
}

export function createApplicantInformationToken(input: {
  applicantId: string
  email: string
  requestedAt: number
  now?: number
}): string {
  const now = input.now ?? Date.now()
  return createToken('information', {
    v: 1,
    applicantId: input.applicantId,
    email: input.email.trim().toLowerCase(),
    requestedAt: input.requestedAt,
    expiresAt: now + TOKEN_TTL_MS,
  } satisfies InformationRequestClaims)
}

export function verifyApplicantInformationToken(token: string, now = Date.now()): InformationRequestClaims | null {
  const claims = verifyToken<InformationRequestClaims>('information', token)
  if (claims?.v !== 1 || !claims.applicantId || !claims.email || !Number.isFinite(claims.requestedAt)
      || !Number.isFinite(claims.expiresAt) || claims.expiresAt < now) return null
  return claims
}
