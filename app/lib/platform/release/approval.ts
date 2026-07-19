// ── Operion Release Center — owner approval + typed-confirmation gate (PURE) ──
//
// Increment 3B.3. The data model + deterministic, side-effect-free logic for the
// pre-publish APPROVAL gate that sits between the read-only Publish Review and any
// FUTURE publish execution. This module performs NO I/O and triggers NO execution.
//
// An approval RECORDS INTENT ONLY. It never merges, deploys, promotes, rolls back, or
// mutates a business. It is:
//   • owner-authorized (enforced server-side by the route; this module re-checks),
//   • bound to the exact business + release/commit + source (preview) deployment + target,
//   • short-lived (expires), single-use (consumed by a future publish), and
//   • invalidated automatically if any bound release datum changes (fingerprint drift).
//
// The confirmation phrase is release-specific — `APPROVE <SLUG> FOR PRODUCTION` — never a
// generic "CONFIRM". We store only a normalized verification RESULT (a boolean), never the
// raw typed text.

import type { EligibilityResult } from './promotion-eligibility'

/** Short-lived by design — an approval is a deliberate, immediate pre-authorization. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000 // 15 minutes
/** How long the record itself is kept in KV (so an expired approval can still be shown). */
export const APPROVAL_RECORD_TTL_MS = 24 * 60 * 60 * 1000

export const APPROVAL_TARGET = 'production' as const

/** The stored status. active/expired/invalidated are DERIVED at read time from the record
 *  + clock + current binding; consumed/revoked are persisted terminal states. */
export type ApprovalStoredStatus = 'active' | 'consumed' | 'revoked'
export type ApprovalState = 'none' | 'active' | 'expired' | 'invalidated' | 'consumed' | 'revoked'

/** The release data an approval is BOUND to. Any change here invalidates the approval. */
export type ApprovalBinding = {
  businessId: string
  releaseId: string            // the candidate commit SHA (the strongest release identifier)
  sourceDeploymentId: string   // the verified PREVIEW deployment id the candidate was proven on
  targetEnvironment: typeof APPROVAL_TARGET
}

export type ReleaseApproval = {
  recordVersion: number
  id: string                   // APRV-{n}
  businessId: string
  businessSlug: string
  releaseId: string            // candidate commit
  sourceDeploymentId: string   // preview deployment id
  targetEnvironment: typeof APPROVAL_TARGET
  bindingFingerprint: string   // hash of the binding — drift ⇒ invalidated
  approvedBy: string           // Principal.sub
  approvedAt: number
  expiresAt: number
  phraseVerified: boolean      // normalized verification RESULT only (never the raw phrase)
  status: ApprovalStoredStatus
  consumedAt?: number
  revokedAt?: number
  createdSource: string        // e.g. 'approval-route'
}

const norm = (s: string | undefined | null) => (s ?? '').trim().replace(/\s+/g, ' ')
const upper = (s: string) => norm(s).toUpperCase()

/** The canonical, release-specific confirmation phrase. Never a generic "CONFIRM". */
export function approvalPhrase(businessSlug: string): string {
  return `APPROVE ${upper(businessSlug)} FOR PRODUCTION`
}

/** Exact phrase match — trims, collapses internal whitespace, case-insensitive on content.
 *  The CONTENT must be exact (right business slug, right words); casing/spacing are tolerant. */
export function matchesApprovalPhrase(input: string | undefined | null, businessSlug: string): boolean {
  const required = approvalPhrase(businessSlug)
  return upper(input ?? '') === required
}

/** A stable, dependency-free fingerprint of the binding. Any bound field changing ⇒ a new
 *  fingerprint ⇒ the stored approval no longer matches ⇒ it is treated as invalidated. */
export function releaseBindingFingerprint(b: ApprovalBinding): string {
  const canonical = [b.businessId, b.releaseId, b.sourceDeploymentId, b.targetEnvironment].map(norm).join('|')
  // Small, fast, non-cryptographic hash (FNV-1a). This is a change-detector, not a secret.
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `fp_${(h >>> 0).toString(16)}`
}

/** Derive the live state of a stored approval against the clock + the CURRENT binding.
 *  `currentFingerprint` is recomputed from live release data; a mismatch ⇒ 'invalidated'. */
export function deriveApprovalState(
  approval: ReleaseApproval | null,
  now: number,
  currentFingerprint?: string,
): ApprovalState {
  if (!approval) return 'none'
  if (approval.status === 'revoked') return 'revoked'
  if (approval.status === 'consumed') return 'consumed'
  if (now >= approval.expiresAt) return 'expired'
  if (currentFingerprint != null && currentFingerprint !== approval.bindingFingerprint) return 'invalidated'
  return 'active'
}

