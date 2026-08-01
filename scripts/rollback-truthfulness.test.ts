// ─────────────────────────────────────────────────────────────────────────────
// Rollback truthfulness — the two gaps found auditing the deploy/rollback process.
//
// GAP A. Eligibility was computed at prepare from `business.currentCommit` — a
// COMMIT — while a rollback executes against a DEPLOYMENT ID captured later, in an
// UNGUARDED lookup, after which the merge proceeded regardless. A job could be
// marked rollback-eligible, change production, fail, and only then discover it had
// nothing to roll back to.
//
// GAP B. Vercel's rollback is ASYNCHRONOUS. A 200 from the POST only means
// ACCEPTED, yet the job recorded `rolled_back` and "production restored" — a claim
// nothing had verified.
//
// Both are the same species of bug as the observation windows: asserting a state
// that was never confirmed. The tests below try to make each lie again.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.VERCEL_TOKEN = 'test-vercel-token'   // so the REAL provider class is used
process.env.OPERION_PRODUCTION_PROMOTION_ENABLED = 'true'

// ── in-memory Upstash + a scriptable Vercel API ──────────────────────────────
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

type VercelScript = {
  deployments?: unknown            // GET /v6/deployments
  deploymentsStatus?: number
  project?: unknown                // GET /v9/projects/{id}
  projectStatus?: number
  rollbackStatus?: number          // POST /v9/projects/{id}/rollback/{dpl}
}
let vercel: VercelScript = {}
let rollbackPosts = 0

