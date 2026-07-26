import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import type {
  PlatformBusiness, PlatformUpdate, ReleasePackage, UpdateCompatibility,
} from '../app/lib/platform/updates/types'
import type { UpdateAutomationJob } from '../app/lib/platform/automation/types'

process.env.KV_REST_API_URL = 'http://fake-release-package-approval.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.ADMIN_SESSION_SECRET = 'release-package-approval-test-secret'
process.env.TENANCY_ENABLED = 'false'

const values = new Map<string, string>()
const indexes = new Map<string, Map<string, number>>()
const counters = new Map<string, number>()
const index = (key: string) => indexes.get(key) ?? indexes.set(key, new Map()).get(key)!

globalThis.fetch = (async (_url: string, init: { body?: string }) => {
  const [rawCommand, ...args] = JSON.parse(init.body as string) as string[]
  const command = rawCommand.toUpperCase()
  let result: unknown = null
  if (command === 'GET') result = values.get(args[0]) ?? null
  else if (command === 'SET') { values.set(args[0], args[1]); result = 'OK' }
  else if (command === 'INCR') {
    const next = (counters.get(args[0]) ?? 0) + 1
    counters.set(args[0], next)
    result = next
  } else if (command === 'ZADD') {
    index(args[0]).set(args[2], Number(args[1]))
    result = 1
  } else if (command === 'ZCARD') result = index(args[0]).size
  else if (command === 'ZRANGE' || command === 'ZREVRANGE') {
    const entries = [...index(args[0]).entries()].sort((a, b) =>
      command === 'ZREVRANGE' ? b[1] - a[1] : a[1] - b[1])
    const start = Number(args[1])
    const stop = Number(args[2])
    result = entries.slice(start, stop + 1).map(([member]) => member)
  } else if (command === 'EVAL') {
    const keyCount = Number(args[1])
    const keys = args.slice(2, 2 + keyCount)
    const argv = args.slice(2 + keyCount)
    if (keyCount === 2) {
      const [packageKey, packageIndex] = keys
      const [payload, updatedAt, packageId] = argv
      const current = values.get(packageKey)
      if (current && (JSON.parse(current).status === 'approved' || JSON.parse(current).rolloutId)) result = -1
      else {
        values.set(packageKey, payload)
        index(packageIndex).set(packageId, Number(updatedAt))
        result = 1
      }
      return { ok: true, status: 200, json: async () => ({ result }) }
    }
    if (keyCount === 4 && keys[2].startsWith('platform:release:')) {
      const [packageKey, packageIndex, releaseKey, releaseIndex] = keys
      const [releasePayload, updatedAt, releaseId, packagePayload, expectedPackageAt, packageId] = argv
      const current = values.get(packageKey)
      if (!current) result = -1
      else if (JSON.parse(current).rolloutId) result = 2
      else if (Number(JSON.parse(current).updatedAt) !== Number(expectedPackageAt)) result = -1
      else if (JSON.parse(current).status !== 'approved') result = -2
      else if (values.has(releaseKey)) result = -3
      else {
        values.set(releaseKey, releasePayload)
        index(releaseIndex).set(releaseId, Number(updatedAt))
        values.set(packageKey, packagePayload)
        index(packageIndex).set(packageId, Number(updatedAt))
        result = 1
      }
      return { ok: true, status: 200, json: async () => ({ result }) }
    }
    const [packageKey, packageIndex, businessKey, ...evidenceKeys] = keys
    const [
      payload, packageId, expectedPackageAt, expectedBusinessAt, updatedAt,
      businessId, rawCount, ...evidenceArgs
    ] = argv
    const currentPackage = values.get(packageKey)
    const business = values.get(businessKey)
    if (!currentPackage || Number(JSON.parse(currentPackage).updatedAt) !== Number(expectedPackageAt)) result = -1
    else if (JSON.parse(currentPackage).status !== 'ready_for_approval') result = -5
    else if (!business || Number(JSON.parse(business).updatedAt) !== Number(expectedBusinessAt)) result = -2
    else {
      result = 1
      for (let i = 0; i < Number(rawCount); i += 1) {
        const update = values.get(evidenceKeys[i * 2])
        const compatMap = values.get(evidenceKeys[(i * 2) + 1])
        const compatibility = compatMap ? JSON.parse(compatMap)[businessId] : null
        if (!update || Number(JSON.parse(update).updatedAt) !== Number(evidenceArgs[i * 2])) result = -3
        else if (!compatibility || Number(compatibility.updatedAt) !== Number(evidenceArgs[(i * 2) + 1])) result = -4
        if (result !== 1) break
      }
      if (result === 1) {
        values.set(packageKey, payload)
        index(packageIndex).set(packageId, Number(updatedAt))
      }
    }
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

const now = 1_800_000_000_000
const business: PlatformBusiness = {
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', slug: 'supercharged',
  role: 'target', status: 'active', defaultBranch: 'main', releaseChannel: 'stable',
  updatePolicy: 'owner_approval', updatesPaused: false, manualApprovalRequired: true,
  autoDeployAllowed: false, healthStatus: 'healthy', currentVersion: '1.2.0',
  baselineSource: 'adopted', createdAt: now - 1000, updatedAt: now,
}
const update: PlatformUpdate = {
  recordVersion: 1, key: 'UPD-3001', title: 'Route board', summary: 'Route board',
  type: 'feature', scope: 'platform_core', severity: 'medium', priority: 'normal',
  status: 'approved', breakingChange: false, migrationRequired: false,
  environmentChangeRequired: false, secretRequired: false, featureFlagRequired: false,
  manualPortRequired: false, rollbackSupported: true,
  validation: {
    typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed',
    securityReview: 'passed', accessibilityReview: 'passed', e2e: 'passed',
    smokeTest: 'passed', ownerVerification: 'passed',
  },
  createdAt: now - 1000, updatedAt: now,
}
const compatibility: UpdateCompatibility = {
  recordVersion: 1, updateKey: update.key, businessId: business.id,
  status: 'compatible', createdAt: now - 1000, updatedAt: now,
}
const packageRecord: ReleasePackage = {
  recordVersion: 1, id: 'RPK-3001', targetProduct: business.id,
  proposedVersion: '1.3.0', channel: 'stable', classification: 'capability',
  breakingChange: false, migration: 'none', updateKeys: [update.key],
  status: 'ready_for_approval', blockingReasons: [],
  policySnapshot: {
    previousVersion: '1.2.0', baselineSource: 'adopted',
    businessUpdatedAt: now, versionReason: 'valid minor release',
    duplicateReason: 'version available', evaluatedAt: now,
  },
  createdBy: 'owner', createdAt: now, updatedAt: now, readyBy: 'owner', readyAt: now,
}

const request = (token: string | undefined, phrase: string, action = 'approve') => {
  const req = new NextRequest('http://localhost/api/admin/platform/releases/RPK-3001', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, phrase }),
  })
  if (token) req.cookies.set('jk_admin_session', token)
  return req
}