/** True only when the approval is live, usable, and still bound to the same release. */
export function isApprovalUsable(approval: ReleaseApproval | null, now: number, currentFingerprint?: string): boolean {
  return deriveApprovalState(approval, now, currentFingerprint) === 'active'
}

// ── The approval-creation gate (deterministic; server re-checks, UI mirrors) ──
export type ApprovalGateRefusalCode =
  | 'OWNER_REQUIRED' | 'GATE_DISABLED' | 'BUSINESS_NOT_FOUND' | 'TEST_ONLY_BUSINESS'
  | 'NOT_ELIGIBLE' | 'PREVIEW_NOT_READY' | 'RELEASE_CONTEXT_MISSING'
  | 'PHRASE_MISMATCH' | 'BUSINESS_MISMATCH' | 'RELEASE_MISMATCH' | 'DEPLOYMENT_MISMATCH'

export type ApprovalGateInput = {
  isOwner: boolean
  gateEnabled: boolean
  business: { id: string; slug: string } | null
  testOnly: boolean
  eligibility: EligibilityResult
  previewReady: boolean
  binding: Partial<ApprovalBinding>
  /** The exact IDs the client claims to be approving — must equal the server-derived ones. */
  claimed: { businessId?: string; releaseId?: string; sourceDeploymentId?: string; targetEnvironment?: string }
  phraseInput: string
}

export type ApprovalGateResult =
  | { allowed: true; binding: ApprovalBinding }
  | { allowed: false; code: ApprovalGateRefusalCode; message: string }

/**
 * The single authoritative decision for whether an approval may be CREATED. Server-side is
 * the control; the UI calls the same predicate only to disable/label. Order matters: the
 * cheapest identity/safety checks first, phrase last (so a wrong phrase never masks a
 * blocker the owner needs to see).
 */
export function evaluateApprovalGate(i: ApprovalGateInput): ApprovalGateResult {
  if (!i.isOwner) return refuse('OWNER_REQUIRED', 'platform-owner permission is required')
  if (!i.gateEnabled) return refuse('GATE_DISABLED', 'the approval gate is not enabled in this environment')
  if (!i.business) return refuse('BUSINESS_NOT_FOUND', 'business not found')
  if (i.testOnly) return refuse('TEST_ONLY_BUSINESS', 'this business is test-only and cannot be approved for production')
  if (!i.eligibility.eligible) return refuse('NOT_ELIGIBLE', `release has ${i.eligibility.reasons.length} blocking issue(s) — resolve them before approving`)
  if (!i.previewReady) return refuse('PREVIEW_NOT_READY', 'the preview deployment is not READY')

  const b = i.binding
  if (!b.businessId || !b.releaseId || !b.sourceDeploymentId) {
    return refuse('RELEASE_CONTEXT_MISSING', 'business, release commit, and source deployment are all required to bind an approval')
  }
  // The approval MUST be bound to exactly what the client saw — mismatches are rejected so an
  // approval can never be minted for a different business/release/deployment than intended.
  if (i.claimed.businessId != null && norm(i.claimed.businessId) !== norm(b.businessId)) return refuse('BUSINESS_MISMATCH', 'business id does not match the release under review')
  if (i.claimed.releaseId != null && norm(i.claimed.releaseId) !== norm(b.releaseId)) return refuse('RELEASE_MISMATCH', 'release/commit id does not match the release under review')
  if (i.claimed.sourceDeploymentId != null && norm(i.claimed.sourceDeploymentId) !== norm(b.sourceDeploymentId)) return refuse('DEPLOYMENT_MISMATCH', 'source deployment id does not match the release under review')
  if (i.claimed.targetEnvironment != null && norm(i.claimed.targetEnvironment).toLowerCase() !== APPROVAL_TARGET) return refuse('DEPLOYMENT_MISMATCH', 'target environment must be production')

  if (!matchesApprovalPhrase(i.phraseInput, i.business.slug)) return refuse('PHRASE_MISMATCH', 'the typed confirmation phrase does not match')

  return { allowed: true, binding: { businessId: b.businessId, releaseId: b.releaseId, sourceDeploymentId: b.sourceDeploymentId, targetEnvironment: APPROVAL_TARGET } }
}

function refuse(code: ApprovalGateRefusalCode, message: string): ApprovalGateResult {
  return { allowed: false, code, message }
}

/** Owner-facing label for a derived state — calm, non-execution language. */
export function approvalStateLabel(state: ApprovalState): string {
  switch (state) {
    case 'active': return 'Approval active'
    case 'expired': return 'Approval expired'
    case 'invalidated': return 'Approval invalidated — release data changed'
    case 'consumed': return 'Approval used'
    case 'revoked': return 'Approval revoked'
    default: return 'Not approved'
  }
}
