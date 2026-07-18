// Increment 3B.1 — pure tests: promotion state model + transitions, resolver
// integration (preview states unchanged), the flag semantics, and the eligibility
// evaluator across all ten categories + refusal codes. No I/O, no execution.
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReleaseState, STATUS_LABEL, ACTION_LABEL, statusTone, type ReleaseSignals } from '../app/lib/platform/release/state'
import {
  promotionPhaseOf, canReleasePromotionTransition, PROMOTION_PHASE_TO_RELEASE, PROMOTION_RELEASE_STATES,
  type PromotionPhase,
} from '../app/lib/platform/release/promotion-state'
import { evaluatePromotionEligibility, type EligibilityInput, type EligibilityRefusalCode } from '../app/lib/platform/release/promotion-eligibility'
import { isRepoAllowed, isVercelProjectAllowed, isTestOnlyBusiness, environmentAllowsEvaluation, promotionExecutionRefusal } from '../app/lib/platform/release/promotion-guards'
import { isEnabled } from '../app/lib/platform/flags'

// ── State model ──────────────────────────────────────────────────────────────
const previewSignals = (over: Partial<ReleaseSignals> = {}): ReleaseSignals => ({
  initialized: true, installedVersion: '0.1.0', latestVersion: '0.1.1', health: 'unknown',
  updateAvailable: true, job: 'none', previewVerified: false, verificationFailed: false,
  blocking: [], driftReasons: [], ...over,
})

test('state: preview-only behavior is unchanged when no promotion phase is present', () => {
  assert.equal(resolveReleaseState(previewSignals()).status, 'update_available')
  assert.equal(resolveReleaseState(previewSignals({ job: 'awaiting_approval' })).status, 'ready_to_publish')
  assert.equal(resolveReleaseState(previewSignals({ job: 'awaiting_approval' })).action, 'publish')
  assert.equal(resolveReleaseState(previewSignals({ verificationFailed: true })).status, 'verification_failed')
  assert.equal(resolveReleaseState(previewSignals({ initialized: false })).status, 'not_initialized')
})

test('state: every promotion phase resolves to its release status + action', () => {
  const expect: Record<PromotionPhase, string> = {
    awaiting_approval: 'awaiting_approval', publishing: 'publishing', verifying_production: 'verifying_production',
    published: 'published', publish_failed: 'publish_failed', rolling_back: 'rolling_back',
    rolled_back: 'rolled_back', rollback_failed: 'rollback_failed',
  }
  for (const phase of Object.keys(expect) as PromotionPhase[]) {
    const rs = resolveReleaseState(previewSignals({ promotion: phase }))
    assert.equal(rs.status, expect[phase], `${phase} → ${expect[phase]}`)
    assert.equal(rs.status, PROMOTION_PHASE_TO_RELEASE[phase].status)
    assert.ok(STATUS_LABEL[rs.status] && ACTION_LABEL[rs.action]) // labels exist for all new states
    assert.ok(['ok', 'attention', 'busy', 'critical', 'neutral'].includes(statusTone(rs.status)))
  }
})

test('state: promotion dominates the display (precedence) but is inert otherwise', () => {
  // present + verified would be ready_to_publish, but an active promotion overrides it
  const rs = resolveReleaseState(previewSignals({ previewVerified: true, promotion: 'publishing' }))
  assert.equal(rs.status, 'publishing')
  // legacy/unknown-safe: no promotion → identical to 3A
  assert.equal(resolveReleaseState(previewSignals({ previewVerified: true })).status, 'ready_to_publish')
})

test('state: automation status → promotion phase mapping (shared terminals disambiguated)', () => {
  assert.equal(promotionPhaseOf('approved_for_production'), 'awaiting_approval')
  assert.equal(promotionPhaseOf('merging'), 'publishing')
  assert.equal(promotionPhaseOf('production_deploying'), 'verifying_production')
  assert.equal(promotionPhaseOf('verifying'), 'verifying_production')
  assert.equal(promotionPhaseOf('rolled_back'), 'rolled_back')
  // completed/failed are preview OR promotion — only promotion jobs project a promotion phase
  assert.equal(promotionPhaseOf('completed'), null)
  assert.equal(promotionPhaseOf('completed', { isPromotionJob: true }), 'published')
  assert.equal(promotionPhaseOf('failed'), null)
  assert.equal(promotionPhaseOf('failed', { isPromotionJob: true }), 'publish_failed')
  assert.equal(promotionPhaseOf('rolling_back', { rollbackFailed: true }), 'rollback_failed')
  assert.equal(promotionPhaseOf('preview_ready'), null) // preview phase is not a promotion phase
})

