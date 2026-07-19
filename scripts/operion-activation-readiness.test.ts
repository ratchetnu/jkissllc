// Operion 3B.7 — deterministic activation-readiness and read-only surface tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { evaluateActivationReadiness, type ActivationReadinessInput } from '../app/lib/platform/release/activation-readiness'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

const ROOT = path.resolve(import.meta.dirname, '..')

function business(over: Partial<PlatformBusiness> = {}): PlatformBusiness {
  return {
    recordVersion: 1, id: 'jkiss', name: 'J KISS LLC', slug: 'jkiss', edition: 'internal',
    status: 'active', role: 'source_and_target', repoName: 'ratchetnu/jkissllc', defaultBranch: 'main',
    releaseChannel: 'stable', updatePolicy: 'owner_approval', updatesPaused: false,
    manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy',
    automationMode: 'approved_production', githubInstallationId: 'installation-id',
    automationWorkflowFile: 'operion-update.yml', rollbackWorkflowFile: 'operion-rollback.yml',
    previewDeploymentProvider: 'vercel', previewProjectId: 'jkissllc', productionProjectId: 'jkissllc',
    allowedTargetBranches: ['main'], requireOwnerApproval: true, allowProductionPromotion: true,
    configurationStatus: 'ready', createdAt: 1, updatedAt: 1,
    ...over,
  }
}

function input(over: Partial<ActivationReadinessInput> = {}): ActivationReadinessInput {
  return {
    now: 1000,
    environment: 'production',
    configured: { githubApp: true, vercel: true, callbackSecret: true },
    flags: {
      automation: false, githubActions: false, previewAutomation: false,
      approvalGate: false, productionPromotion: false, aiAdaptation: false, automaticRollback: false,
    },
    businesses: [business()],
    rollbackTargets: { jkiss: { currentDeploymentId: 'dpl-current', targetDeploymentId: 'dpl-prior' } },
    ...over,
  }
}

test('configured system with flags off is safe to enable but truthfully disabled', () => {
  const result = evaluateActivationReadiness(input())
  assert.equal(result.safeToEnablePreview, true)
  assert.equal(result.safeToEnableProduction, true)
  assert.equal(result.stages.find((s) => s.id === 'provider_access')?.state, 'ready')
  assert.equal(result.stages.find((s) => s.id === 'preview_automation')?.state, 'disabled')
  assert.equal(result.stages.find((s) => s.id === 'controlled_production')?.state, 'disabled')
})

test('missing provider configuration blocks every execution stage', () => {
  const result = evaluateActivationReadiness(input({ configured: { githubApp: false, vercel: true, callbackSecret: true } }))
  assert.equal(result.safeToEnablePreview, false)
  assert.equal(result.safeToEnableProduction, false)
  assert.equal(result.stages.find((s) => s.id === 'provider_access')?.state, 'blocked')
  assert.equal(result.stages.find((s) => s.id === 'preview_automation')?.state, 'blocked')
})

test('production remains blocked without a distinct prior deployment', () => {
  const result = evaluateActivationReadiness(input({ rollbackTargets: { jkiss: { currentDeploymentId: 'dpl-current' } } }))
  assert.equal(result.safeToEnablePreview, true)
  assert.equal(result.safeToEnableProduction, false)
  assert.equal(result.businesses[0].readyForPreview, true)
  assert.equal(result.businesses[0].readyForProduction, false)
  assert.equal(result.stages.find((s) => s.id === 'controlled_production')?.state, 'blocked')
})

test('owner approval is fail-closed unless both policy fields are explicitly true', () => {
  const missingNewPolicy = evaluateActivationReadiness(input({ businesses: [business({ requireOwnerApproval: undefined })] }))
  const disabledLegacyPolicy = evaluateActivationReadiness(input({ businesses: [business({ manualApprovalRequired: false })] }))
  assert.equal(missingNewPolicy.safeToEnablePreview, true)
  assert.equal(missingNewPolicy.safeToEnableProduction, false)
  assert.equal(disabledLegacyPolicy.safeToEnableProduction, false)
  assert.equal(missingNewPolicy.businesses[0].checks.find((c) => c.id === 'owner_approval')?.ok, false)
})

test('automatic rollback uses the server-side executor and ignores legacy workflow metadata', () => {
  const result = evaluateActivationReadiness(input({ businesses: [business({ rollbackWorkflowFile: undefined })] }))
  assert.equal(result.safeToEnableProduction, true) // controlled typed rollback uses the deployment target
  assert.equal(result.businesses[0].checks.find((c) => c.id === 'rollback_executor')?.ok, true)
  assert.equal(result.stages.find((s) => s.id === 'advanced_automation')?.checks.find((c) => c.id === 'all_rollback_executors')?.ok, true)
})

test('automatic rollback remains blocked without a prior known-good deployment', () => {
  const result = evaluateActivationReadiness(input({ rollbackTargets: { jkiss: { currentDeploymentId: 'dpl-current' } } }))
  assert.equal(result.businesses[0].checks.find((c) => c.id === 'rollback_executor')?.ok, false)
  assert.equal(result.stages.find((s) => s.id === 'advanced_automation')?.state, 'blocked')
})

test('test-only sandbox records are excluded from activation decisions', () => {
  const sandbox = business({ id: 'operion-sandbox', slug: 'operion-sandbox', name: 'Sandbox', edition: 'sandbox', role: 'target', configurationStatus: 'error' })
  const result = evaluateActivationReadiness(input({ businesses: [business(), sandbox] }))
  assert.deepEqual(result.businesses.map((b) => b.id), ['jkiss'])
  assert.equal(result.safeToEnableProduction, true)
})

test('activation API is owner-only, no-store, read-only, and returns no secret values', () => {
  const route = fs.readFileSync(path.join(ROOT, 'app/api/admin/release/activation-readiness/route.ts'), 'utf8')
  assert.match(route, /requirePlatformOwner/)
  assert.match(route, /Cache-Control.*no-store/)
  assert.match(route, /export const GET/)
  assert.doesNotMatch(route, /export const (POST|PUT|PATCH|DELETE)/)
  assert.doesNotMatch(route, /process\.env\[[^\]]+\]|Object\.entries\(process\.env\)|\.value\b/)
})

test('readiness membership uses named checks rather than display-order slices', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app/lib/platform/release/activation-readiness.ts'), 'utf8')
  assert.match(source, /PREVIEW_BUSINESS_CHECKS/)
  assert.match(source, /PRODUCTION_BUSINESS_CHECKS/)
  assert.match(source, /namedChecksPass/)
  assert.doesNotMatch(source, /checks\.slice\(/)
})

test('Release Center exposes readiness and no longer claims rollback is unavailable', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/admin/operations/release/page.tsx'), 'utf8')
  const publish = fs.readFileSync(path.join(ROOT, 'app/admin/operations/release/ProductionPublishPanel.tsx'), 'utf8')
  assert.match(page, /Activation Readiness/)
  assert.match(page, /controlled rollback/i)
  assert.doesNotMatch(page, /No deploy or rollback controls/)
  assert.doesNotMatch(publish, /rollback is not implemented/i)
})

test('shared tab list wraps every Release Center tab into narrow screens', () => {
  const tabs = fs.readFileSync(path.join(ROOT, 'app/components/ui/overlays.tsx'), 'utf8')
  assert.match(tabs, /role="tablist"[^\n]+flexWrap: 'wrap'/)
  assert.match(tabs, /role="tablist"[^\n]+width: '100%'[^\n]+minWidth: 0/)
  assert.match(tabs, /flex: '0 1 auto'/)
  assert.match(tabs, /whiteSpace: 'normal'/)
})
