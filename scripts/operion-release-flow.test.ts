// Operion release — Update flow (Preview-only) wiring tests.
//   • pure: progress mapping + target-update selection
//   • integration: the REAL preview orchestrator over an in-memory Upstash (no GitHub/Vercel):
//     one job, idempotent repeats, safe retry, production never reached, installed version preserved.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.OPERION_AUTOMATION_ENABLED = '1'
process.env.OPERION_PREVIEW_AUTOMATION_ENABLED = '1'
process.env.OPERION_GITHUB_ACTIONS_ENABLED = '1'
delete process.env.GITHUB_APP_ID // → StubProvider: dispatch fails, job stops at 'blocked' (no network)

import assert from 'node:assert/strict'
import test from 'node:test'

// ── in-memory Upstash (GET/SET[/NX]/DEL/INCR/ZADD/ZRANGE/EVAL/PEXPIRE) ────────
const kv = new Map<string, string>()
const zs = new Map<string, Map<string, number>>()
const z = (k: string) => zs.get(k) ?? zs.set(k, new Map()).get(k)!
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const args = JSON.parse(init.body) as string[]
  const cmd = args[0].toUpperCase(); const key = args[1]
  let result: unknown = null
  switch (cmd) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': {
      const nx = args.includes('NX')
      if (nx && kv.has(key)) { result = null; break }
      kv.set(key, args[2]); result = 'OK'; break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[3], Number(args[2])); result = 1; break
    case 'ZREM': result = z(key).delete(args[2]) ? 1 : 0; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE': case 'ZREVRANGE': {
      const s = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
      if (cmd === 'ZREVRANGE') s.reverse()
      const a = Number(args[2]); const b = Number(args[3]); result = s.slice(a, b === -1 ? undefined : b + 1); break
    }
    case 'EVAL': result = 1; break        // lock release
    case 'PEXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return { json: async () => ({ result }) }
}) as unknown as typeof fetch

import { mapJobToProgress, UPDATE_STEPS } from '../app/lib/platform/release/progress'
import { pickTargetUpdate } from '../app/lib/platform/release/update-target'
import { resolveReleaseState } from '../app/lib/platform/release/state'
import { saveBusiness, saveUpdate, saveCompat, getBusiness } from '../app/lib/platform/updates/store'
import { listJobs, getJob, saveJob } from '../app/lib/platform/automation/store'
import { preparePreview, retryPreview } from '../app/lib/platform/automation/orchestrator'
import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility, ValidationChecklist } from '../app/lib/platform/updates/types'

// ── pure: progress mapping ──────────────────────────────────────────────────
test('progress: five calm steps, driven by real job status; production states never expose publish here', () => {
  assert.deepEqual([...UPDATE_STEPS], ['Checking', 'Preparing Preview', 'Deploying Preview', 'Verifying Preview', 'Ready to Publish'])
  assert.equal(mapJobToProgress(null, { hasJob: false }).running, false)
  assert.equal(mapJobToProgress('queued', { hasJob: true }).step, 0)
  assert.equal(mapJobToProgress('applying_update', { hasJob: true }).step, 1)
  assert.equal(mapJobToProgress('preview_deploying', { hasJob: true }).step, 2)
  assert.equal(mapJobToProgress('preview_ready', { hasJob: true }).step, 3)
  const ready = mapJobToProgress('awaiting_owner_review', { hasJob: true })
  assert.equal(ready.step, 4); assert.equal(ready.previewReady, true); assert.equal(ready.running, false)
  const failed = mapJobToProgress('build_failed', { hasJob: true })
  assert.equal(failed.blocked, true); assert.equal(failed.canRetry, true)
  const blocked = mapJobToProgress('blocked', { hasJob: true })
  assert.equal(blocked.blocked, true); assert.equal(blocked.canRetry, false)
})

test('progress: messages carry no internal jargon', () => {
  const all = ['queued', 'applying_update', 'preview_deploying', 'preview_ready', 'awaiting_owner_review', 'build_failed', 'blocked', 'production_deploying']
    .map(s => mapJobToProgress(s, { hasJob: true })).flatMap(p => [p.message, p.issue ?? ''])
  assert.doesNotMatch(all.join(' '), /SHA|commit|migration|reconcil|manifest|drift|dispatch|workflow|orchestrat/i)
})

