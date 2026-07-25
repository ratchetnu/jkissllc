import test from 'node:test'
import assert from 'node:assert/strict'
import type { PlatformBusiness, ReleasePackage } from '../app/lib/platform/updates/types'
import {
  saveBusiness, saveReleasePackage, saveReadyReleasePackage,
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
