// Pre-dispatch transfer gate — issue #48 Phase B, orchestrator level.
//
// Proves the load-bearing claim: when an update's prerequisites are missing, or its
// exact transfer would not resolve on the target, `preparePreview` creates NO job,
// NO branch, and dispatches NO workflow. Drives the real orchestrator against an
// in-memory store and an injected provider.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.OPERION_AUTOMATION_ENABLED = 'true'
process.env.OPERION_PREVIEW_AUTOMATION_ENABLED = 'true'
process.env.OPERION_GITHUB_ACTIONS_ENABLED = 'true'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (String(cmd).toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': {
      // SET key value [NX] [PX ms] — honour NX so the business lock behaves.
      if (args.includes('NX') && kv.has(key)) { result = null; break }
      kv.set(key, args[1]); result = 'OK'; break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREVRANGE': { const v = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); const s = Number(args[2]); result = v.slice(Number(args[1]), s === -1 ? v.length : s + 1); break }
    case 'EXPIRE': case 'PEXPIRE': result = 1; break
    case 'EVAL': result = 1; break
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { preparePreview, evaluatePreviewReadiness } from '../app/lib/platform/automation/orchestrator'
import { listJobs, saveJob } from '../app/lib/platform/automation/store'
import { saveUpdate, saveBusiness, saveCompat, saveDeployment } from '../app/lib/platform/updates/store'
import type { UpdateAutomationProvider } from '../app/lib/platform/automation/provider'
import type { PlatformUpdate, PlatformBusiness, DeploymentRecord } from '../app/lib/platform/updates/types'
import crypto from 'node:crypto'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

const PASS = { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'not_applicable', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' }

type Calls = { dispatched: number; ops: string[] }

/** The source commit UPD-1004 actually had: two files importing two missing modules. */
function provider(calls: Calls, targetPaths: string[]): UpdateAutomationProvider {
  const sources: Record<string, string> = {
    'app/lib/record-payment.ts': `import { onPaymentRecorded } from './intake-workflow'\nimport { redis } from './redis'\n`,
    'app/quote/page.tsx': `import { PACKS } from '../lib/pack-services'\nimport { COMPANY } from '../lib/company'\n`,
  }
  const p: Partial<UpdateAutomationProvider> = {
    name: 'probe',
    readCommit: async (_i, _r, s) => { calls.ops.push('readCommit'); return { ok: true, data: { sha: s, message: 'm', parentSha: 'PARENT', parentCount: 1 } } },
    readBranch: async () => { calls.ops.push('readBranch'); return { ok: true, data: { commit: 'TARGET_PINNED' } } },
    readTree: async () => { calls.ops.push('readTree'); return { ok: true, data: { paths: targetPaths } } },
    readCommitFiles: async () => { calls.ops.push('readCommitFiles'); return { ok: true, data: { files: [{ filename: 'app/lib/record-payment.ts', status: 'modified' }, { filename: 'app/quote/page.tsx', status: 'modified' }] } } },
    readFileContent: async (_i, repo, path) => {
      calls.ops.push(`readFileContent:${repo.name}:${path}`)
      const v = repo.name === 'supercharged' ? (targetPaths.includes(path) ? sources[path] ?? '' : undefined) : sources[path]
      if (v === undefined) return { ok: false, error: 'not found', category: 'not_found' }
      return { ok: true, data: { contentBase64: b64(v), sha256: sha(v) } }
    },
    dispatchWorkflow: async () => { calls.dispatched++; calls.ops.push('dispatchWorkflow'); return { ok: true, data: { dispatched: true } } },
  }
  return p as UpdateAutomationProvider
}

const UPDATE = (p: Partial<PlatformUpdate> = {}): PlatformUpdate => ({
  recordVersion: 1, key: 'UPD-1004', title: 'Tenant boundaries', summary: 'S', type: 'feature',
  scope: 'platform_core', severity: 'low', priority: 'normal', status: 'approved',
  breakingChange: false, migrationRequired: false, environmentChangeRequired: false, secretRequired: false,
  featureFlagRequired: false, manualPortRequired: false, rollbackSupported: true,
  validation: PASS, sourceRepo: 'ratchetnu/jkissllc', sourceCommit: 'e42af39',
  createdAt: 1, updatedAt: 1, ...p,
} as PlatformUpdate)

const BUSINESS: PlatformBusiness = {
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', role: 'target',
  repoName: 'ratchetnu/supercharged', defaultBranch: 'main', githubInstallationId: '999',
  automationWorkflowFile: 'operion-update.yml', configurationStatus: 'ready',
  previewProjectId: 'prj', previewDeploymentProvider: 'vercel', healthStatus: 'healthy',
  createdAt: 1, updatedAt: 1,
} as PlatformBusiness

// Everything the transfer needs, so only the gate under test can fail.
const COMPLETE_TARGET = ['app/lib/record-payment.ts', 'app/quote/page.tsx', 'app/lib/redis.ts', 'app/lib/company.ts', 'app/lib/intake-workflow.ts', 'app/lib/pack-services.ts']
const INCOMPLETE_TARGET = ['app/lib/record-payment.ts', 'app/quote/page.tsx', 'app/lib/redis.ts', 'app/lib/company.ts']

async function seed(update: PlatformUpdate, extra?: { deployments?: DeploymentRecord[]; compat?: Array<{ updateKey: string; status: string }> }) {
  kv.clear(); zsets.clear()
  await saveUpdate(update)
  await saveUpdate(UPDATE({ key: 'UPD-1001', title: 'Book Now intake' }))
  await saveBusiness(BUSINESS)
  await saveCompat({ recordVersion: 1, updateKey: update.key, businessId: BUSINESS.id, status: 'compatible', createdAt: 1, updatedAt: 1 } as never)
  for (const c of extra?.compat ?? []) await saveCompat({ recordVersion: 1, updateKey: c.updateKey, businessId: BUSINESS.id, status: c.status, createdAt: 1, updatedAt: 1 } as never)
  for (const d of extra?.deployments ?? []) await saveDeployment(d)
}

const prepare = (update: PlatformUpdate, calls: Calls, targetPaths: string[]) =>
  preparePreview({ update, business: BUSINESS, compat: { status: 'compatible' } as never, actor: 'owner', provider: provider(calls, targetPaths) })

// ── The two blocking paths ──────────────────────────────────────────────────

test('an incomplete transfer blocks BEFORE any job is created and dispatches nothing', async () => {
  const update = UPDATE()
  await seed(update)
  const calls: Calls = { dispatched: 0, ops: [] }
  const r = await prepare(update, calls, INCOMPLETE_TARGET)

  assert.equal(r.ok, false)
  assert.equal(r.reason, 'preflight_failed')
  assert.equal(r.job, undefined, 'no job object returned')
  assert.deepEqual(await listJobs(), [], 'no job persisted')
  assert.equal(calls.dispatched, 0, 'no workflow dispatched')
  assert.ok(!calls.ops.includes('dispatchWorkflow'))

  const gate = r.preflight.gates.find((g) => g.id === 'transfer_ready')!
  assert.equal(gate.ok, false)
  assert.match(gate.reason ?? '', /app\/lib\/intake-workflow\.ts \(imported by app\/lib\/record-payment\.ts/)
  assert.match(gate.reason ?? '', /app\/lib\/pack-services\.ts \(imported by app\/quote\/page\.tsx/)
})

test('a missing required update blocks before the transfer check even runs', async () => {
  const update = UPDATE({ dependencies: ['UPD-1001'] })
  await seed(update)
  const calls: Calls = { dispatched: 0, ops: [] }
  const r = await prepare(update, calls, COMPLETE_TARGET)

  assert.equal(r.ok, false)
  assert.deepEqual(await listJobs(), [], 'no job persisted')
  assert.equal(calls.dispatched, 0)
  assert.equal(calls.ops.length, 0, 'the cheap gate short-circuits before any GitHub read')

  const gate = r.preflight.gates.find((g) => g.id === 'required_updates')!
  assert.equal(gate.ok, false)
  assert.match(gate.reason ?? '', /needs UPD-1001 on this business first/)
  assert.match(gate.reason ?? '', /not installed on this business yet/)
})

test('a prerequisite that is deployed but unverified still blocks', async () => {
  const update = UPDATE({ dependencies: ['UPD-1001'] })
  await seed(update, { deployments: [{ recordVersion: 1, id: 'dep_1', businessId: 'supercharged', updateKeys: ['UPD-1001'], status: 'deployed', verificationStatus: 'pending', rollbackAvailable: false, createdAt: 1, updatedAt: 1 } as DeploymentRecord] })
  const calls: Calls = { dispatched: 0, ops: [] }
  const r = await prepare(update, calls, COMPLETE_TARGET)
  assert.equal(r.ok, false)
  assert.deepEqual(await listJobs(), [])
  assert.match(r.preflight.gates.find((g) => g.id === 'required_updates')!.reason ?? '', /deployed but not verified yet/)
})

// ── The two passing paths ───────────────────────────────────────────────────

test('an already_present prerequisite satisfies the gate and the job is created', async () => {
  const update = UPDATE({ dependencies: ['UPD-1001'] })
  await seed(update, { compat: [{ updateKey: 'UPD-1001', status: 'already_present' }] })
  const calls: Calls = { dispatched: 0, ops: [] }
  const r = await prepare(update, calls, COMPLETE_TARGET)
  assert.equal(r.ok, true, JSON.stringify(r.preflight.gates.filter(g => !g.ok)))
  assert.ok(r.job)
  assert.equal((await listJobs()).length, 1)
})

test('a verified deployment satisfies the gate, and a valid transfer creates exactly one idempotent job', async () => {
  const update = UPDATE({ dependencies: ['UPD-1001'] })
  await seed(update, { deployments: [{ recordVersion: 1, id: 'dep_1', businessId: 'supercharged', updateKeys: ['UPD-1001'], status: 'deployed', verificationStatus: 'passed', rollbackAvailable: false, createdAt: 1, updatedAt: 1 } as DeploymentRecord] })
  const calls: Calls = { dispatched: 0, ops: [] }

  const first = await prepare(update, calls, COMPLETE_TARGET)
  assert.equal(first.ok, true, JSON.stringify(first.preflight.gates.filter(g => !g.ok)))
  assert.ok(first.job)
  assert.equal(calls.dispatched, 1)

  // While that job is still active, a repeat attempt is refused by the pre-existing
  // no_conflicting_job gate — no second job, no second dispatch.
  const whileActive = await prepare(update, calls, COMPLETE_TARGET)
  assert.equal(whileActive.ok, false)
  assert.equal(whileActive.preflight.gates.find((g) => g.id === 'no_conflicting_job')!.ok, false)
  assert.equal((await listJobs()).length, 1)
  assert.equal(calls.dispatched, 1)

  // Once it is no longer active, the idempotency key returns the SAME job rather than
  // creating a second one for the same (business, update, source commit).
  const job = (await listJobs())[0]
  await saveJob({ ...job, status: 'completed' })
  const again = await prepare(update, calls, COMPLETE_TARGET)
  assert.equal(again.ok, true)
  assert.equal(again.reason, 'idempotent_existing')
  assert.equal(again.job?.id, first.job?.id, 'the same job is returned, not a second one')
  assert.equal((await listJobs()).length, 1, 'exactly one job exists')
  assert.equal(calls.dispatched, 1, 'no second dispatch')
})

// ── Backward compatibility ──────────────────────────────────────────────────

test('an update with no dependencies keeps its previous behaviour end to end', async () => {
  const update = UPDATE()                                   // no `dependencies` field at all
  await seed(update)
  const calls: Calls = { dispatched: 0, ops: [] }
  const r = await prepare(update, calls, COMPLETE_TARGET)
  assert.equal(r.ok, true, JSON.stringify(r.preflight.gates.filter(g => !g.ok)))
  assert.ok(r.job)
  assert.equal(r.preflight.gates.find((g) => g.id === 'required_updates')!.ok, true)
  assert.equal(calls.dispatched, 1)
})

test('the read-only readiness poll never runs the network-bound transfer check', async () => {
  const update = UPDATE()
  await seed(update)
  const calls: Calls = { dispatched: 0, ops: [] }
  const r = await evaluatePreviewReadiness({ update, business: BUSINESS, compat: { status: 'compatible' } as never, provider: provider(calls, INCOMPLETE_TARGET), skipTransferCheck: true })
  assert.equal(calls.ops.length, 0, 'no GitHub reads for the cheap poll')
  assert.equal(r.gates.find((g) => g.id === 'transfer_ready')!.ok, true, 'unevaluated is not a failure')
  assert.deepEqual(await listJobs(), [], 'readiness never creates a job')
})

test('an unprovisioned environment leaves the transfer gate unevaluated, not failed', async () => {
  // With no GitHub App credentials the inert StubProvider fails every read. That is
  // NOT evidence the transfer is incomplete — it is the documented "execution not
  // configured" path, which the dispatch step already handles. Turning it into a
  // preflight failure would block every unprovisioned environment.
  const update = UPDATE()
  await seed(update)
  const { StubProvider } = await import('../app/lib/platform/automation/provider')
  const r = await evaluatePreviewReadiness({ update, business: BUSINESS, compat: { status: 'compatible' } as never, provider: new StubProvider() })
  assert.equal(r.gates.find((g) => g.id === 'transfer_ready')!.ok, true)
  assert.equal(r.ok, true, 'readiness is unchanged for an unprovisioned target')
})