// ── pure: target selection ──────────────────────────────────────────────────
const PASS: ValidationChecklist = { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'not_applicable', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' }
const upd = (p: Partial<PlatformUpdate> = {}): PlatformUpdate => ({
  recordVersion: 1, key: 'UPD-1', title: 'T', summary: 'S', type: 'enhancement', scope: 'platform_core',
  severity: 'medium', priority: 'normal', status: 'approved', breakingChange: false, migrationRequired: false,
  environmentChangeRequired: false, secretRequired: false, featureFlagRequired: false, manualPortRequired: false,
  rollbackSupported: true, validation: PASS, sourceCommit: 'src1', createdAt: 1, updatedAt: 1, ...p,
})

test('target: picks the highest-priority eligible update; skips already-present/blocked/ineligible', () => {
  const updates = [
    upd({ key: 'A', priority: 'low' }),
    upd({ key: 'B', priority: 'urgent' }),
    upd({ key: 'C', priority: 'high' }),
    upd({ key: 'D', status: 'planned' }),                    // ineligible (not approved)
    upd({ key: 'E', priority: 'urgent' }),
  ]
  const compat: Record<string, UpdateCompatibility['status']> = { E: 'already_present' } // skip E
  const pick = pickTargetUpdate(updates, k => compat[k] ? ({ status: compat[k] } as UpdateCompatibility) : undefined)
  assert.equal(pick?.key, 'B')
  assert.equal(pickTargetUpdate([upd({ status: 'planned' })], () => undefined), null)
})

// ── integration: the real Preview-only orchestrator over the in-memory store ──
const bizId = 'testco'
async function seed() {
  const business: PlatformBusiness = {
    recordVersion: 1, id: bizId, name: 'Test Co', slug: 'testco', status: 'active', role: 'target',
    defaultBranch: 'main', releaseChannel: 'beta', updatePolicy: 'owner_approval', updatesPaused: false,
    manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy', configurationStatus: 'ready',
    githubInstallationId: '123', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'testco', repoName: 'ratchetnu/testco',
    automationWorkflowFile: 'operion-update.yml', previewProjectId: 'prj_x', previewDeploymentProvider: 'vercel',
    currentVersion: 'v0.1.0', currentCommit: 'live1', createdAt: 1, updatedAt: 1,
  }
  const update = upd({ key: 'UPD-9', sourceRepo: 'ratchetnu/jkissllc' })
  await saveBusiness(business)
  await saveUpdate(update)
  await saveCompat({ recordVersion: 1, updateKey: 'UPD-9', businessId: bizId, status: 'compatible', createdAt: 1, updatedAt: 1 })
  return { business, update }
}

test('integration: Update starts exactly ONE job and is idempotent on repeat', async () => {
  const { business, update } = await seed()
  const r1 = await preparePreview({ update, business, compat: { status: 'compatible' } as UpdateCompatibility, actor: 'owner' })
  assert.equal(r1.ok, true, `preflight: ${JSON.stringify(r1.preflight?.gates ?? r1.reason)}`)
  assert.ok(r1.job)
  const jobsAfter1 = (await listJobs()).filter(j => j.businessId === bizId)
  assert.equal(jobsAfter1.length, 1, 'exactly one job created')

  const r2 = await preparePreview({ update, business, compat: { status: 'compatible' } as UpdateCompatibility, actor: 'owner' })
  assert.equal(r2.job?.id, r1.job!.id, 'same job returned (idempotent)')
  assert.equal(r2.reason, 'idempotent_existing')
  const jobsAfter2 = (await listJobs()).filter(j => j.businessId === bizId)
  assert.equal(jobsAfter2.length, 1, 'no duplicate job on repeat')
})

test('integration: without provider creds the job stops safely (no external calls, not production)', async () => {
  const job = (await listJobs()).find(j => j.businessId === bizId)!
  // Stub provider (no GITHUB_APP_ID) → dispatch fails → job is blocked, NEVER a production phase.
  assert.ok(['blocked', 'queued'].includes(job.status), `job safely halted, got ${job.status}`)
  assert.ok(!['approved_for_production', 'merging', 'production_deploying', 'verifying', 'completed'].includes(job.status), 'never auto-reaches production')
})

test('integration: retry does not create a duplicate job and stays Preview-only', async () => {
  const before = (await listJobs()).filter(j => j.businessId === bizId).length
  const job = (await listJobs()).find(j => j.businessId === bizId)!
  job.status = 'build_failed'; job.updatedAt = 2; await saveJob(job) // simulate a retryable failure
  await retryPreview({ jobId: job.id })
  const after = (await listJobs()).filter(j => j.businessId === bizId)
  assert.equal(after.length, before, 'retry reuses the same job (no duplicate)')
  assert.ok(!['approved_for_production', 'merging', 'production_deploying'].includes(after[0].status), 'retry never enters production')
})

test('integration: a verified preview reads Ready to Publish but does NOT install the new version', async () => {
  const job = (await listJobs()).find(j => j.businessId === bizId)!
  job.status = 'awaiting_owner_review'; job.updatedAt = 3; await saveJob(job)
  const fresh = await getJob(job.id)
  const prog = mapJobToProgress(fresh!.status, { hasJob: true })
  assert.equal(prog.previewReady, true)
  assert.equal(prog.stepLabel, 'Ready to Publish')
  // Resolver agrees: a verified/awaiting-approval preview → Ready to Publish (never up_to_date).
  const rs = resolveReleaseState({ initialized: true, health: 'healthy', updateAvailable: true, job: 'awaiting_approval', previewVerified: true, verificationFailed: false, blocking: [], driftReasons: [], installedVersion: 'v0.1.0', latestVersion: 'v0.2.0' })
  assert.equal(rs.status, 'ready_to_publish'); assert.equal(rs.action, 'publish')
  // Last known good preserved: preview success must NOT bump the installed version.
  const biz = await getBusiness(bizId)
  assert.equal(biz?.currentVersion, 'v0.1.0', 'installed version unchanged until production publish')
})
