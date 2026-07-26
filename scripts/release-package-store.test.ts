import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  PlatformBusiness, PlatformUpdate, ReleasePackage, UpdateCompatibility,
} from '../app/lib/platform/updates/types'
import {
  saveApprovedReleasePackage, saveBusiness, saveCompat, saveReleasePackage,
  saveReadyReleasePackage, saveUpdate,
} from '../app/lib/platform/updates/store'

process.env.KV_REST_API_URL = 'http://fake-release-package-store.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const values = new Map<string, string>()
const indexes = new Map<string, Map<string, number>>()
const index = (key: string) => indexes.get(key) ?? indexes.set(key, new Map()).get(key)!

globalThis.fetch = (async (_url: string, init: { body?: string }) => {
  const [rawCommand, ...args] = JSON.parse(init.body as string) as string[]
  const command = rawCommand.toUpperCase()
  let result: unknown = null
  if (command === 'GET') result = values.get(args[0]) ?? null
  else if (command === 'SET') { values.set(args[0], args[1]); result = 'OK' }
  else if (command === 'ZADD') { index(args[0]).set(args[2], Number(args[1])); result = 1 }
  else if (command === 'EVAL') {
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
    } else if (keyCount === 4 && keys[2].startsWith('platform:release-package-version:')) {
      const [packageKey, packageIndex, reservationKey, businessKey] = keys
      const [payload, packageId, expectedPackageAt, expectedBusinessAt, updatedAt, packagePrefix] = argv
      const currentPackage = values.get(packageKey)
      const business = values.get(businessKey)
      if (!currentPackage || Number(JSON.parse(currentPackage).updatedAt) !== Number(expectedPackageAt)) result = -1
      else if (!business || Number(JSON.parse(business).updatedAt) !== Number(expectedBusinessAt)) result = -2
      else {
        const holder = values.get(reservationKey)
        const holderRecord = holder ? values.get(`${packagePrefix}${holder}`) : null
        const holderActive = holderRecord
          ? !['cancelled', 'superseded'].includes(JSON.parse(holderRecord).status)
          : false
        if (holder && holder !== packageId && holderActive) result = -3
        else {
          values.set(reservationKey, packageId)
          values.set(packageKey, payload)
          index(packageIndex).set(packageId, Number(updatedAt))
          result = 1
        }
      }
    } else if (keyCount === 4 && keys[2].startsWith('platform:release:')) {
      const [packageKey, packageIndex, releaseKey, releaseIndex] = keys
      const [releasePayload, updatedAt, releaseId, packagePayload, expectedPackageAt, packageId] = argv
      const currentPackage = values.get(packageKey)
      if (!currentPackage) result = -1
      else if (JSON.parse(currentPackage).rolloutId) result = 2
      else if (Number(JSON.parse(currentPackage).updatedAt) !== Number(expectedPackageAt)) result = -1
      else if (JSON.parse(currentPackage).status !== 'approved') result = -2
      else if (values.has(releaseKey)) result = -3
      else {
        values.set(releaseKey, releasePayload)
        index(releaseIndex).set(releaseId, Number(updatedAt))
        values.set(packageKey, packagePayload)
        index(packageIndex).set(packageId, Number(updatedAt))
        result = 1
      }
    } else {
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
          if (!update || Number(JSON.parse(update).updatedAt) !== Number(evidenceArgs[i * 2])) {
            result = -3
            break
          }
          if (!compatibility || Number(compatibility.updatedAt) !== Number(evidenceArgs[(i * 2) + 1])) {
            result = -4
            break
          }
        }
        if (result === 1) {
          values.set(packageKey, payload)
          index(packageIndex).set(packageId, Number(updatedAt))
        }
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
const packageRecord = (id: string, status: ReleasePackage['status'] = 'draft'): ReleasePackage => ({
  recordVersion: 1, id, targetProduct: business.id, proposedVersion: '1.3.0',
  channel: 'stable', classification: 'capability', breakingChange: false,
  migration: 'none', updateKeys: ['UPD-2001'], status, blockingReasons: [],
  createdBy: 'owner', createdAt: now, updatedAt: now,
})
const update: PlatformUpdate = {
  recordVersion: 1, key: 'UPD-2001', title: 'Crew workflow', summary: 'Crew workflow',
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
const evidence = [{
  updateKey: update.key,
  updateUpdatedAt: update.updatedAt,
  compatibilityUpdatedAt: compatibility.updatedAt,
}]

test('atomic ready write allows one concurrent winner for a product/channel/version', async () => {
  values.clear(); indexes.clear()
  await saveBusiness(business)
  const first = packageRecord('RPK-2001')
  const second = packageRecord('RPK-2002')
  await saveReleasePackage(first)
  await saveReleasePackage(second)

  const results = await Promise.all([
    saveReadyReleasePackage({ ...first, status: 'ready_for_approval', updatedAt: now + 1 }, now, business.updatedAt),
    saveReadyReleasePackage({ ...second, status: 'ready_for_approval', updatedAt: now + 1 }, now, business.updatedAt),
  ])

  assert.deepEqual(results.sort(), ['duplicate', 'saved'])
})

test('a cancelled package releases its version reservation for a later package', async () => {
  values.clear(); indexes.clear()
  await saveBusiness(business)
  const first = packageRecord('RPK-2101')
  await saveReleasePackage(first)
  assert.equal(
    await saveReadyReleasePackage({ ...first, status: 'ready_for_approval', updatedAt: now + 1 }, now, business.updatedAt),
    'saved',
  )
  await saveReleasePackage({ ...first, status: 'cancelled', updatedAt: now + 2 })

  const replacement = packageRecord('RPK-2102')
  await saveReleasePackage(replacement)
  assert.equal(
    await saveReadyReleasePackage({ ...replacement, status: 'ready_for_approval', updatedAt: now + 1 }, now, business.updatedAt),
    'saved',
  )
})

test('approval seals a ready package only while all evaluated evidence is unchanged', async () => {
  values.clear(); indexes.clear()
  await saveBusiness(business)
  await saveUpdate(update)
  await saveCompat(compatibility)
  const record = packageRecord('RPK-2201', 'ready_for_approval')
  await saveReleasePackage(record)

  assert.equal(
    await saveApprovedReleasePackage(
      { ...record, status: 'approved', approvedBy: 'owner', approvedAt: now + 1, updatedAt: now + 1 },
      record.updatedAt,
      business.updatedAt,
      evidence,
    ),
    'saved',
  )
  assert.equal(JSON.parse(values.get(`platform:release-package:${record.id}`)!).status, 'approved')
})

test('approval fails closed on package status and update or compatibility drift', async () => {
  values.clear(); indexes.clear()
  await saveBusiness(business)
  await saveUpdate(update)
  await saveCompat(compatibility)

  const draftRecord = packageRecord('RPK-2301', 'draft')
  await saveReleasePackage(draftRecord)
  assert.equal(
    await saveApprovedReleasePackage(
      { ...draftRecord, status: 'approved', updatedAt: now + 1 },
      draftRecord.updatedAt,
      business.updatedAt,
      evidence,
    ),
    'invalid_status',
  )

  const readyRecord = packageRecord('RPK-2302', 'ready_for_approval')
  await saveReleasePackage(readyRecord)
  assert.equal(
    await saveApprovedReleasePackage(
      { ...readyRecord, status: 'approved', updatedAt: now + 1 },
      readyRecord.updatedAt,
      business.updatedAt,
      [{ ...evidence[0], updateUpdatedAt: update.updatedAt - 1 }],
    ),
    'stale_update',
  )
  assert.equal(
    await saveApprovedReleasePackage(
      { ...readyRecord, status: 'approved', updatedAt: now + 1 },
      readyRecord.updatedAt,
      business.updatedAt,
      [{ ...evidence[0], compatibilityUpdatedAt: compatibility.updatedAt - 1 }],
    ),
    'stale_compatibility',
  )
  assert.equal(JSON.parse(values.get(`platform:release-package:${readyRecord.id}`)!).status, 'ready_for_approval')
})

test('approved package creates one linked product-safe rollout and preserves other products using the same version', async () => {
  values.clear(); indexes.clear()
  const { saveRolloutForApprovedPackage } = await import('../app/lib/platform/updates/store')
  const firstPackage = {
    ...packageRecord('RPK-2401', 'approved'),
    approvalSnapshot: {
      previousVersion: '1.2.0', baselineSource: 'adopted' as const,
      businessUpdatedAt: now, versionReason: 'minor', duplicateReason: 'available', evaluatedAt: now,
    },
    approvedBy: 'owner', approvedAt: now,
  }
  await saveReleasePackage(firstPackage)
  const firstRelease = {
    recordVersion: 1, id: 'REL-2401', packageId: firstPackage.id,
    targetProduct: 'supercharged', version: '1.3.0', channel: 'stable' as const,
    status: 'approved' as const, updateKeys: firstPackage.updateKeys,
    targetBusinessIds: ['supercharged'], createdAt: now + 1, updatedAt: now + 1,
  }
  const linked = { ...firstPackage, rolloutId: firstRelease.id, rolloutCreatedAt: now + 1, updatedAt: now + 1 }
  assert.equal(await saveRolloutForApprovedPackage(firstRelease, linked, now), 'saved')
  assert.equal(await saveRolloutForApprovedPackage(firstRelease, linked, now), 'already_created')

  const secondPackage = { ...firstPackage, id: 'RPK-2402', targetProduct: 'jkiss' }
  await saveReleasePackage(secondPackage)
  const secondRelease = {
    ...firstRelease, id: 'REL-2402', packageId: secondPackage.id,
    targetProduct: 'jkiss', targetBusinessIds: ['jkiss'],
  }
  assert.equal(
    await saveRolloutForApprovedPackage(
      secondRelease,
      { ...secondPackage, rolloutId: secondRelease.id, rolloutCreatedAt: now + 1, updatedAt: now + 1 },
      now,
    ),
    'saved',
  )
  assert.equal(JSON.parse(values.get('platform:release:REL-2401')!).targetProduct, 'supercharged')
  assert.equal(JSON.parse(values.get('platform:release:REL-2402')!).targetProduct, 'jkiss')
})

test('an approved package cannot be overwritten through the generic package writer', async () => {
  values.clear(); indexes.clear()
  const approved = packageRecord('RPK-2501', 'approved')
  await saveReleasePackage(approved)
  await assert.rejects(
    saveReleasePackage({ ...approved, status: 'cancelled', updatedAt: now + 1 }),
    /APPROVED_RELEASE_PACKAGE_IMMUTABLE/,
  )
  assert.equal(JSON.parse(values.get(`platform:release-package:${approved.id}`)!).status, 'approved')
})
