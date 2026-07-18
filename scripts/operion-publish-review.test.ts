// Increment 3B.2B — Publish Review builder tests (pure) + a static read-only guarantee
// for the API route. No network, no writes. Verifies assembly, "Unavailable" states,
// faithful eligibility→checklist mapping (no re-evaluation), security (no secrets), and
// data integrity.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { buildPublishReview, type BuildPublishReviewInput } from '../app/lib/platform/release/build-publish-review'
import type { EligibilityResult } from '../app/lib/platform/release/promotion-eligibility'

// ── Eligibility fixtures (constructed literals — isolate the builder from the engine) ──
const eligibleResult: EligibilityResult = {
  eligible: true, reasons: [], warnings: [{ code: 'PREVIEW_EVALUATION_ONLY', message: 'Preview may evaluate only.' }],
  requirements: [
    { category: 'authorization', name: 'Owner permission', ok: true },
    { category: 'preview_validation', name: 'Verification passed', ok: true },
    { category: 'change_integrity', name: 'Valid upgrade path', ok: true },
  ],
  evaluatedAt: 1_000, candidate: null,
}
const ineligibleResult: EligibilityResult = {
  eligible: false,
  reasons: [{ code: 'PROMOTION_DISABLED', category: 'feature_flags', message: 'OPERION_PRODUCTION_PROMOTION_ENABLED is off' }],
  warnings: [],
  requirements: [
    { category: 'feature_flags', name: 'Promotion flag enabled', ok: false, detail: 'off' },
    { category: 'authorization', name: 'Owner permission', ok: true },
  ],
  evaluatedAt: 1_000, candidate: null,
}

