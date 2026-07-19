// ── Operion Release Center — controlled Production publish (PURE) ────────────
//
// Increment 3B.4. The deterministic, side-effect-free decision core for the CONTROLLED
// production publish that CONSUMES a 3B.3 approval and promotes the approved Preview
// deployment into Production. No I/O, no execution here — the executor performs the single
// promotion, gated by everything this module verifies.
//
// SAFETY: a REAL Vercel promotion runs ONLY when the runtime is Production (VERCEL_ENV
// === 'production') AND OPERION_PRODUCTION_PROMOTION_ENABLED is on. Everywhere else
// (dev/preview/test) the executor runs in SIMULATED mode — it consumes the approval and
// records the flow but performs NO Vercel promotion. `resolvePublishMode` is that switch.

import { isEnabled } from '../flags'
import { deriveApprovalState, releaseBindingFingerprint, type ReleaseApproval, type ApprovalBinding, APPROVAL_TARGET } from './approval'
import type { EligibilityResult } from './promotion-eligibility'

const norm = (s: string | undefined | null) => (s ?? '').trim().replace(/\s+/g, ' ')
const upper = (s: string) => norm(s).toUpperCase()

/** The release-specific publish phrase — distinct from the approval phrase, never generic. */
export function publishPhrase(businessSlug: string): string {
  return `PUBLISH ${upper(businessSlug)} TO PRODUCTION`
}
export function matchesPublishPhrase(input: string | undefined | null, businessSlug: string): boolean {
  return upper(input ?? '') === publishPhrase(businessSlug)
}

/** Live promotion fires ONLY in a Production runtime with the promotion flag on. Otherwise
 *  the whole flow is exercised in SIMULATED mode (no Vercel call) — safe for preview/tests. */
export function resolvePublishMode(env: Record<string, string | undefined> = process.env): 'live' | 'simulated' {
  const isProd = (env.VERCEL_ENV ?? '').toLowerCase() === 'production'
  return isProd && isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', env) ? 'live' : 'simulated'
}

export type PublishRecordStatus = 'promoting' | 'completed' | 'failed'
export type PublishUxState =
  | 'idle' | 'publishing' | 'queued' | 'waiting' | 'ready' | 'completed' | 'failed'

export type PublishGateRefusalCode =
  | 'OWNER_REQUIRED' | 'APPROVAL_GATE_DISABLED' | 'PUBLISH_DISABLED'
  | 'BUSINESS_NOT_FOUND' | 'TEST_ONLY_BUSINESS' | 'NOT_ELIGIBLE' | 'PREVIEW_NOT_READY'
  | 'NO_ACTIVE_APPROVAL' | 'APPROVAL_EXPIRED' | 'APPROVAL_INVALIDATED' | 'APPROVAL_CONSUMED' | 'APPROVAL_REVOKED'
  | 'COMMIT_MISMATCH' | 'DEPLOYMENT_MISMATCH' | 'RELEASE_CONTEXT_MISSING' | 'PHRASE_MISMATCH'

export type PublishGateInput = {
  now: number
  isOwner: boolean
  approvalGateEnabled: boolean       // OPERION_APPROVAL_GATE_ENABLED
  publishEnabled: boolean            // OPERION_PRODUCTION_PROMOTION_ENABLED
  business: { id: string; slug: string } | null
  testOnly: boolean
  eligibility: EligibilityResult
  previewReady: boolean
  approval: ReleaseApproval | null
  binding: Partial<ApprovalBinding>  // server-derived, live
  claimed: { releaseId?: string; sourceDeploymentId?: string }
  phraseInput: string
}

export type PublishGateResult =
  | { allowed: true; approval: ReleaseApproval; binding: ApprovalBinding }
  | { allowed: false; code: PublishGateRefusalCode; message: string }

