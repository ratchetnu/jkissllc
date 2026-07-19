// ── Operion Release Center — controlled rollback (PURE) ──────────────────────
//
// Increment 3B.6. The deterministic, side-effect-free decision core for an owner-authorized,
// typed-confirmed rollback that restores the PRIOR known-good production deployment. No I/O and
// no execution here — the executor performs the single promotion, gated by everything this
// verifies. Like publish, a REAL Vercel rollback runs ONLY in a Production runtime with
// OPERION_PRODUCTION_PROMOTION_ENABLED on; everywhere else it is SIMULATED (no Vercel call).

import { isEnabled } from '../flags'

const norm = (s: string | undefined | null) => (s ?? '').trim().replace(/\s+/g, ' ')
const upper = (s: string) => norm(s).toUpperCase()

/** The release-specific rollback phrase — distinct from publish/approve, never generic. */
export function rollbackPhrase(businessSlug: string): string {
  return `ROLLBACK ${upper(businessSlug)} FROM PRODUCTION`
}
export function matchesRollbackPhrase(input: string | undefined | null, businessSlug: string): boolean {
  return upper(input ?? '') === rollbackPhrase(businessSlug)
}

/** Live rollback runs ONLY in a Production runtime with the promotion flag on; else simulated. */
export function resolveRollbackMode(env: Record<string, string | undefined> = process.env): 'live' | 'simulated' {
  const isProd = (env.VERCEL_ENV ?? '').toLowerCase() === 'production'
  return isProd && isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', env) ? 'live' : 'simulated'
}

export type RollbackRecordStatus = 'rolling_back' | 'completed' | 'failed'
export type RollbackUxState = 'idle' | 'rolling_back' | 'restoring' | 'rolled_back' | 'failed'

export type RollbackGateRefusalCode =
  | 'OWNER_REQUIRED' | 'GATE_DISABLED' | 'ROLLBACK_DISABLED'
  | 'BUSINESS_NOT_FOUND' | 'TEST_ONLY_BUSINESS' | 'ROLLBACK_TARGET_MISSING'
  | 'NOTHING_TO_ROLL_BACK' | 'CONCURRENT_ROLLBACK' | 'TARGET_MISMATCH' | 'PHRASE_MISMATCH'

export type RollbackGateInput = {
  isOwner: boolean
  gateEnabled: boolean              // OPERION_APPROVAL_GATE_ENABLED — the controlled-release surface
  rollbackEnabled: boolean          // OPERION_PRODUCTION_PROMOTION_ENABLED — production execution
  business: { id: string; slug: string } | null
  testOnly: boolean
  targetDeploymentId?: string       // prior known-good production deployment to restore
  currentDeploymentId?: string      // the deployment being rolled back FROM
  concurrentRollback: boolean       // a rollback is already in flight for this business
  claimedTargetDeploymentId?: string
  phraseInput: string
}

export type RollbackGateResult =
  | { allowed: true; targetDeploymentId: string; fromDeploymentId?: string }
  | { allowed: false; code: RollbackGateRefusalCode; message: string }

/**
 * The single authoritative decision for whether a rollback may EXECUTE. Owner approval is the
 * server-side gate; the typed phrase is the deliberate confirmation. Order: identity/flags →
 * business safety → a valid distinct rollback target → concurrency → phrase (last).
 */
export function evaluateRollbackGate(i: RollbackGateInput): RollbackGateResult {
  if (!i.isOwner) return no('OWNER_REQUIRED', 'platform-owner permission is required')
  if (!i.gateEnabled) return no('GATE_DISABLED', 'the approval/rollback gate is not enabled in this environment')
  if (!i.rollbackEnabled) return no('ROLLBACK_DISABLED', 'production rollback is disabled (OPERION_PRODUCTION_PROMOTION_ENABLED is off)')
  if (!i.business) return no('BUSINESS_NOT_FOUND', 'business not found')
  if (i.testOnly) return no('TEST_ONLY_BUSINESS', 'this business is test-only and cannot be rolled back in production')
  if (!i.targetDeploymentId) return no('ROLLBACK_TARGET_MISSING', 'no prior known-good production deployment to roll back to')
  if (i.currentDeploymentId && norm(i.currentDeploymentId) === norm(i.targetDeploymentId)) return no('NOTHING_TO_ROLL_BACK', 'the rollback target is already the live production deployment')
  if (i.concurrentRollback) return no('CONCURRENT_ROLLBACK', 'a rollback is already in progress for this business')
  if (i.claimedTargetDeploymentId != null && norm(i.claimedTargetDeploymentId) !== norm(i.targetDeploymentId)) return no('TARGET_MISMATCH', 'the rollback target changed since it was shown')
  if (!matchesRollbackPhrase(i.phraseInput, i.business.slug)) return no('PHRASE_MISMATCH', 'the typed confirmation phrase does not match')
  return { allowed: true, targetDeploymentId: i.targetDeploymentId, fromDeploymentId: i.currentDeploymentId }
}

function no(code: RollbackGateRefusalCode, message: string): RollbackGateResult {
  return { allowed: false, code, message }
}

export function rollbackUxState(status: RollbackRecordStatus | undefined): RollbackUxState {
  switch (status) {
    case 'rolling_back': return 'rolling_back'
    case 'completed': return 'rolled_back'
    case 'failed': return 'failed'
    default: return 'idle'
  }
}
