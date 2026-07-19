// 3B.4 fix — the approval/publish/publish-review routes must feed the REAL current production
// deployment id into promotion eligibility. Without it, eligibility permanently fails on
// PRODUCTION_DEPLOYMENT_UNKNOWN / ROLLBACK_TARGET_MISSING / AUDIT_CONTEXT_MISSING, so the
// approval + publish gates (which require eligibility.eligible) can NEVER pass — the whole
// controlled-publish workflow is inert. These tests prove the root cause + the fix. Hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { readCurrentProductionDeployment } from '../app/lib/platform/release/production-deployment'
import { evaluatePromotionEligibility, type EligibilityInput } from '../app/lib/platform/release/promotion-eligibility'

// ── Mock Vercel /v6/deployments ───────────────────────────────────────────────
type Resp = { status: number; body: unknown }
function mockFetch(routes: [string, () => Resp][]) {
  const fetch = async (url: string) => {
    for (const [pat, resp] of routes) if (url.includes(pat)) { const r = resp(); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) } }
    return { status: 404, ok: false, json: async () => ({}), text: async () => '{}' }
  }
  return fetch as never
}
const ENV = { VERCEL_TOKEN: 'vc_secret' }
const prodList = (deployments: unknown[]): [string, () => Resp][] => [['/v6/deployments', () => ({ status: 200, body: { deployments } })]]

// ── Helper ────────────────────────────────────────────────────────────────────
test('readCurrentProductionDeployment: returns the latest READY production deployment id', async () => {
  const fetch = mockFetch(prodList([{ uid: 'dpl_prod', url: 'super.vercel.app', readyState: 'READY', target: 'production', createdAt: 2000, meta: { githubCommitSha: 'prodsha' } }]))
  const r = await readCurrentProductionDeployment({ productionProjectId: 'supercharged' }, ENV, { fetch })
  assert.equal(r?.deploymentId, 'dpl_prod')
  assert.equal(r?.commit, 'prodsha')
})
test('readCurrentProductionDeployment: null when no project / not configured / none found', async () => {
  assert.equal(await readCurrentProductionDeployment(null, ENV, { fetch: mockFetch([]) }), null)                       // no business
  assert.equal(await readCurrentProductionDeployment({ productionProjectId: undefined }, ENV, { fetch: mockFetch([]) }), null) // no project
  assert.equal(await readCurrentProductionDeployment({ productionProjectId: 'p' }, {}, { fetch: mockFetch([]) }), null)        // no VERCEL_TOKEN
  const none = mockFetch(prodList([{ uid: 'x', readyState: 'BUILDING', target: 'production', createdAt: 1 }]))
  assert.equal(await readCurrentProductionDeployment({ productionProjectId: 'p' }, ENV, { fetch: none }), null)              // none READY
})

// ── Eligibility regression: the exact defect + its fix ────────────────────────
const baseInput = (deploymentId: string | undefined): EligibilityInput => ({
  now: 1_000_000, env: { vercelEnv: 'preview' }, flags: { promotionEnabled: true },
  principal: { authenticated: true, isOwner: true },
  business: { id: 'supercharged', status: 'active', role: 'target', edition: 'branded_clone', allowProductionPromotion: true, repoName: 'ratchetnu/supercharged', defaultBranch: 'main', githubInstallationId: '123', productionProjectId: 'supercharged', deployProject: 'supercharged', currentVersion: '1.0.0' },
  job: { id: 'AUTO-1', status: 'awaiting_owner_review', workBranch: 'operion/upd-1', baseBranch: 'main', approvedCommit: 'abc1234', targetCommit: 'abc1234', pullRequestNumber: 3, previewDeploymentId: 'dpl_prev', previewUrl: 'https://p', productionDeploymentId: undefined },
  previewDeployment: { id: 'dpl_prev', readyState: 'READY', commit: 'abc1234' },
  currentProduction: { deploymentId, version: '1.0.0', commit: 'oldsha' },
  candidateBranchHead: 'abc1234', verification: { passed: true, at: 999_000 },
  concurrency: { activeUpdateRun: false, activePromotionRun: false, duplicateRequest: false, lockHeld: false, alreadyPublished: false },
  candidateVersion: '1.1.0',
})

test('DEFECT: without a production deployment id, a fully-configured verified release is INELIGIBLE', () => {
  const r = evaluatePromotionEligibility(baseInput(undefined))
  assert.equal(r.eligible, false)
  const codes = r.reasons.map((x) => x.code)
  assert.ok(codes.includes('PRODUCTION_DEPLOYMENT_UNKNOWN'))
  assert.ok(codes.includes('ROLLBACK_TARGET_MISSING'))
  assert.ok(codes.includes('AUDIT_CONTEXT_MISSING'))
})
test('FIX: with the enriched production deployment id, the same release is ELIGIBLE', () => {
  const r = evaluatePromotionEligibility(baseInput('dpl_prod_real'))
  assert.equal(r.eligible, true)
  assert.deepEqual(r.reasons, [])
})

// ── Static: the routes actually feed a production deployment id into eligibility ─
function src(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8') }
test('routes: eligibility currentProduction no longer hardcodes deploymentId: undefined', () => {
  for (const f of [
    '../app/api/admin/release/businesses/[id]/approval/route.ts',
    '../app/api/admin/release/businesses/[id]/publish/route.ts',
    '../app/api/admin/release/businesses/[id]/publish-review/route.ts',
  ]) {
    const s = src(f)
    // The eligibility input must derive the id from a real production read.
    assert.equal(/currentProduction:\s*ps\s*\?\s*\{\s*deploymentId:\s*undefined/.test(s), false, `${f} still hardcodes deploymentId: undefined into eligibility`)
    assert.ok(/prod\?\.deploymentId/.test(s), `${f} must feed a real production deployment id into eligibility`)
  }
})
test('safety: the production-deployment helper is READ-ONLY (no promote/write/secret)', () => {
  const s = src('../app/lib/platform/release/production-deployment.ts')
  for (const bad of ['promoteProduction', 'createPreviewDeployment', "method: 'POST'", "method: 'PATCH'", 'VERCEL_TOKEN =', 'KV_REST_API']) {
    assert.equal(s.includes(bad), false, `helper must not reference ${bad}`)
  }
  assert.match(s, /readProductionForReview/)
})