const baseInput = (over: Partial<BuildPublishReviewInput> = {}): BuildPublishReviewInput => ({
  now: 2_000_000,
  ownerSub: 'owner',
  business: { id: 'supercharged', name: 'Supercharged Enterprises', status: 'active', edition: 'branded_clone', role: 'target', repoName: 'ratchetnu/supercharged', productionUrl: 'https://superchargedenterprise.com', currentVersion: '1.0.0', latestVerifiedVersion: '1.0.0', latestVerifiedCommit: 'oldsha1' },
  releaseStatusLabel: 'Ready to publish',
  testOnly: false,
  job: { id: 'AUTO-9', status: 'awaiting_owner_review', workBranch: 'operion/upd-9', targetCommit: 'newsha7', approvedCommit: 'newsha7', pullRequestNumber: 3, pullRequestUrl: 'https://github.com/ratchetnu/supercharged/pull/3', previewDeploymentId: 'dpl_prev9', previewUrl: 'https://preview9.vercel.app', updatedAt: 1_990_000 },
  currentProduction: { deploymentId: undefined, deployedCommit: 'oldsha1', version: '1.0.0' },
  candidate: { version: '1.1.0', commit: 'newsha7', branch: 'operion/upd-9' },
  update: { key: 'UPD-9', title: 'Feature X', summary: 'Adds X', migrationRequired: false, environmentChangeRequired: false, secretRequired: false, breakingChange: false, rollbackSupported: true, validation: { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', e2e: 'not_applicable' }, approvedAt: 1_990_000 },
  eligibility: eligibleResult,
  ...over,
})

test('builder: refuses when the business is missing', () => {
  const r = buildPublishReview(baseInput({ business: null }))
  assert.equal(r.ok, false)
  assert.equal(r.refusal?.code, 'BUSINESS_NOT_FOUND')
  assert.equal(r.review, undefined)
})

test('builder: eligible business → complete review, deterministic on `now`', () => {
  const r = buildPublishReview(baseInput())
  assert.equal(r.ok, true)
  const v = r.review!
  assert.equal(v.business.name, 'Supercharged Enterprises')
  assert.equal(v.business.testOnly, false)
  assert.equal(v.version.current, '1.0.0')
  assert.equal(v.version.candidate, '1.1.0')
  assert.equal(v.version.releaseType, 'minor')
  assert.equal(v.version.candidateCommit, 'newsha7')
  assert.equal(v.preview.verified, true)
  assert.equal(v.preview.readyState, 'READY')
  assert.equal(v.verification.fresh, true)
  assert.equal(v.verification.checks.find((c) => c.name === 'typecheck')?.state, 'pass')
  assert.equal(v.verification.checks.find((c) => c.name === 'e2e')?.state, 'skip')
  assert.equal(v.eligibility.eligible, true)
  assert.equal(v.risk.level, 'info')
  assert.equal(v.evaluatedAt, 2_000_000)
  assert.equal(r.assembledAt, 2_000_000)
})

test('builder: eligibility maps faithfully to checklist (no re-evaluation)', () => {
  const r = buildPublishReview(baseInput({ eligibility: ineligibleResult }))
  const e = r.review!.eligibility
  assert.equal(e.eligible, false)                       // mirrors the engine result, not recomputed
  assert.equal(e.failed, 1)
  assert.equal(e.passed, 1)
  assert.equal(e.items.find((i) => i.label === 'Promotion flag enabled')?.state, 'fail')
  assert.equal(e.items.find((i) => i.label === 'Owner permission')?.state, 'pass')
  // stable reason codes surfaced
  assert.deepEqual(e.blockingReasons, [{ code: 'PROMOTION_DISABLED', message: 'OPERION_PRODUCTION_PROMOTION_ENABLED is off' }])
})

test('builder: INELIGIBLE business still returns a review + blockers', () => {
  const r = buildPublishReview(baseInput({ eligibility: ineligibleResult }))
  assert.equal(r.ok, true)                               // review is still built
  assert.equal(r.review!.eligibility.eligible, false)
  assert.ok((r.review!.eligibility.blockingReasons?.length ?? 0) > 0)
})

test('builder: warnings maps to a warn checklist item', () => {
  const e = buildPublishReview(baseInput()).review!.eligibility
  assert.ok(e.items.some((i) => i.state === 'warn' && /Preview may evaluate/.test(i.label)))
  assert.equal(e.warnings, 1)
})

test('builder: missing candidate / preview / production surface Unavailable + warnings', () => {
  const r = buildPublishReview(baseInput({ candidate: { version: undefined, commit: undefined, branch: undefined }, job: null, currentProduction: null }))
  assert.equal(r.ok, true)
  assert.equal(r.review!.preview.verified, false)
  assert.equal(r.review!.rollback.ready, false)
  assert.ok(r.review!.rollback.warning)
  assert.equal(r.review!.filesChanged.available, false) // diff not fetched in 3B.2B
  assert.ok(r.warnings.includes('candidate version unavailable'))
  assert.ok(r.warnings.includes('current production deployment id unavailable (captured at execution time)'))
})

test('builder: test-only business is flagged', () => {
  const r = buildPublishReview(baseInput({ testOnly: true, business: { ...baseInput().business!, id: 'operion-sandbox', name: 'Operion Sandbox' } }))
  assert.equal(r.review!.business.testOnly, true)
})

test('builder: legacy business (minimal fields) still resolves', () => {
  const r = buildPublishReview(baseInput({ business: { id: 'legacy', name: 'Legacy', status: 'active' }, job: null, update: null, candidate: null, currentProduction: null }))
  assert.equal(r.ok, true)
  assert.equal(r.review!.verification.checks.length, 0)
  assert.equal(r.review!.filesChanged.available, false)
})

test('builder: risk derivation from update flags', () => {
  assert.equal(buildPublishReview(baseInput({ update: { ...baseInput().update!, breakingChange: true } })).review!.risk.level, 'destructive')
  assert.equal(buildPublishReview(baseInput({ update: { ...baseInput().update!, migrationRequired: true, rollbackSupported: false } })).review!.risk.level, 'destructive')
  assert.equal(buildPublishReview(baseInput({ update: { ...baseInput().update!, environmentChangeRequired: true } })).review!.risk.level, 'warning')
})

test('builder: data integrity — candidate commit + prod version + rollback target consistent', () => {
  const v = buildPublishReview(baseInput({ currentProduction: { deploymentId: 'dpl_prod_x', version: '1.0.0', deployedCommit: 'oldsha1' } })).review!
  assert.equal(v.version.candidateCommit, v.rollback.targetDeploymentId ? 'newsha7' : 'newsha7')
  assert.equal(v.rollback.targetVersion, '1.0.0')
  assert.equal(v.rollback.targetDeploymentId, 'dpl_prod_x')
  assert.equal(v.rollback.ready, true)
  assert.equal(v.audit.correlationId, 'rel-supercharged-newsha7')
  assert.match(v.audit.willRecord.join('\n'), /Version: 1\.0\.0 → 1\.1\.0/)
})

test('security: the review payload contains no secrets / tokens / env values', () => {
  const blob = JSON.stringify(buildPublishReview(baseInput()).review).toLowerCase()
  for (const bad of ['token', 'secret', 'kv_rest', 'bearer', 'authorization', 'password', 'private_key', 'upstash']) {
    assert.equal(blob.includes(bad), false, `payload leaked "${bad}"`)
  }
})

// ── Static read-only guarantee for the route ─────────────────────────────────
test('route: publish-review is read-only (no writes, no execution, no secrets, no-store)', () => {
  const src = readFileSync(new URL('../app/api/admin/release/businesses/[id]/publish-review/route.ts', import.meta.url), 'utf8')
  assert.match(src, /requirePlatformOwner/)               // owner-gated
  assert.match(src, /no-store/)                            // cache prevention
  // no mutation / execution / lock / dispatch primitives
  for (const forbidden of ['saveBusiness', 'saveProduct', 'saveReconciliation', 'saveUpdate', 'redis.set', 'redis.zadd', 'preparePreview', 'approveProduction', 'advancePromotion', 'advanceRollback', 'transitionJob', 'dispatchWorkflow', 'mergePR', 'deploy(']) {
    assert.equal(src.includes(forbidden), false, `route must not call ${forbidden}`)
  }
  // never echoes raw env or secrets
  assert.equal(/process\.env\.KV_REST_API|process\.env\.GITHUB_APP|process\.env\.VERCEL_TOKEN/.test(src), false)
})