const APPROVAL_STATE_REFUSAL: Record<string, { code: PublishGateRefusalCode; message: string }> = {
  none: { code: 'NO_ACTIVE_APPROVAL', message: 'no active approval — approve the release first' },
  expired: { code: 'APPROVAL_EXPIRED', message: 'the approval has expired — re-approve to publish' },
  invalidated: { code: 'APPROVAL_INVALIDATED', message: 'the approval is invalid because the release data changed — re-approve' },
  consumed: { code: 'APPROVAL_CONSUMED', message: 'this approval has already been used to publish' },
  revoked: { code: 'APPROVAL_REVOKED', message: 'the approval was revoked — re-approve to publish' },
}

/**
 * The single authoritative decision for whether a publish may EXECUTE right now. The route
 * calls this immediately before execution (re-validating EVERYTHING server-side); the UI
 * calls it only to show/hide the button. Order: identity/flags → business safety →
 * eligibility/preview → approval liveness+binding → phrase (last, never masks a blocker).
 */
export function evaluatePublishGate(i: PublishGateInput): PublishGateResult {
  if (!i.isOwner) return no('OWNER_REQUIRED', 'platform-owner permission is required')
  if (!i.approvalGateEnabled) return no('APPROVAL_GATE_DISABLED', 'the approval gate is not enabled in this environment')
  if (!i.publishEnabled) return no('PUBLISH_DISABLED', 'production publish is disabled (OPERION_PRODUCTION_PROMOTION_ENABLED is off)')
  if (!i.business) return no('BUSINESS_NOT_FOUND', 'business not found')
  if (i.testOnly) return no('TEST_ONLY_BUSINESS', 'this business is test-only and cannot be published to production')
  if (!i.eligibility.eligible) return no('NOT_ELIGIBLE', `release has ${i.eligibility.reasons.length} blocking issue(s)`)
  if (!i.previewReady) return no('PREVIEW_NOT_READY', 'the preview deployment is not READY')

  const b = i.binding
  if (!b.businessId || !b.releaseId || !b.sourceDeploymentId) return no('RELEASE_CONTEXT_MISSING', 'business, release commit, and source deployment are all required')

  const fingerprint = releaseBindingFingerprint({ businessId: b.businessId, releaseId: b.releaseId, sourceDeploymentId: b.sourceDeploymentId, targetEnvironment: APPROVAL_TARGET })
  const state = deriveApprovalState(i.approval, i.now, fingerprint)
  if (state !== 'active') { const r = APPROVAL_STATE_REFUSAL[state] ?? APPROVAL_STATE_REFUSAL.none; return no(r.code, r.message) }
  const a = i.approval as ReleaseApproval

  // The approval MUST still be bound to the current commit + preview deployment.
  if (norm(a.releaseId) !== norm(b.releaseId)) return no('COMMIT_MISMATCH', 'the release commit changed since approval')
  if (norm(a.sourceDeploymentId) !== norm(b.sourceDeploymentId)) return no('DEPLOYMENT_MISMATCH', 'the source deployment changed since approval')
  // And the client must be publishing exactly what it saw.
  if (i.claimed.releaseId != null && norm(i.claimed.releaseId) !== norm(b.releaseId)) return no('COMMIT_MISMATCH', 'release/commit id does not match the current release')
  if (i.claimed.sourceDeploymentId != null && norm(i.claimed.sourceDeploymentId) !== norm(b.sourceDeploymentId)) return no('DEPLOYMENT_MISMATCH', 'source deployment id does not match the current release')

  if (!matchesPublishPhrase(i.phraseInput, i.business.slug)) return no('PHRASE_MISMATCH', 'the typed confirmation phrase does not match')

  return { allowed: true, approval: a, binding: { businessId: b.businessId, releaseId: b.releaseId, sourceDeploymentId: b.sourceDeploymentId, targetEnvironment: APPROVAL_TARGET } }
}

function no(code: PublishGateRefusalCode, message: string): PublishGateResult {
  return { allowed: false, code, message }
}

/** Map a stored publish status to the calm owner UX state. */
export function publishUxState(status: PublishRecordStatus | undefined): PublishUxState {
  switch (status) {
    case 'promoting': return 'publishing'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    default: return 'idle'
  }
}