globalThis.fetch = (async (url: string, init?: { body?: string; method?: string }) => {
  const u = String(url)
  if (u.startsWith('http://fake-upstash.local')) {
    const [cmd, ...args] = JSON.parse(init!.body as string) as string[]
    const key = args[0]; const c = cmd.toUpperCase(); let result: unknown = null
    switch (c) {
      case 'GET': result = kv.get(key) ?? null; break
      case 'SET': {
        const nx = args.includes('NX')
        if (nx && kv.has(key)) { result = null; break }
        kv.set(key, args[1]); result = 'OK'; break
      }
      case 'DEL': kv.delete(key); result = 1; break
      case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
      case 'ZREM': z(key).delete(args[1]); result = 1; break
      case 'ZCARD': result = z(key).size; break
      case 'ZRANGE': case 'ZREVRANGE': {
        const sorted = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
        if (c === 'ZREVRANGE') sorted.reverse()
        result = sorted.slice(Number(args[1]), Number(args[2]) === -1 ? undefined : Number(args[2]) + 1); break
      }
      case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
      case 'PEXPIRE': result = 1; break
      case 'EVAL': {
        // The lock-RELEASE script: delete KEYS[1] when it still holds ARGV[1].
        // Returning 1 without deleting would leave the business lock held and every
        // subsequent orchestrator call would report 'target_locked'.
        const numKeys = Number(args[1])
        const lockKey = args[2]
        const token = args[2 + numKeys]
        if (kv.get(lockKey) === token) { kv.delete(lockKey); result = 1 } else result = 0
        break
      }
      default: result = null
    }
    return { json: async () => ({ result }) }
  }
  // ── Vercel ──
  if (u.includes('/v6/deployments')) {
    const st = vercel.deploymentsStatus ?? 200
    return { ok: st < 400, status: st, json: async () => vercel.deployments ?? { deployments: [] } }
  }
  if (init?.method === 'POST' && u.includes('/rollback/')) {
    rollbackPosts++
    const st = vercel.rollbackStatus ?? 200
    return { ok: st < 400, status: st, json: async () => ({}) }
  }
  if (u.includes('/v9/projects/')) {
    const st = vercel.projectStatus ?? 200
    return { ok: st < 400, status: st, json: async () => vercel.project ?? { id: 'prj_prod' } }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}) as unknown as typeof fetch

import {
  advanceRollback, pollRollback, approveProduction,
  ROLLBACK_MAX_POLLS, ROLLBACK_POLL_BACKOFF_MS, ROLLBACK_TIMEOUT_MS,
} from '../app/lib/platform/automation/orchestrator'
import * as store from '../app/lib/platform/automation/store'
import { saveBusiness } from '../app/lib/platform/updates/store'
import type { UpdateAutomationJob } from '../app/lib/platform/automation/types'

const T0 = 1_800_000_000_000
const BIZ = 'supercharged'

const BUSINESS = {
  id: BIZ, slug: BIZ, name: 'SC', repoName: 'ratchetnu/supercharged', defaultBranch: 'main',
  productionProjectId: 'prj_prod', currentCommit: 'abcdef1234567890',
  allowProductionPromotion: true, githubInstallationId: 42, updatedAt: T0,
} as never
const business = async () => saveBusiness(BUSINESS)

/** Drive the real promotion entry point through to the rollback-target capture. */
const promote = () => approveProduction({ jobId: 'job_1', business: BUSINESS, actor: 'owner' })

const job = async (over: Partial<UpdateAutomationJob> = {}): Promise<UpdateAutomationJob> => {
  const j = {
    jobVersion: 1, id: 'job_1', updateId: 'u1', businessId: BIZ, mode: 'manual_prompt',
    strategy: 'commit_transfer', status: 'rollback_required', currentStep: 'production',
    attemptCount: 0, idempotencyKey: 'idem1',
    sourceRepository: 'a', sourceCommit: 'c1', targetRepository: 'ratchetnu/supercharged',
    baseBranch: 'main', workBranch: 'w',
    automaticRollbackEligible: true, rollbackTargetDeploymentId: 'dpl_good',
    createdBy: 'u', queuedAt: T0, createdAt: T0, updatedAt: T0, ...over,
  } as unknown as UpdateAutomationJob
  await store.saveJob(j)
  return j
}

beforeEach(async () => {
  kv.clear(); zsets.clear(); vercel = {}; rollbackPosts = 0
  process.env.OPERION_AUTOMATIC_ROLLBACK_ENABLED = 'true'
  await business()
})

const reload = () => store.getJob('job_1')

/** Poll times must be relative to the REAL start the orchestrator stamped, or every
 *  poll looks like it happened 20 years late and trips the timeout. */
const startedAt = async () => (await reload())!.rollbackStartedAt!

// ── GAP B: a started rollback is not a finished one ──────────────────────────

test('B: a 200 from Vercel records rolling_back — NOT rolled_back', async () => {
  await job()
  const r = await advanceRollback({ jobId: 'job_1' })
  assert.equal(r.ok, true)
  const j = (await reload())!
  assert.equal(j.status, 'rolling_back', 'accepted ≠ finished')
  assert.notEqual(j.status, 'rolled_back')
  assert.equal(j.rolledBackAt, undefined, 'nothing may claim a completion time yet')
  assert.ok(j.rollbackStartedAt, 'but the start IS recorded, so it can be confirmed later')
  assert.match(j.failureSummary!, /awaiting confirmation/)
})

test('B: rolled_back only after Vercel CONFIRMS succeeded', async () => {
  await job()
  await advanceRollback({ jobId: 'job_1' })

  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'in-progress', toDeploymentId: 'dpl_good' } }
  const s0 = await startedAt()
  const p1 = await pollRollback({ jobId: 'job_1', at: s0 + ROLLBACK_POLL_BACKOFF_MS + 1 })
  assert.equal(p1.ok, false)
  assert.equal((await reload())!.status, 'rolling_back', 'in-progress is not success')

  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'succeeded', toDeploymentId: 'dpl_good' } }
  const p2 = await pollRollback({ jobId: 'job_1', at: s0 + 2 * ROLLBACK_POLL_BACKOFF_MS + 2 })
  assert.equal(p2.ok, true)
  const j = (await reload())!
  assert.equal(j.status, 'rolled_back')
  assert.ok(j.rollbackConfirmedAt, 'confirmation is timestamped separately from the start')
  assert.match(j.failureSummary!, /confirmed by Vercel/)
})

test('B: a FAILED rollback is reported truthfully, not swallowed', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'failed' } }
  const p = await pollRollback({ jobId: 'job_1', at: (await startedAt()) + ROLLBACK_POLL_BACKOFF_MS + 1 })
  assert.equal(p.ok, false)
  const j = (await reload())!
  assert.equal(j.status, 'rollback_required', 'it goes back for another attempt / a human')
  assert.match(j.failureSummary!, /still on the bad deployment/)
})

test('B: a TIMEOUT leaves an UNCONFIRMED state, never a success', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'in-progress' } }
  const p = await pollRollback({ jobId: 'job_1', at: (await startedAt()) + ROLLBACK_TIMEOUT_MS + 1 })
  assert.equal(p.ok, false)
  const j = (await reload())!
  assert.equal(j.status, 'rollback_required')
  assert.equal(j.failureCategory, 'timeout')
  assert.match(j.failureSummary!, /UNCONFIRMED/, 'the operator is told what is NOT known')
  assert.match(j.failureSummary!, /verify manually/)
})

test('B: a MALFORMED provider body is unknown, never success', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  for (const body of [{}, { lastRollbackTarget: null }, { lastRollbackTarget: { jobStatus: 'weird' } }]) {
    vercel.project = body
    await pollRollback({ jobId: 'job_1', at: (await startedAt()) + ROLLBACK_POLL_BACKOFF_MS * 2 })
    assert.notEqual((await reload())!.status, 'rolled_back', `${JSON.stringify(body)} must not read as success`)
  }
})