const readRequest = (token: string | undefined) => {
  const req = new NextRequest('http://localhost/api/admin/platform/releases/RPK-3001')
  if (token) req.cookies.set('jk_admin_session', token)
  return req
}

test('owner approval is confirmed, revalidated, persisted once, and never starts a rollout', async () => {
  const {
    saveBusiness, saveCompat, saveReleasePackage, saveUpdate,
  } = await import('../app/lib/platform/updates/store')
  const { createSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET, PATCH } = await import('../app/api/admin/platform/releases/[id]/route')
  const { saveJob } = await import('../app/lib/platform/automation/store')
  await saveBusiness(business)
  await saveUpdate(update)
  await saveCompat(compatibility)
  await saveReleasePackage(packageRecord)

  const params = { params: Promise.resolve({ id: packageRecord.id }) }
  assert.equal((await PATCH(request(undefined, 'APPROVE RPK-3001 1.3.0'), params)).status, 401)
  assert.equal((await PATCH(request(undefined, '', 'create-rollout'), params)).status, 401)

  const token = await createSessionToken()
  assert.equal((await PATCH(request(token, '', 'create-rollout'), params)).status, 409)
  const wrong = await PATCH(request(token, 'APPROVE SOMETHING ELSE'), params)
  assert.equal(wrong.status, 400)
  assert.equal(JSON.parse(values.get(`platform:release-package:${packageRecord.id}`)!).status, 'ready_for_approval')

  await saveReleasePackage({ ...packageRecord, policySnapshot: undefined, readyAt: undefined })
  const missingEvidence = await PATCH(request(token, 'APPROVE RPK-3001 1.3.0'), params)
  assert.equal(missingEvidence.status, 409)
  assert.match((await missingEvidence.json()).error, /no readiness evidence/)
  await saveReleasePackage(packageRecord)

  const approved = await PATCH(request(token, 'APPROVE RPK-3001 1.3.0'), params)
  assert.equal(approved.status, 200)
  const approvedBody = await approved.json()
  assert.equal(approvedBody.idempotent, false)
  assert.equal(approvedBody.package.status, 'approved')
  assert.equal(approvedBody.package.approvedBy, 'owner')
  assert.equal(typeof approvedBody.package.approvedAt, 'number')
  assert.equal(approvedBody.package.approvalSnapshot.previousVersion, '1.2.0')

  const auditCount = counters.get('platform:audit:counter')
  const repeated = await PATCH(request(token, 'APPROVE RPK-3001 1.3.0'), params)
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json()).idempotent, true)
  assert.equal(counters.get('platform:audit:counter'), auditCount, 'idempotent replay writes no duplicate audit event')

  assert.equal([...values.keys()].some((key) => key.startsWith('platform:release:')), false)
  assert.equal([...values.keys()].some((key) => key.includes('deployment')), false)

  const rolloutResponse = await PATCH(request(token, '', 'create-rollout'), params)
  assert.equal(rolloutResponse.status, 201)
  const rolloutBody = await rolloutResponse.json()
  assert.equal(rolloutBody.idempotent, false)
  assert.match(rolloutBody.rollout.id, /^REL-/)
  assert.equal(rolloutBody.rollout.packageId, packageRecord.id)
  assert.equal(rolloutBody.rollout.targetProduct, business.id)
  assert.deepEqual(rolloutBody.rollout.targetBusinessIds, [business.id])
  assert.equal(rolloutBody.rollout.status, 'approved')
  assert.equal(rolloutBody.package.rolloutId, rolloutBody.rollout.id)
  assert.equal([...values.keys()].some((key) => key.includes('deployment')), false)

  const rolloutAuditCount = counters.get('platform:audit:counter')
  const repeatedRollout = await PATCH(request(token, '', 'create-rollout'), params)
  assert.equal(repeatedRollout.status, 200)
  assert.equal((await repeatedRollout.json()).idempotent, true)
  assert.equal(counters.get('platform:audit:counter'), rolloutAuditCount)

  assert.equal((await GET(readRequest(undefined), params)).status, 401)
  const blockedReadiness = await GET(readRequest(token), params)
  assert.equal(blockedReadiness.status, 200)
  const blockedBody = await blockedReadiness.json()
  assert.equal(blockedBody.executionReadiness.ready, false)
  assert.deepEqual(
    blockedBody.executionReadiness.blockers.map((blocker: { code: string }) => blocker.code),
    ['UPDATE_CANDIDATE_MISSING'],
  )

  const candidate: UpdateAutomationJob = {
    jobVersion: 1,
    id: 'AUTO-3001',
    businessId: business.id,
    updateId: update.key,
    mode: 'live',
    status: 'awaiting_owner_review',
    strategy: 'commit_transfer',
    attemptCount: 1,
    currentStep: 'owner_review',
    idempotencyKey: 'RPK-3001-readiness',
    targetCommit: 'abc1234',
    previewDeploymentId: 'dpl_preview_3001',
    createdAt: now,
    updatedAt: now,
  }
  await saveJob(candidate)
  const readyReadiness = await GET(readRequest(token), params)
  assert.equal(readyReadiness.status, 200)
  const readyBody = await readyReadiness.json()
  assert.equal(readyBody.executionReadiness.ready, true)
  assert.equal(readyBody.executionReadiness.candidate.targetCommit, candidate.targetCommit)
  assert.equal(readyBody.executionReadiness.candidate.sourceDeploymentId, candidate.previewDeploymentId)
  assert.deepEqual(readyBody.executionHandoff, {
    ready: true,
    blocker: null,
    businessId: business.id,
    jobId: candidate.id,
    releaseId: candidate.targetCommit,
    sourceDeploymentId: candidate.previewDeploymentId,
  })

  await saveJob({
    ...candidate,
    id: 'AUTO-OTHER-ACTIVE',
    updateId: 'UPD-OTHER',
    idempotencyKey: 'other-active-job',
    targetCommit: 'different',
    previewDeploymentId: 'dpl_other',
    updatedAt: now + 1,
  })
  const mismatchedHandoff = await GET(readRequest(token), params)
  assert.equal(mismatchedHandoff.status, 200)
  const mismatchedBody = await mismatchedHandoff.json()
  assert.equal(mismatchedBody.executionReadiness.ready, true, 'package evidence remains valid')
  assert.equal(mismatchedBody.executionHandoff.ready, false)
  assert.equal(mismatchedBody.executionHandoff.blocker.code, 'PUBLISH_CONTEXT_MISMATCH')
  assert.equal(readyReadiness.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
  assert.equal(counters.get('platform:audit:counter'), rolloutAuditCount, 'readiness checks write no audit event')
})
