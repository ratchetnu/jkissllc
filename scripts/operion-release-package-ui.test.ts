import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const component = readFileSync('app/admin/operations/release/ReleasePackageBuilder.tsx', 'utf8')
const page = readFileSync('app/admin/operations/release/page.tsx', 'utf8')
const route = readFileSync('app/api/admin/platform/releases/route.ts', 'utf8')

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

test('Increment 4 cannot approve, publish, or deploy a release', () => {
  assert.doesNotMatch(component, /action: ['"](?:approve|publish|deploy)['"]/)
  assert.doesNotMatch(component, /\/publish|\/deploy|\/approve/)
  assert.doesNotMatch(component, /ready_for_approval['"]\s*[,}]\s*method/)
})

test('the builder safely renders packages approved through the separate API stage', () => {
  assert.match(component, /approved: \{ label: 'Approved'/)
  assert.match(component, /Package approved and sealed/)
  assert.match(component, /No rollout or publication has started/)
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
