import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { after, before, beforeEach, test } from 'node:test'

import type { PlatformBusiness } from '../app/lib/platform/updates/types'

const NOW = 1_800_000_000_000
const SECRET = 'local-audit-baseline-secret-at-least-16'
const HASH = `sha256:${'a'.repeat(64)}`

let emulator: ChildProcess
let base = ''

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no test port'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForEmulator(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${base}/__admin/health`)
      if (response.ok) return
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('local-audit emulator did not start')
}

async function command(...args: Array<string | number>): Promise<unknown> {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  const result = await response.json() as { result?: unknown; error?: string }
  if (result.error) throw new Error(result.error)
  return result.result
}

async function dump() {
  const response = await fetch(`${base}/__admin/dump`)
  return response.json() as Promise<{
    strings: Record<string, string>
    zsets: Record<string, Record<string, number>>
  }>
}

const business = (id = 'supercharged', patch: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1,
  id,
  name: id,
  slug: id,
  status: 'active',
  role: 'target',
  defaultBranch: 'main',
  releaseChannel: 'stable',
  updatePolicy: 'owner_approval',
  updatesPaused: false,
  manualApprovalRequired: true,
  autoDeployAllowed: false,
  healthStatus: 'healthy',
  currentCommit: 'abcdef1234567890',
  latestVerifiedCommit: 'abcdef1234567890',
  createdAt: 100,
  updatedAt: 200,
  ...patch,
})

const evidence = () => ({
  proposedVersion: '1.4.0',
  deployedCommit: 'abcdef1234567890',
  capabilityManifestHash: HASH,
  capabilities: [{ id: 'booking', evidence: 'Synthetic local fixture' }],
  schemaMigrationState: { state: 'verified', schemaVersion: '12', evidence: 'Synthetic local fixture' },
  relevantFlagState: { assessed: true, flags: { CREW_PORTAL_ENABLED: true } },
  verificationEvidence: [
    { kind: 'production_deployment', reference: 'synthetic-local-deployment', verifiedAt: NOW - 1000 },
    { kind: 'health_check', reference: 'synthetic-local-health', verifiedAt: NOW - 500 },
  ],
})

before(async () => {
  const port = await unusedPort()
  base = `http://127.0.0.1:${port}`
  process.env.KV_REST_API_URL = base
  process.env.KV_REST_API_TOKEN = 'local-audit-test-token'
  emulator = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await waitForEmulator()
})

beforeEach(async () => {
  await fetch(`${base}/__admin/flush`, { method: 'POST' })
})

after(() => {
  emulator?.kill('SIGTERM')
})

test('three real concurrent adoptions produce exactly one complete atomic winner', async () => {
  const [{ saveBusiness }, { adoptBaseline }, adoption] = await Promise.all([
    import('../app/lib/platform/updates/store'),
    import('../app/lib/platform/release/baseline-adoption-service'),
    import('../app/lib/platform/release/baseline-adoption'),
  ])
  const target = business()
  const untouched = business('jkiss', { updatedAt: 201 })
  await saveBusiness(target)
  await saveBusiness(untouched)
  const dryRun = adoption.dryRunBaselineAdoption({
    business: target,
    evidence: evidence(),
    now: NOW,
    approvalSecret: SECRET,
  })
  assert.equal(dryRun.verdict, 'safe_to_adopt')

  const attempts = await Promise.all(Array.from({ length: 3 }, () => adoptBaseline({
    business: target,
    evidence: evidence(),
    approvalToken: dryRun.approvalToken!,
    confirmationPhrase: adoption.baselineConfirmationPhrase(target.id),
    actor: 'owner:local-audit',
    now: NOW,
    approvalSecret: SECRET,
  })))
  assert.equal(attempts.filter((result) => result.ok).length, 1)
  for (const loser of attempts.filter((result) => !result.ok)) {
    assert.match(loser.ok ? '' : loser.reason, /evidence changed after the dry run/)
  }

  const state = await dump()
  const adoptionEntries = Object.entries(state.strings)
    .filter(([key]) => /^platform:baseline-adoption:BADOPT-/.test(key))
  assert.equal(adoptionEntries.length, 1)
  const [adoptionKey, rawAdoption] = adoptionEntries[0]
  const savedAdoption = JSON.parse(rawAdoption) as { id: string }
  const savedBusiness = JSON.parse(state.strings['platform:business:supercharged']) as PlatformBusiness
  assert.equal(savedBusiness.baselineAdoptionId, savedAdoption.id)
  assert.equal(adoptionKey, `platform:baseline-adoption:${savedAdoption.id}`)
  assert.deepEqual(state.zsets['platform:baseline-adoption:index'], { [savedAdoption.id]: NOW })
  assert.equal(state.zsets['platform:business:index'].supercharged, NOW)
  assert.deepEqual(
    JSON.parse(state.strings['platform:business:jkiss']) as PlatformBusiness,
    untouched,
    'the unrelated platform business remains byte-for-byte unchanged',
  )
})

test('stale, missing, and malformed business evidence fail without partial writes', async () => {
  const [{ saveBusiness }, { adoptBaseline }, adoption] = await Promise.all([
    import('../app/lib/platform/updates/store'),
    import('../app/lib/platform/release/baseline-adoption-service'),
    import('../app/lib/platform/release/baseline-adoption'),
  ])
  const target = business()
  const dryRun = adoption.dryRunBaselineAdoption({
    business: target,
    evidence: evidence(),
    now: NOW,
    approvalSecret: SECRET,
  })
  const run = () => adoptBaseline({
    business: target,
    evidence: evidence(),
    approvalToken: dryRun.approvalToken!,
    confirmationPhrase: adoption.baselineConfirmationPhrase(target.id),
    actor: 'owner:local-audit',
    now: NOW,
    approvalSecret: SECRET,
  })

  for (const seed of [
    async () => saveBusiness({ ...target, updatedAt: target.updatedAt + 1 }),
    async () => undefined,
    async () => { await command('SET', `platform:business:${target.id}`, '{malformed') },
  ]) {
    await fetch(`${base}/__admin/flush`, { method: 'POST' })
    await seed()
    const result = await run()
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /evidence changed after the dry run/)
    const state = await dump()
    assert.equal(
      Object.keys(state.strings).filter((key) => /^platform:baseline-adoption:BADOPT-/.test(key)).length,
      0,
    )
    assert.equal(Object.keys(state.zsets['platform:baseline-adoption:index'] ?? {}).length, 0)
  }
})

test('unsupported and merely similar Lua scripts fail loudly', async () => {
  const { redis } = await import('../app/lib/redis')
  await assert.rejects(
    () => redis.eval(`local decoded = cjson.decode(redis.call('GET', KEYS[1])); return 1`, ['x'], []),
    /EMULATOR_UNSUPPORTED_SCRIPT/,
  )
  await assert.rejects(
    () => redis.eval(`return 1`, [], []),
    /EMULATOR_UNSUPPORTED_SCRIPT/,
  )
})