test('B: an UNREADABLE status keeps waiting, and still times out truthfully', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  vercel.projectStatus = 500
  const s0 = await startedAt()
  await pollRollback({ jobId: 'job_1', at: s0 + ROLLBACK_POLL_BACKOFF_MS + 1 })
  assert.equal((await reload())!.status, 'rolling_back')
  const p = await pollRollback({ jobId: 'job_1', at: s0 + ROLLBACK_TIMEOUT_MS + 1 })
  assert.equal(p.ok, false)
  assert.match((await reload())!.failureSummary!, /status unreadable/)
})

test('B: success for a DIFFERENT deployment than the captured target is refused', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'succeeded', toDeploymentId: 'dpl_SOMETHING_ELSE' } }
  const p = await pollRollback({ jobId: 'job_1', at: (await startedAt()) + ROLLBACK_POLL_BACKOFF_MS + 1 })
  assert.equal(p.ok, false)
  const j = (await reload())!
  assert.equal(j.status, 'rollback_required')
  assert.match(j.failureSummary!, /DIFFERENT deployment/)
})

// ── GAP B: idempotency, duplicates, crashes ──────────────────────────────────

test('B: duplicate advanceRollback never starts a SECOND rollback', async () => {
  await job()
  await advanceRollback({ jobId: 'job_1' })
  assert.equal(rollbackPosts, 1)
  const again = await advanceRollback({ jobId: 'job_1' })
  assert.equal(again.ok, false, 'the gate requires rollback_required; the job is now rolling_back')
  assert.equal(rollbackPosts, 1, 'production must never be rolled back twice by a duplicate call')
})

test('B: duplicate polling respects backoff and does not double-count', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'in-progress' } }
  const at = (await startedAt()) + ROLLBACK_POLL_BACKOFF_MS + 1
  await pollRollback({ jobId: 'job_1', at })
  const after1 = (await reload())!.rollbackPollCount
  const dup = await pollRollback({ jobId: 'job_1', at: at + 1 })   // immediately again
  assert.equal(dup.reason, 'backoff')
  assert.equal((await reload())!.rollbackPollCount, after1, 'a duplicate tick must not consume the budget')
})

test('B: polling is BOUNDED — it never retries forever', async () => {
  await job(); await advanceRollback({ jobId: 'job_1' })
  vercel.project = { id: 'prj_prod', lastRollbackTarget: { jobStatus: 'in-progress' } }
  let at = await startedAt()
  for (let i = 0; i < ROLLBACK_MAX_POLLS + 3; i++) {
    at += ROLLBACK_POLL_BACKOFF_MS + 1
    await pollRollback({ jobId: 'job_1', at })
  }
  const j = (await reload())!
  assert.equal(j.status, 'rollback_required', 'it stops and asks for a human')
  assert.ok((j.rollbackPollCount ?? 0) <= ROLLBACK_MAX_POLLS)
})

test('B: polling a job that is NOT rolling_back is a no-op (crash between transitions)', async () => {
  await job({ status: 'rolled_back' })
  const p = await pollRollback({ jobId: 'job_1', at: T0 + 10 * ROLLBACK_POLL_BACKOFF_MS })
  assert.equal(p.ok, false)
  assert.match(p.reason!, /not rolling_back/)
  assert.equal((await reload())!.status, 'rolled_back', 'a settled job is never disturbed')
})

test('B: a job marked rolling_back with NO recorded start does not poll', async () => {
  // The crash window: status persisted, the POST never happened.
  await job({ status: 'rolling_back', rollbackStartedAt: undefined })
  const p = await pollRollback({ jobId: 'job_1', at: T0 + ROLLBACK_TIMEOUT_MS })
  assert.equal(p.ok, false)
  assert.match(p.reason!, /no rollback in flight/)
  assert.equal(rollbackPosts, 0, 'and it certainly does not start one from the poller')
})

// ── GAP A: the target must be real, verified, and bound to the commit ────────

const prodDeployments = (over: Record<string, unknown> = {}) => ({
  deployments: [{ uid: 'dpl_good', url: 'x.vercel.app', readyState: 'READY', meta: { githubCommitSha: 'abcdef1234567890' }, ...over }],
})

