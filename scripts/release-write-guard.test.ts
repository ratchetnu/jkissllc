import test from 'node:test'
import assert from 'node:assert/strict'
import type { PlatformRelease } from '../app/lib/platform/updates/types'
import { getRelease, saveRelease, updateRelease } from '../app/lib/platform/updates/store'

process.env.KV_REST_API_URL = 'http://fake-release-write-guard.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const values = new Map<string, string>()
const indexes = new Map<string, Map<string, number>>()
const index = (key: string) => indexes.get(key) ?? indexes.set(key, new Map()).get(key)!

globalThis.fetch = (async (_url: string, init: { body?: string }) => {
  const [rawCommand, ...args] = JSON.parse(init.body as string) as string[]
  const command = rawCommand.toUpperCase()
  let result: unknown = null
  if (command === 'GET') result = values.get(args[0]) ?? null
  else if (command === 'EVAL') {
    const keyCount = Number(args[1])
    const keys = args.slice(2, 2 + keyCount)
    const argv = args.slice(2 + keyCount)
    const [releaseKey, releaseIndex] = keys
    if (argv.length === 3) {
      const [payload, updatedAt, releaseId] = argv
      if (values.has(releaseKey)) result = -1
      else {
        values.set(releaseKey, payload)
        index(releaseIndex).set(releaseId, Number(updatedAt))
        result = 1
      }
    } else {
      const [expectedPayload, nextPayload, updatedAt, releaseId] = argv
      if (values.get(releaseKey) !== expectedPayload) result = -1
      else {
        values.set(releaseKey, nextPayload)
        index(releaseIndex).set(releaseId, Number(updatedAt))
        result = 1
      }
    }
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

const now = 1_800_000_000_000
const rollout = (id: string, targetProduct: string): PlatformRelease => ({
  recordVersion: 1,
  id,
  packageId: `RPK-${id.slice(4)}`,
  targetProduct,
  version: '1.3.0',
  channel: 'stable',
  status: 'approved',
  updateKeys: ['UPD-3001'],
  targetBusinessIds: [targetProduct],
  createdBy: 'owner',
  approvedBy: 'owner',
  createdAt: now,
  updatedAt: now,
  approvedAt: now,
})

test('saveRelease is create-only and cannot overwrite an existing rollout', async () => {
  values.clear(); indexes.clear()
  const record = rollout('REL-1001', 'supercharged')
  await saveRelease(record)
  await assert.rejects(
    saveRelease({ ...record, status: 'completed', updatedAt: now + 1 }),
    /RELEASE_ALREADY_EXISTS/,
  )
  assert.deepEqual(await getRelease(record.id!), record)
})

test('guarded update permits status progression and rejects stale concurrent writes', async () => {
  values.clear(); indexes.clear()
  const record = rollout('REL-1002', 'supercharged')
  await saveRelease(record)
  const completed = { ...record, status: 'completed' as const, updatedAt: now + 1 }
  assert.equal(await updateRelease(record, completed), 'saved')

  assert.equal(
    await updateRelease(record, { ...record, status: 'failed', updatedAt: now + 2 }),
    'stale_release',
  )
  assert.deepEqual(await getRelease(record.id!), completed)
})

test('guarded update rejects changes to rollout identity or authored contents', async () => {
  values.clear(); indexes.clear()
  const record = rollout('REL-1003', 'supercharged')
  await saveRelease(record)
  assert.equal(
    await updateRelease(record, { ...record, targetProduct: 'jkiss', targetBusinessIds: ['jkiss'], updatedAt: now + 1 }),
    'invalid_change',
  )
  assert.equal(
    await updateRelease(record, { ...record, updateKeys: ['UPD-OTHER'], updatedAt: now + 1 }),
    'invalid_change',
  )
  assert.deepEqual(await getRelease(record.id!), record)
})

test('legacy version-keyed releases retain create and guarded-update compatibility', async () => {
  values.clear(); indexes.clear()
  const legacy: PlatformRelease = {
    recordVersion: 1,
    version: '1.2.0',
    channel: 'stable',
    status: 'approved',
    updateKeys: ['UPD-OLD'],
    targetBusinessIds: ['jkiss', 'supercharged'],
    createdAt: now,
    updatedAt: now,
  }
  await saveRelease(legacy)
  const completed = { ...legacy, status: 'completed' as const, updatedAt: now + 1 }
  assert.equal(await updateRelease(legacy, completed), 'saved')
  assert.deepEqual(await getRelease('1.2.0'), completed)
})

test('separate products at the same version remain independently guarded', async () => {
  values.clear(); indexes.clear()
  const supercharged = rollout('REL-1010', 'supercharged')
  const jkiss = rollout('REL-1011', 'jkiss')
  await saveRelease(supercharged)
  await saveRelease(jkiss)
  assert.equal(
    await updateRelease(supercharged, { ...supercharged, status: 'completed', updatedAt: now + 1 }),
    'saved',
  )
  assert.equal((await getRelease(jkiss.id!))?.status, 'approved')
})
