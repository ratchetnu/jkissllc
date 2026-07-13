// Migration utility (pure logic) against an in-memory KV: dry-run is a no-op,
// migrate is idempotent, conflicts are surfaced, rollback manifests are complete.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type KvClient, classifyKeys, copyKeys, verifyKeys, rollbackManifest, inventory, checksum,
} from '../scripts/tenant-migration/lib'

function memoryKv(seed: Record<string, string> = {}): KvClient & { dump: () => Record<string, string> } {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    async scan(cursor, match) {
      // single-page scan; supports trailing-'*' prefix match
      const prefix = match.endsWith('*') ? match.slice(0, -1) : match
      const keys = [...m.keys()].filter((k) => (match === '*' ? true : k.startsWith(prefix)))
      return { cursor: '0', keys: cursor === '0' ? keys : [] }
    },
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v) },
    exists: async (k) => m.has(k),
    del: async (k) => { m.delete(k) },
    dump: () => Object.fromEntries(m),
  }
}

const SEED = { 'bk:1': 'B1', 'bk:2': 'B2', 'staff:index': 'S', 'ai:cost:jkiss:x': 'AI', 'opspilot:waitlist:e': 'W', 't:jkiss:rt:9': 'R' }

test('inventory + classify split global / scoped / tenant-owned', async () => {
  const kv = memoryKv(SEED)
  const keys = await inventory(kv)
  const cls = classifyKeys(keys)
  assert.deepEqual(cls.tenantOwned.sort(), ['bk:1', 'bk:2', 'staff:index'])
  assert.deepEqual(cls.platformGlobal.sort(), ['ai:cost:jkiss:x', 'opspilot:waitlist:e'])
  assert.deepEqual(cls.alreadyScoped, ['t:jkiss:rt:9'])
})

test('dry-run makes NO changes', async () => {
  const kv = memoryKv(SEED)
  const before = JSON.stringify(kv.dump())
  const r = await copyKeys(kv, await inventory(kv), 'jkiss', { dryRun: true })
  assert.equal(JSON.stringify(kv.dump()), before, 'store must be untouched in dry-run')
  assert.equal(r.copied, 3, 'reports would-copy for the 3 tenant-owned keys')
})

test('migrate copies tenant-owned keys and verifies', async () => {
  const kv = memoryKv(SEED)
  const keys = await inventory(kv)
  const r = await copyKeys(kv, keys, 'jkiss', { dryRun: false })
  assert.equal(r.copied, 3)
  assert.equal(kv.dump()['t:jkiss:bk:1'], 'B1')
  assert.equal(kv.dump()['t:jkiss:staff:index'], 'S')
  assert.equal(kv.dump()['bk:1'], 'B1', 'legacy key is NOT deleted')
  const v = await verifyKeys(kv, keys, 'jkiss')
  assert.equal(v.ok, 3)
  assert.deepEqual(v.missing, [])
})

test('migrate is idempotent (second run copies nothing new)', async () => {
  const kv = memoryKv(SEED)
  const keys = await inventory(kv)
  await copyKeys(kv, keys, 'jkiss', { dryRun: false })
  const r2 = await copyKeys(kv, await inventory(kv), 'jkiss', { dryRun: false })
  assert.equal(r2.copied, 0)
  assert.equal(r2.skippedExisting, 3)
  assert.equal(r2.conflicts.length, 0)
})

test('a differing existing target is a CONFLICT, never overwritten', async () => {
  const kv = memoryKv({ 'bk:1': 'NEW', 't:jkiss:bk:1': 'OLD-DIFFERENT' })
  const r = await copyKeys(kv, await inventory(kv), 'jkiss', { dryRun: false })
  assert.equal(r.conflicts.length, 1)
  assert.equal(kv.dump()['t:jkiss:bk:1'], 'OLD-DIFFERENT', 'conflict target is preserved')
})

test('rollback manifest lists every scoped target (legacy untouched)', async () => {
  const kv = memoryKv(SEED)
  const keys = await inventory(kv)
  const r = await copyKeys(kv, keys, 'jkiss', { dryRun: false })
  const manifest = rollbackManifest(r.pairs)
  assert.deepEqual(manifest.deleteTargets.sort(), ['t:jkiss:bk:1', 't:jkiss:bk:2', 't:jkiss:staff:index'])
  assert.match(manifest.note, /never modified or deleted/i)
})

test('checksum is stable and distinguishes values', () => {
  assert.equal(checksum('x'), checksum('x'))
  assert.notEqual(checksum('x'), checksum('y'))
  assert.equal(checksum(null), 'null')
})
