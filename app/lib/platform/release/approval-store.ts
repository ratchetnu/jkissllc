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
import { acquireLock } from '../../kv-lock'
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
  // LOCK-1: the lease used to store `approvedBy` and release with an unconditional
  // DEL — so two approvals by the SAME admin held indistinguishable values and could
  // release each other, and a lapsed holder deleted the next holder's lock. The token
  // is now unique per acquisition and the release is compare-and-delete. The
  // idempotency/supersede logic below is unchanged.
  const lock = await acquireLock(LOCK(i.business.id), { ttlMs: 10_000, holder: i.approvedBy })
  if (!lock) return { ok: false, code: 'LOCK_CONTENDED', message: 'another approval action is in flight for this business' }
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
    // Release only if we still own it (it also self-expires in 10s).
    await lock.release()
  }
}

/** Single-use: consume an approval iff it is active AND still bound to the same release.
 *  (No publish exists this phase; exposed + tested for the FUTURE publish action.) */
// APRV-1: the active → consumed transition must be won by exactly ONE caller.
// It used to be GET → check 'active' → SET 'consumed', so three concurrent consumes
// all read 'active' and all reported success (reproduced 3/3 in the race audit).
// Nothing double-published, because executePublish holds the per-business lock and
// re-checks the approval→publish pointer inside it — but "single-use" then lived
// entirely in the CALLER. A new call site without that lock would have promoted to
// Production twice. This script makes the contract self-enforcing.
//
// Compare-and-set on the stored record: re-read it INSIDE Redis, verify it is still
// exactly the status we expect, and only then write. Every other field is preserved
// because the caller supplies the full consumed record — the script never rebuilds
// the approval, it just refuses to write when the precondition no longer holds.
const CONSUME_IF_ACTIVE = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local decoded = cjson.decode(raw)
  if decoded.status ~= ARGV[2] then return 0 end
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
`

export async function consumeApproval(
  id: string,
  opts: { now: number; expectedFingerprint: string },
): Promise<{ ok: true; approval: ReleaseApproval } | { ok: false; code: string }> {
  const a = await getApproval(id)
  if (!a) return { ok: false, code: 'NOT_FOUND' }
  // Every non-atomic precondition (expiry, fingerprint drift, revoked) is still
  // decided here; only the status transition itself needs to be atomic.
  if (deriveApprovalState(a, opts.now, opts.expectedFingerprint) !== 'active') return { ok: false, code: 'NOT_ACTIVE' }

  const consumed: ReleaseApproval = { ...a, status: 'consumed', consumedAt: opts.now }
  const won = await redis.eval(
    CONSUME_IF_ACTIVE,
    [REC(id)],
    [JSON.stringify(consumed), 'active', String(APPROVAL_RECORD_TTL_MS)],
  )
  // Lost the CAS: someone else moved it out of 'active' first. The record is
  // untouched by this call.
  if (won !== 1 && won !== '1') return { ok: false, code: 'ALREADY_CONSUMED' }
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