test('A: flag ON + no target capturable → promotion is REFUSED before production changes', async () => {
  await job({ status: 'awaiting_owner_review', approvedCommit: 'c1', targetCommit: 'c1', pullRequestNumber: 7, rollbackTargetDeploymentId: undefined })
  vercel.deployments = { deployments: [] }          // nothing found for the verified commit
  const r = await promote().catch(() => null)
  const j = (await reload())!
  assert.notEqual(j.status, 'merging', 'it must NOT enter merging asserting a recovery path it lacks')
  assert.equal(j.status, 'failed')
  assert.equal(j.failureCategory, 'promotion_failed')
  assert.match(j.failureSummary!, /refused to promote/)
  assert.ok(j.rollbackUnavailableReason)
  assert.ok(r === null || r.ok === false, 'the promotion call itself reports failure')
})

test('A: flag ON + target NOT ready → refused, and the reason names the state', async () => {
  await job({ status: 'awaiting_owner_review', approvedCommit: 'c1', targetCommit: 'c1', pullRequestNumber: 7, rollbackTargetDeploymentId: undefined })
  vercel.deployments = prodDeployments({ readyState: 'BUILDING' })
  await promote().catch(() => null)
  const j = (await reload())!
  assert.equal(j.status, 'failed')
  assert.match(j.rollbackUnavailableReason!, /not ready/)
})

test('A: flag ON + lookup ERROR → refused rather than promoted blind', async () => {
  await job({ status: 'awaiting_owner_review', approvedCommit: 'c1', targetCommit: 'c1', pullRequestNumber: 7, rollbackTargetDeploymentId: undefined })
  vercel.deploymentsStatus = 500
  await promote().catch(() => null)
  const j = (await reload())!
  assert.equal(j.status, 'failed')
  assert.match(j.rollbackUnavailableReason!, /could not read/)
})

test('A: flag OFF → promotion proceeds, but the unavailability is RECORDED', async () => {
  process.env.OPERION_AUTOMATIC_ROLLBACK_ENABLED = 'false'
  await job({ status: 'awaiting_owner_review', approvedCommit: 'c1', targetCommit: 'c1', pullRequestNumber: 7, rollbackTargetDeploymentId: undefined, automaticRollbackEligible: false })
  vercel.deployments = { deployments: [] }
  await promote().catch(() => null)
  const j = (await reload())!
  // It may still fail LATER (this harness has no GitHub provider, so the merge
  // fails) — what matters is it was not REFUSED at the rollback-target gate.
  assert.notEqual(j.failureCategory, 'promotion_failed', 'flag off must not refuse the promotion')
  assert.doesNotMatch(j.failureSummary ?? '', /refused to promote/)
  assert.ok(j.rollbackUnavailableReason, 'but the absence is written down, not discovered mid-incident')
  assert.equal(j.automaticRollbackEligible, false, 'and nothing downstream believes recovery is available')
})

test('A: a captured target is BOUND to the verified commit', () => {
  const src = readFileSync(new URL('../app/lib/platform/automation/orchestrator.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('// Capture the known-good rollback target'), src.indexOf("j.status = 'merging'"))
  assert.match(block, /findProductionDeployment\(projectId, verifiedCommit\)/,
    'the lookup must be FOR the verified commit — not whatever deployment is newest')
  assert.match(block, /j\.rollbackTargetCommit = verifiedCommit/, 'and the pair is stored together')
  assert.match(block, /cur\.data\.ready/, 'a non-ready deployment is not a rollback target')
})

// ── The contract, pinned in source ───────────────────────────────────────────

test('the provider documents that a POST STARTS a rollback, and exposes a status read', () => {
  const src = readFileSync(new URL('../app/lib/platform/automation/vercel-provider.ts', import.meta.url), 'utf8')
  assert.match(src, /async rollbackStatus\(/)
  assert.match(src, /rollback is ASYNCHRONOUS/)
  assert.match(src, /START a rollback\. Returns when Vercel has ACCEPTED it — not when it is done/)
})

test('only ONE code path may set rolled_back, and it requires a confirmation', () => {
  const src = readFileSync(new URL('../app/lib/platform/automation/orchestrator.ts', import.meta.url), 'utf8')
  const sets = src.match(/status = 'rolled_back'/g) ?? []
  assert.equal(sets.length, 1, 'more than one writer means one of them can lie')
  const around = src.slice(src.indexOf("st.data.status === 'succeeded'"), src.indexOf("status = 'rolled_back'") + 200)
  assert.match(around, /rollbackConfirmedAt/, 'the single writer records the confirmation')
})

test('the reconcile cron confirms in-flight rollbacks', () => {
  const src = readFileSync(new URL('../app/api/cron/operion-reconcile/route.ts', import.meta.url), 'utf8')
  assert.match(src, /pollRollback/)
  assert.match(src, /j\.status === 'rolling_back'/, 'or a started rollback is never confirmed')
})
