// ── Operion Release Center — approval store (platform:approval:* global family) ──
//
// Increment 3B.3. Persists the pre-publish approval records on the never-tenant-scoped
// `platform:` allowlist (same family as the automation jobs + audit log). WRITE surface is
// intentionally tiny: create (idempotent, race-safe), consume (single-use), revoke. It never
// touches a business, job, deployment, or any provider — it only reads/writes approval KV.
//
// Idempotency + duplicate protection: a per-business ACTIVE pointer plus a short create-mutex
// (setNxPx) guarantee at most one active approval per business, and a repeated create for the
// SAME still-valid binding returns the existing one instead of minting a conflicting second.

import { redis } from '../../redis'
import {
  type ReleaseApproval, type ApprovalBinding, APPROVAL_TTL_MS, APPROVAL_RECORD_TTL_MS, APPROVAL_TARGET,
  releaseBindingFingerprint, deriveApprovalState,
} from './approval'

const REC = (id: string) => `platform:approval:rec:${id}`
const ACTIVE = (businessId: string) => `platform:approval:active:${businessId}`
const LOCK = (businessId: string) => `platform:approval:lock:${businessId}`
const CTR = 'platform:approval:counter'
const RECORD_VERSION = 1

const parse = (raw: string | null): ReleaseApproval | null => {
  if (!raw) return null
  try { return JSON.parse(raw) as ReleaseApproval } catch { return null }
}

async function nextId(): Promise<string> { return `APRV-${1000 + (await redis.incr(CTR))}` }

export async function getApproval(id: string): Promise<ReleaseApproval | null> {
  return parse(await redis.get(REC(id)))
}

/** The current (pointer) approval for a business, whatever its derived state. */
export async function getActiveApprovalFor(businessId: string): Promise<ReleaseApproval | null> {
  const id = await redis.get(ACTIVE(businessId))
  if (!id) return null
  return getApproval(id)
}

async function persist(a: ReleaseApproval): Promise<void> {
  await redis.set(REC(a.id), JSON.stringify(a))
  await redis.pexpire(REC(a.id), APPROVAL_RECORD_TTL_MS)
}

export type CreateApprovalInput = {
  now: number
  business: { id: string; slug: string }
  binding: ApprovalBinding
  approvedBy: string
  phraseVerified: boolean
  createdSource?: string
}

export type CreateApprovalResult =
  | { ok: true; approval: ReleaseApproval; reused: boolean }
  | { ok: false; code: 'LOCK_CONTENDED'; message: string }

/**
 * Create an approval, race-safe + idempotent. If a still-active approval already exists for
 * the SAME binding, it is returned unchanged (reused:true) — repeated submissions never
 * create conflicting active approvals. A stale/mismatched prior approval is superseded.
 */
export async function createApproval(i: CreateApprovalInput): Promise<CreateApprovalResult> {
  const fingerprint = releaseBindingFingerprint(i.binding)
  const lockKey = LOCK(i.business.id)
  const gotLock = await redis.setNxPx(lockKey, i.approvedBy, 10_000)
  if (!gotLock) return { ok: false, code: 'LOCK_CONTENDED', message: 'another approval action is in flight for this business' }
  try {
    const existing = await getActiveApprovalFor(i.business.id)
    if (existing && deriveApprovalState(existing, i.now, fingerprint) === 'active' && existing.bindingFingerprint === fingerprint) {
      return { ok: true, approval: existing, reused: true } // idempotent: same live binding
    }
    // Supersede any prior pointer approval that is not usable for this exact binding.
    if (existing && existing.status === 'active') {
      await persist({ ...existing, status: 'revoked', revokedAt: i.now })
    }
    const approval: ReleaseApproval = {
      recordVersion: RECORD_VERSION,
      id: await nextId(),
      businessId: i.business.id,
      businessSlug: i.business.slug,
      releaseId: i.binding.releaseId,
      sourceDeploymentId: i.binding.sourceDeploymentId,
      targetEnvironment: APPROVAL_TARGET,
      bindingFingerprint: fingerprint,
      approvedBy: i.approvedBy,
      approvedAt: i.now,
      expiresAt: i.now + APPROVAL_TTL_MS,
      phraseVerified: i.phraseVerified,
      status: 'active',
      createdSource: i.createdSource ?? 'approval-store',
    }
    await persist(approval)
    await redis.set(ACTIVE(i.business.id), approval.id)
    await redis.pexpire(ACTIVE(i.business.id), APPROVAL_RECORD_TTL_MS)
    return { ok: true, approval, reused: false }
  } finally {
    // Best-effort release of the short mutex (it also self-expires in 10s).
    await redis.del(lockKey).catch(() => {})
  }
}

/** Single-use: consume an approval iff it is active AND still bound to the same release.
 *  (No publish exists this phase; exposed + tested for the FUTURE publish action.) */
export async function consumeApproval(
  id: string,
  opts: { now: number; expectedFingerprint: string },
): Promise<{ ok: true; approval: ReleaseApproval } | { ok: false; code: string }> {
  const a = await getApproval(id)
  if (!a) return { ok: false, code: 'NOT_FOUND' }
  if (deriveApprovalState(a, opts.now, opts.expectedFingerprint) !== 'active') return { ok: false, code: 'NOT_ACTIVE' }
  const consumed: ReleaseApproval = { ...a, status: 'consumed', consumedAt: opts.now }
  await persist(consumed)
  return { ok: true, approval: consumed }
}

/** Owner revoke of an active approval. Idempotent-ish: revoking a non-active one is a no-op ok. */
export async function revokeApproval(id: string, now: number): Promise<ReleaseApproval | null> {
  const a = await getApproval(id)
  if (!a) return null
  if (a.status !== 'active') return a
  const revoked: ReleaseApproval = { ...a, status: 'revoked', revokedAt: now }
  await persist(revoked)
  return revoked
}
