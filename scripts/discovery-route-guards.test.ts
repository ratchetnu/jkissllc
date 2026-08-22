// ── The discovery ROUTE, exercised as a route ───────────────────────────────
//
// The shipped suite proved the pure validators and one 401/400 pair. These drive the
// real handler against a store, because several guards live in the ROUTE rather than
// in the validators — the source-business lookup, the branch revalidation, the replay
// guard, and the generic refusal. A unit test of `discoveryMatchesSourceBusiness`
// cannot notice that the route stopped calling it.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.OPERION_DISCOVERY_SECRET = 'discovery-secret-value'
process.env.OPERION_CALLBACK_SECRET = 'callback-secret-shared-with-every-target'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
/** Every command the handler issues, so "nothing before auth" is provable. */
const commands: string[] = []

globalThis.fetch = (async (url: string, init: { body?: string } = {}) => {
  if (url !== UPSTASH) return { ok: false, status: 599, json: async () => ({}) }
  const parts = JSON.parse(init.body as string) as string[]
  const cmd = parts[0].toUpperCase()
  commands.push(cmd)
  const key = parts[1]
  let result: unknown = null
  switch (cmd) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, parts[2]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'EXISTS': result = kv.has(key) ? 1 : 0; break
    case 'INCR': { const v = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(v)); result = v; break }
    case 'ZADD': z(key).set(parts[3], Number(parts[2])); result = 1; break
    case 'ZRANGE': case 'ZREVRANGE': {
      const v = [...z(key)].sort((a, b) => a[1] - b[1]).map(([m]) => m)
      if (cmd === 'ZREVRANGE') v.reverse()
      result = v.slice(Number(parts[2]), Number(parts[3]) === -1 ? undefined : Number(parts[3]) + 1)
      break
    }
    case 'EVAL': {
      // Faithful to the shipped script (pinned byte-for-byte in kv-emulator-lua.test.ts).
      const n = Number(parts[2])
      const keys = parts.slice(3, 3 + n)
      const args = parts.slice(3 + n)
      const [marker, indexKey, counterKey] = keys
      const [encoded, score, prefix, placeholder] = args
      const existing = kv.get(marker)
      if (existing !== undefined) { result = `E:${existing}`; break }
      const seq = Number(kv.get(counterKey) ?? 0) + 1
      kv.set(counterKey, String(seq))
      const upd = `UPD-${1000 + seq}`
      const recordKey = prefix + upd
      if (kv.has(recordKey)) { result = '__UPDATE_KEY_COLLISION__'; break }
      kv.set(recordKey, encoded.replace(placeholder, () => upd))
      z(indexKey).set(upd, Number(score))
      kv.set(marker, upd)
      result = `C:${upd}`
      break
    }
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { signCallback } from '../app/lib/platform/automation/callback'
import { POST } from '../app/api/automation/discover/route'
import { saveBusiness, listUpdates } from '../app/lib/platform/updates/store'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

const SECRET = 'discovery-secret-value'
const SHA = '12e9a3556d709ed415aea1228ad1b6d31e31e8f6'

const body = (patch: Record<string, unknown> = {}) => JSON.stringify({
  deliveryId: 'push:1:1', repository: 'ratchetnu/jkissllc', ref: 'refs/heads/main',
  before: 'b'.repeat(40), after: SHA, title: 'feat: x', commitMessage: 'feat: x',
  changedFiles: ['app/lib/x.ts'], changedFileCount: 1, filesTruncated: false,
  pullRequestNumber: 210, pullRequestUrl: 'https://github.com/ratchetnu/jkissllc/pull/210',
  workflowRunId: '1', ...patch,
})
const post = (raw: string, o: { ts?: string; sig?: string; secret?: string } = {}) => {
  const ts = o.ts ?? String(Date.now())
  return POST(new NextRequest('http://localhost/api/automation/discover', {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-operion-timestamp': ts, 'x-operion-signature': o.sig ?? signCallback(raw, ts, o.secret ?? SECRET) },
  }))
}

const business = (id: string, role: 'source' | 'target', repoName: string): PlatformBusiness => ({
  recordVersion: 1, id, slug: id, name: id, status: 'active', role,
  repoName, defaultBranch: 'main', releaseChannel: 'stable', updatePolicy: 'owner_approval',
  updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false,
  healthStatus: 'unknown', createdAt: 0, updatedAt: 0,
})

test('setup: register a source and a target business', async () => {
  await saveBusiness(business('jkiss', 'source', 'ratchetnu/jkissllc'))
  await saveBusiness(business('supercharged', 'target', 'ratchetnu/supercharged'))
})

// ── GAP 5: branch revalidation lives in the ROUTE ───────────────────────────

test('GAP 5: a non-default branch on the RIGHT repository is refused by the route', async () => {
  // The payload validator accepts any well-formed `refs/heads/*`; only the route
  // compares it against the registered business's default branch. Removing that call
  // is invisible to a unit test of the matcher.
  for (const ref of ['refs/heads/develop', 'refs/heads/feature/x', 'refs/heads/mainx', 'refs/heads/release']) {
    const res = await post(body({ ref }))
    assert.equal(res.status, 409, `ref ${ref} was not refused by the route`)
    assert.match((await res.json()).error, /only the registered source branch/)
  }
  assert.equal((await listUpdates()).length, 0, 'and nothing was created')
})

test('GAP 5b: a TARGET repository can never create a source update', async () => {
  const res = await post(body({ repository: 'ratchetnu/supercharged', pullRequestUrl: 'https://github.com/ratchetnu/supercharged/pull/210' }))
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /not a registered Operion source/)
})