test('state: transition table — the only door in is ready_to_publish → awaiting_approval; invalid transitions fail', () => {
  assert.equal(canReleasePromotionTransition('ready_to_publish', 'awaiting_approval'), true)
  assert.equal(canReleasePromotionTransition('awaiting_approval', 'publishing'), true)
  assert.equal(canReleasePromotionTransition('publishing', 'verifying_production'), true)
  assert.equal(canReleasePromotionTransition('verifying_production', 'published'), true)
  assert.equal(canReleasePromotionTransition('published', 'rolling_back'), true)
  assert.equal(canReleasePromotionTransition('rolling_back', 'rolled_back'), true)
  assert.equal(canReleasePromotionTransition('rolling_back', 'rollback_failed'), true)
  // invalid / no skipping
  assert.equal(canReleasePromotionTransition('ready_to_publish', 'publishing'), false)
  assert.equal(canReleasePromotionTransition('published', 'awaiting_approval'), false)
  assert.equal(canReleasePromotionTransition('rolled_back', 'published'), false)
  assert.equal(canReleasePromotionTransition('update_available', 'publishing'), false)
  assert.equal(PROMOTION_RELEASE_STATES.length, 8)
})

// ── Feature flag semantics ───────────────────────────────────────────────────
test('flag: missing/empty/invalid → false; explicit true/1 → true (server-side)', () => {
  assert.equal(isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', {}), false)                                  // missing
  assert.equal(isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', { OPERION_PRODUCTION_PROMOTION_ENABLED: '' }), false)      // empty
  assert.equal(isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', { OPERION_PRODUCTION_PROMOTION_ENABLED: 'maybe' }), false) // invalid
  assert.equal(isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', { OPERION_PRODUCTION_PROMOTION_ENABLED: 'true' }), true)
  assert.equal(isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED', { OPERION_PRODUCTION_PROMOTION_ENABLED: '1' }), true)
})

// ── Guards ───────────────────────────────────────────────────────────────────
test('guards: allowlists + test-only + environment + execution refusal', () => {
  assert.equal(isRepoAllowed('ratchetnu/jkissllc'), true)
  assert.equal(isRepoAllowed('ratchetnu/operion-sandbox'), false)
  assert.equal(isVercelProjectAllowed('jkissllc'), true)
  assert.equal(isVercelProjectAllowed('operion-sandbox'), false)
  assert.equal(isTestOnlyBusiness({ id: 'operion-sandbox' }), true)
  assert.equal(isTestOnlyBusiness({ id: 'jkiss', edition: 'sandbox' }), true)
  assert.equal(isTestOnlyBusiness({ id: 'jkiss', edition: 'internal' }), false)
  assert.equal(environmentAllowsEvaluation('production'), true)
  assert.equal(environmentAllowsEvaluation('preview'), true)
  assert.equal(environmentAllowsEvaluation('development'), false)
  // 3B.1 backstop: execution is ALWAYS refused
  assert.equal(promotionExecutionRefusal().allowed, false)
})

// ── Eligibility evaluator ────────────────────────────────────────────────────
const fullyEligible = (): EligibilityInput => ({
  now: 1_000_000,
  env: { vercelEnv: 'production' },
  flags: { promotionEnabled: true },
  principal: { authenticated: true, isOwner: true },
  business: { id: 'jkiss', status: 'active', role: 'source', edition: 'internal', allowProductionPromotion: true, repoName: 'ratchetnu/jkissllc', defaultBranch: 'main', githubInstallationId: '146887383', productionProjectId: 'jkissllc', currentVersion: '1.0.0' },
  job: { id: 'AUTO-1', status: 'awaiting_owner_review', workBranch: 'operion/upd-1', baseBranch: 'main', approvedCommit: 'abc1234', targetCommit: 'abc1234', pullRequestNumber: 7, previewDeploymentId: 'dpl_prev', previewUrl: 'https://preview.example', productionDeploymentId: undefined },
  previewDeployment: { id: 'dpl_prev', readyState: 'READY', commit: 'abc1234' },
  currentProduction: { deploymentId: 'dpl_prod_known', version: '1.0.0', commit: 'oldsha' },
  candidateBranchHead: 'abc1234',
  verification: { passed: true, at: 1_000_000 },
  concurrency: { activeUpdateRun: false, activePromotionRun: false, duplicateRequest: false, lockHeld: false, alreadyPublished: false },
  candidateVersion: '1.1.0',
})

const codes = (i: EligibilityInput): EligibilityRefusalCode[] => evaluatePromotionEligibility(i).reasons.map((r) => r.code)

test('eligibility: the fully-satisfied snapshot is eligible with no reasons', () => {
  const r = evaluatePromotionEligibility(fullyEligible())
  assert.equal(r.eligible, true, JSON.stringify(r.reasons))
  assert.deepEqual(r.reasons, [])
  assert.ok(r.requirements.length >= 20)
  assert.equal(r.candidate?.candidateVersion, '1.1.0')
  assert.equal(r.evaluatedAt, 1_000_000)
})

test('eligibility: authorization', () => {
  assert.ok(codes({ ...fullyEligible(), principal: { authenticated: false, isOwner: false } }).includes('OWNER_REQUIRED'))
  assert.ok(codes({ ...fullyEligible(), principal: { authenticated: true, isOwner: false } }).includes('OWNER_REQUIRED'))
})

test('eligibility: feature flag off ⇒ PROMOTION_DISABLED', () => {
  assert.ok(codes({ ...fullyEligible(), flags: { promotionEnabled: false } }).includes('PROMOTION_DISABLED'))
})

test('eligibility: environment refusal (dev/test) + preview warning', () => {
  assert.ok(codes({ ...fullyEligible(), env: { vercelEnv: 'development' } }).includes('INVALID_ENVIRONMENT'))
  assert.ok(codes({ ...fullyEligible(), env: { vercelEnv: undefined } }).includes('INVALID_ENVIRONMENT'))
  const preview = evaluatePromotionEligibility({ ...fullyEligible(), env: { vercelEnv: 'preview' } })
  assert.ok(!preview.reasons.some((r) => r.code === 'INVALID_ENVIRONMENT'))
  assert.ok(preview.warnings.some((w) => w.code === 'PREVIEW_EVALUATION_ONLY'))
})

test('eligibility: business safety', () => {
  assert.ok(codes({ ...fullyEligible(), business: null }).includes('BUSINESS_NOT_FOUND'))
  assert.ok(codes({ ...fullyEligible(), business: { ...fullyEligible().business!, status: 'paused' } }).includes('BUSINESS_INACTIVE'))
  assert.ok(codes({ ...fullyEligible(), business: { ...fullyEligible().business!, allowProductionPromotion: false } }).includes('TEST_ONLY_BUSINESS'))
  // Operion Sandbox refused even if the flag were flipped on the record
  assert.ok(codes({ ...fullyEligible(), business: { ...fullyEligible().business!, id: 'operion-sandbox', edition: 'sandbox', allowProductionPromotion: true, repoName: 'ratchetnu/operion-sandbox', productionProjectId: 'operion-sandbox' } }).includes('TEST_ONLY_BUSINESS'))
})

test('eligibility: preview validation', () => {
  assert.ok(codes({ ...fullyEligible(), previewDeployment: null, job: { ...fullyEligible().job!, previewDeploymentId: undefined } }).includes('PREVIEW_NOT_READY'))
  assert.ok(codes({ ...fullyEligible(), previewDeployment: { id: 'x', readyState: 'BUILDING' } }).includes('PREVIEW_NOT_READY'))
  assert.ok(codes({ ...fullyEligible(), verification: null }).includes('VERIFICATION_MISSING'))
  assert.ok(codes({ ...fullyEligible(), verification: { passed: false, at: 1_000_000 } }).includes('VERIFICATION_FAILED'))
  assert.ok(codes({ ...fullyEligible(), verification: { passed: true, at: 1 }, verificationTtlMs: 1000 }).includes('VERIFICATION_EXPIRED'))
})

test('eligibility: candidate integrity', () => {
  assert.ok(codes({ ...fullyEligible(), job: { ...fullyEligible().job!, workBranch: undefined } }).includes('CANDIDATE_MISSING'))
  assert.ok(codes({ ...fullyEligible(), candidateBranchHead: 'DRIFTED' }).includes('CANDIDATE_CHANGED'))
  assert.ok(codes({ ...fullyEligible(), job: { ...fullyEligible().job!, targetCommit: 'zzz999' } }).includes('COMMIT_MISMATCH'))
  assert.ok(codes({ ...fullyEligible(), candidateVersion: '1.0.0' }).includes('UPGRADE_PATH_INVALID')) // equals prod
  assert.ok(codes({ ...fullyEligible(), candidateVersion: '0.9.0' }).includes('UPGRADE_PATH_INVALID')) // older than prod
  assert.ok(codes({ ...fullyEligible(), candidateVersion: undefined }).includes('VERSION_INVALID'))
})

test('eligibility: concurrency & idempotency', () => {
  assert.ok(codes({ ...fullyEligible(), concurrency: { ...fullyEligible().concurrency!, activeUpdateRun: true } }).includes('ACTIVE_RUN_EXISTS'))
  assert.ok(codes({ ...fullyEligible(), concurrency: { ...fullyEligible().concurrency!, activePromotionRun: true } }).includes('ACTIVE_RUN_EXISTS'))
  assert.ok(codes({ ...fullyEligible(), concurrency: { ...fullyEligible().concurrency!, duplicateRequest: true } }).includes('DUPLICATE_PROMOTION'))
  assert.ok(codes({ ...fullyEligible(), concurrency: { ...fullyEligible().concurrency!, lockHeld: true } }).includes('PROMOTION_LOCKED'))
  assert.ok(codes({ ...fullyEligible(), concurrency: { ...fullyEligible().concurrency!, alreadyPublished: true } }).includes('ALREADY_PUBLISHED'))
})

test('eligibility: allowlists (repo + vercel)', () => {
  assert.ok(codes({ ...fullyEligible(), business: { ...fullyEligible().business!, repoName: 'ratchetnu/unknown-repo' } }).includes('REPOSITORY_NOT_ALLOWED'))
  assert.ok(codes({ ...fullyEligible(), business: { ...fullyEligible().business!, productionProjectId: 'unknown-project', deployProject: 'unknown-project' } }).includes('PRODUCTION_PROJECT_NOT_ALLOWED'))
})

test('eligibility: rollback readiness (current production must be known)', () => {
  assert.ok(codes({ ...fullyEligible(), currentProduction: { deploymentId: undefined, version: '1.0.0' } }).includes('PRODUCTION_DEPLOYMENT_UNKNOWN'))
  assert.ok(codes({ ...fullyEligible(), currentProduction: { deploymentId: undefined, version: '1.0.0' } }).includes('ROLLBACK_TARGET_MISSING'))
})

test('eligibility: branch restriction (target must be the business default branch)', () => {
  assert.ok(codes({ ...fullyEligible(), job: { ...fullyEligible().job!, baseBranch: 'not-main' } }).includes('BRANCH_NOT_ALLOWED'))
})

test('eligibility: evaluator is pure (same input → same output; no throw on empty)', () => {
  const a = evaluatePromotionEligibility(fullyEligible())
  const b = evaluatePromotionEligibility(fullyEligible())
  assert.deepEqual(a, b)
  // minimal/empty snapshot returns a structured refusal set, never throws
  const empty = evaluatePromotionEligibility({ now: 0, env: {}, flags: { promotionEnabled: false }, principal: { authenticated: false, isOwner: false } })
  assert.equal(empty.eligible, false)
  assert.ok(empty.reasons.some((r) => r.code === 'PROMOTION_DISABLED'))
})
