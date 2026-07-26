import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const component = readFileSync('app/admin/operations/release/ReleasePackageBuilder.tsx', 'utf8')
const page = readFileSync('app/admin/operations/release/page.tsx', 'utf8')
const route = readFileSync('app/api/admin/platform/releases/route.ts', 'utf8')
const detailRoute = readFileSync('app/api/admin/platform/releases/[id]/route.ts', 'utf8')
const publishReviewDrawer = readFileSync('app/admin/operations/release/PublishReviewDrawer.tsx', 'utf8')
const approvalPanel = readFileSync('app/admin/operations/release/ReleaseApprovalPanel.tsx', 'utf8')
const publishPanel = readFileSync('app/admin/operations/release/ProductionPublishPanel.tsx', 'utf8')

test('Release Center exposes the package builder as an owner workspace', () => {
  assert.match(page, /id: 'packages', label: 'Build Release'/)
  assert.match(page, /activeTab === 'packages' && <ReleasePackageBuilder \/>/)
  assert.match(component, /Build a release/)
  assert.match(component, /Saving creates a draft only/)
  assert.match(component, /Nothing has been published/)
})

test('the browser consumes server readiness and does not reproduce release policy', () => {
  assert.match(component, /\/api\/admin\/platform\/releases/)
  assert.match(component, /action: 'mark-ready'/)
  assert.doesNotMatch(component, /semver-policy|evaluateVersionBump|evaluateReleasePackageReadiness|updateReleaseEligible/)
  assert.match(route, /updateReleaseEligible/)
  assert.match(route, /eligible: readiness\.eligible/)
  assert.match(route, /reasons: readiness\.reasons/)
})

test('the package workspace cannot approve, publish, or deploy a release', () => {
  assert.doesNotMatch(component, /action: ['"](?:approve|publish|deploy)['"]/)
  assert.doesNotMatch(component, /\/publish|\/deploy|\/approve/)
  assert.doesNotMatch(component, /ready_for_approval['"]\s*[,}]\s*method/)
})

test('the builder safely renders packages approved through the separate API stage', () => {
  assert.match(component, /approved: \{ label: 'Approved'/)
  assert.match(component, /Package approved and sealed/)
  assert.match(component, /Create rollout plan/)
  assert.match(component, /action: 'create-rollout'/)
  assert.match(component, /No site changes have started/)
  assert.doesNotMatch(component, /action: ['"](?:publish|deploy|promote)['"]/)
})

test('execution readiness hands off only to the existing controlled publish workflow', () => {
  assert.match(component, /Check execution readiness/)
  assert.match(component, /cache: 'no-store'/)
  assert.match(component, /Continue to controlled publish review/)
  assert.match(component, /Opening it does not publish/)
  assert.match(component, /<PublishReviewDrawer/)
  assert.match(component, /expectedRelease=/)
  assert.match(detailRoute, /evaluateRolloutExecutionReadiness/)
  assert.match(detailRoute, /evaluateRolloutExecutionHandoff/)
  assert.match(detailRoute, /AUTOMATION_ACTIVE/)
  assert.match(detailRoute, /listJobs\(500\)/)
  assert.doesNotMatch(component, /action: ['"](?:execute|publish|deploy|promote)['"]/)
  assert.doesNotMatch(component, /\/execute|\/publish|\/deploy|\/promote/)
})

test('the package artifact stays pinned through review, approval, and final publish confirmation', () => {
  assert.match(publishReviewDrawer, /candidateCommit !== expectedReleaseId/)
  assert.match(publishReviewDrawer, /deploymentId !== expectedSourceDeploymentId/)
  assert.match(publishReviewDrawer, /Run execution readiness again/)
  assert.match(publishReviewDrawer, /<ReleaseApprovalPanel businessId=\{businessId\} expectedRelease=\{expectedRelease\}/)
  assert.match(publishReviewDrawer, /<ProductionPublishPanel businessId=\{businessId\} expectedRelease=\{expectedRelease\}/)
  assert.match(approvalPanel, /releaseId: expectedRelease\?\.releaseId/)
  assert.match(approvalPanel, /sourceDeploymentId: expectedRelease\?\.sourceDeploymentId/)
  assert.match(publishPanel, /releaseId: expectedRelease\?\.releaseId/)
  assert.match(publishPanel, /sourceDeploymentId: expectedRelease\?\.sourceDeploymentId/)
  assert.match(approvalPanel, /expectedReleaseMatches/)
  assert.match(publishPanel, /expectedReleaseMatches/)
})

test('the package builder includes accessible names and a responsive single-column boundary', () => {
  assert.match(component, /aria-label="Release customer"/)
  assert.match(component, /aria-label="Release version"/)
  assert.match(component, /aria-label="Release channel"/)
  assert.match(component, /aria-label="Data changes"/)
  assert.match(component, /aria-label="Recent release packages"/)
  assert.match(component, /@media \(max-width: 780px\)/)
  assert.match(component, /grid-template-columns: minmax\(0, 1fr\)/)
})