test('GAP 5c: an unregistered repository is refused', async () => {
  const res = await post(body({ repository: 'attacker/jkissllc', pullRequestUrl: 'https://github.com/attacker/jkissllc/pull/210' }))
  assert.equal(res.status, 409)
})

// ── Security hardening ──────────────────────────────────────────────────────

test('the 401 body reveals NOTHING about how the refusal was reached', async () => {
  const bad = await post(body(), { secret: 'attacker' })
  assert.equal(bad.status, 401)
  assert.deepEqual(await bad.json(), { error: 'unauthorized' }, 'no reason, no hint')

  const prior = process.env.OPERION_DISCOVERY_SECRET
  delete process.env.OPERION_DISCOVERY_SECRET
  try {
    const unconfigured = await post(body())
    assert.equal(unconfigured.status, 401)
    // The critical property: an unconfigured deployment is INDISTINGUISHABLE from a
    // bad signature. Otherwise the endpoint answers "is discovery provisioned here?"
    // for anyone who asks.
    assert.deepEqual(await unconfigured.json(), { error: 'unauthorized' })
  } finally { process.env.OPERION_DISCOVERY_SECRET = prior }
})

test('the target-shared callback secret is still rejected', async () => {
  const res = await post(body(), { secret: process.env.OPERION_CALLBACK_SECRET! })
  assert.equal(res.status, 401)
})

test('no store command is issued before authentication succeeds', async () => {
  commands.length = 0
  await post(body(), { secret: 'attacker' })
  assert.deepEqual(commands, [])
})

// ── Replay guard ────────────────────────────────────────────────────────────

test('a replayed deliveryId is answered from the guard, without re-entering the handler', async () => {
  const first = await post(body({ deliveryId: 'push:replay:1' }))
  assert.equal(first.status, 201)
  const created = await first.json()
  assert.equal(created.created, true)

  commands.length = 0
  const replay = await post(body({ deliveryId: 'push:replay:1' }))
  assert.equal(replay.status, 200)
  const j = await replay.json()
  assert.equal(j.replayed, true)
  assert.equal(j.created, false)
  assert.equal(j.update.key, created.update.key, 'answered with the same body it is replaying')
  assert.ok(!commands.includes('EVAL'), 'the write path was never re-entered')
})

test('a DIFFERENT deliveryId for the same commit still dedupes on the artifact', async () => {
  // The replay guard is defence in depth; repository+commit remains authoritative.
  const before = (await listUpdates()).length
  const res = await post(body({ deliveryId: 'push:different:9' }))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).deduped, true)
  assert.equal((await listUpdates()).length, before, 'no second record')
})

test('a delivery REFUSED before the write stays retryable', async () => {
  const id = 'push:retryable:1'
  const refused = await post(body({ deliveryId: id, ref: 'refs/heads/develop' }))
  assert.equal(refused.status, 409)
  const accepted = await post(body({ deliveryId: id, after: 'd'.repeat(40) }))
  assert.equal(accepted.status, 201, 'the same delivery id proceeded once the payload was right')
})

test('a delivery that FAILS INSIDE the write stays retryable', async () => {
  // The stricter half of the same rule, and the one a "mark it seen up front"
  // refactor breaks: the guard must be written only after the store has actually
  // committed. If it is written first, a transient store failure permanently
  // consumes the delivery id, and the workflow's retry is answered "already handled"
  // for an update that was never created.
  const id = 'push:store-failed:1'
  const commit = 'e'.repeat(40)
  // Occupy the key the counter is about to hand out, so the write refuses.
  const nextKey = `UPD-${1001 + Number(kv.get('platform:update:counter') ?? 0)}`
  kv.set(`platform:update:${nextKey}`, JSON.stringify({ key: nextKey, title: 'HUMAN' }))
  await assert.rejects(() => post(body({ deliveryId: id, after: commit })), /UPDATE_KEY_COLLISION/)

  kv.delete(`platform:update:${nextKey}`)
  const retry = await post(body({ deliveryId: id, after: commit }))
  assert.equal(retry.status, 201, 'the retry was refused as a replay of a delivery that never landed')
  assert.equal((await retry.json()).created, true)
})

// ── The parked-record invariant ─────────────────────────────────────────────

test('every created record is parked, unapproved and unvalidated', async () => {
  const rec = (await listUpdates()).find(u => u.sourceCommit === SHA)!
  assert.equal(rec.status, 'discovered')
  assert.equal(rec.createdBy, 'github-actions')
  assert.equal(rec.approvedBy, undefined)
  assert.equal(rec.approvedAt, undefined)
  for (const v of Object.values(rec.validation)) assert.equal(v, 'unknown')
  const { APPROVED_STATUSES } = await import('../app/lib/platform/automation/preflight')
  assert.ok(!APPROVED_STATUSES.includes(rec.status))
})

test('discovery writes ONLY its own key families', async () => {
  const unexpected = [...kv.keys()].filter(k =>
    !k.startsWith('platform:update:') && !k.startsWith('platform:update-discovery:') &&
    !k.startsWith('platform:update-delivery:') && !k.startsWith('platform:business') && !k.startsWith('platform:audit'))
  assert.deepEqual(unexpected, [], `unexpected keys: ${unexpected.join(', ')}`)
  for (const k of kv.keys()) {
    for (const forbidden of ['settings:capabilities', 'autojob', 'platform:release', 'compat', 'deploy', 'approval', 'publish']) {
      assert.ok(!k.includes(forbidden), `discovery wrote ${k}`)
    }
  }
})
