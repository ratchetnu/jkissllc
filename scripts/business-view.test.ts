// Operion business-detail view model — pure tests for readiness, next-step, and grouping.
import assert from 'node:assert/strict'
import test from 'node:test'
import { businessReadiness, businessNextStep, updateBucket, groupUpdates, BUCKET_ORDER } from '../app/lib/platform/updates/business-view'
import type { PlatformBusiness, PlatformUpdate } from '../app/lib/platform/updates/types'

const T = 1_700_000_000_000
function mkBiz(p: Partial<PlatformBusiness> = {}): PlatformBusiness {
  return {
    recordVersion: 1, id: 'supercharged', name: 'Supercharged', slug: 'supercharged', status: 'active', role: 'target',
    defaultBranch: 'main', releaseChannel: 'beta', updatePolicy: 'owner_approval', updatesPaused: false,
    manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'unknown', createdAt: T, updatedAt: T, ...p,
  }
}
function mkUpd(key: string, status: string): PlatformUpdate {
  return { recordVersion: 1, key, title: key, summary: '', type: 'feature', scope: 'shared_module', severity: 'low', priority: 'normal', status: status as PlatformUpdate['status'], breakingChange: false, migrationRequired: false, environmentChangeRequired: false, secretRequired: false, featureFlagRequired: false, manualPortRequired: false, rollbackSupported: true, validation: { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'not_applicable', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' }, createdAt: T, updatedAt: T }
}

const READY = mkBiz({ repoName: 'ratchetnu/supercharged', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'supercharged', githubInstallationId: '146887383', previewProjectId: 'prj_x', automationWorkflowFile: 'operion-update.yml', configurationStatus: 'ready' })

test('readiness: fully configured business is github+preview ready and production-protected', () => {
  const r = businessReadiness(READY)
  assert.equal(r.githubReady, true)
  assert.equal(r.previewReady, true)
  assert.equal(r.productionProtected, true)
  assert.deepEqual(r.missing, [])
})

test('readiness: bare seed record reports every missing piece', () => {
  const r = businessReadiness(mkBiz({ repoName: '(separate repo — verify)' }))
  assert.equal(r.githubReady, false)
  assert.equal(r.previewReady, false)
  assert.deepEqual(r.missing, ['Repository (owner/name)', 'GitHub validation', 'Preview project ID', 'Workflow file'])
})

test('readiness: production NOT protected when promotion allowed', () => {
  assert.equal(businessReadiness(mkBiz({ allowProductionPromotion: true })).productionProtected, false)
})

test('nextStep walks connect → configure → prepare → done', () => {
  assert.equal(businessNextStep(mkBiz(), 0).key, 'connect')
  assert.equal(businessNextStep(mkBiz({ repoName: 'ratchetnu/supercharged', githubInstallationId: '1' }), 0).key, 'configure')
  assert.equal(businessNextStep(READY, 3).key, 'prepare')
  assert.match(businessNextStep(READY, 3).title, /3 pending updates/)
  assert.equal(businessNextStep(READY, 1).title, 'Prepare a Preview for 1 pending update')
  assert.equal(businessNextStep(READY, 0).key, 'done')
})

test('updateBucket separates deployed from pending', () => {
  assert.equal(updateBucket('approved'), 'Ready for Preview')
  assert.equal(updateBucket('ready_to_release'), 'Ready for Preview')
  assert.equal(updateBucket('blocked'), 'Needs Review')
  assert.equal(updateBucket('failed'), 'Needs Review')
  assert.equal(updateBucket('fully_deployed'), 'Already Deployed')
  assert.equal(updateBucket('partially_deployed'), 'Already Deployed')
  assert.equal(updateBucket('in_progress'), 'Queued')
})

test('groupUpdates buckets by status and BUCKET_ORDER lists deployed last', () => {
  const g = groupUpdates([mkUpd('UPD-1', 'approved'), mkUpd('UPD-2', 'blocked'), mkUpd('UPD-3', 'fully_deployed'), mkUpd('UPD-4', 'in_progress')])
  assert.equal(g['Ready for Preview'].length, 1)
  assert.equal(g['Needs Review'].length, 1)
  assert.equal(g.Queued.length, 1)
  assert.equal(g['Already Deployed'].length, 1)
  assert.equal(BUCKET_ORDER[BUCKET_ORDER.length - 1], 'Already Deployed')
})
