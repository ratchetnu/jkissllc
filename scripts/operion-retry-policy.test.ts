// Operion retry policy — the canonical eligibility rule shared by the dispatcher
// (retryPreview), the Retry button, and its copy.
//
// Regression origin: UPD-1004 was ARCHIVED and terminal, yet the Release Center rendered a
// Retry button reading "You can retry safely" and re-fired it from attempt 4 → 5
// (Supercharged workflow run 30135658768, 2026-07-25T00:10:26Z). Three disagreeing
// job-status sets existed and NONE consulted the update's own status. These tests pin the
// single policy so that cannot recur.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.OPERION_AUTOMATION_ENABLED = '1'
process.env.OPERION_PREVIEW_AUTOMATION_ENABLED = '1'
process.env.OPERION_GITHUB_ACTIONS_ENABLED = '1'
delete process.env.GITHUB_APP_ID // StubProvider — a dispatch would be observable, and must not happen

import assert from 'node:assert/strict'
import test from 'node:test'

// ── in-memory Upstash (same shape as operion-release-flow.test.ts) ───────────
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
    case 'EVAL': result = 1; break
    case 'PEXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return { json: async () => ({ result }) }
}) as unknown as typeof fetch

import {
  retryEligibility, retryBlockedMessage, MAX_OWNER_RETRIES, isOwnerRetryable,
} from '../app/lib/platform/automation/deploy-view'
import { APPROVED_STATUSES } from '../app/lib/platform/automation/preflight'
import { mapJobToProgress } from '../app/lib/platform/release/progress'
import { saveBusiness, saveUpdate } from '../app/lib/platform/updates/store'
import { saveJob, getJob } from '../app/lib/platform/automation/store'
import { retryPreview } from '../app/lib/platform/automation/orchestrator'
import type { PlatformBusiness, PlatformUpdate, ValidationChecklist } from '../app/lib/platform/updates/types'

// A job in exactly the shape UPD-1004's was.
const UPD_1004_JOB = { jobStatus: 'failed', failureCategory: 'apply_failed', attemptCount: 4 }

// ── The regression ───────────────────────────────────────────────────────────

test('UPD-1004 regression: an ARCHIVED update cannot be retried, however retryable the job looks', () => {
  // The job itself is genuinely owner-retryable — that is why the button appeared.
  assert.equal(isOwnerRetryable(UPD_1004_JOB.jobStatus, UPD_1004_JOB.failureCategory), true)
  // …but the update is archived, so the answer is no.
  const e = retryEligibility({ ...UPD_1004_JOB, updateStatus: 'archived' })
  assert.equal(e.ok, false)
  assert.equal(e.ok === false && e.reason, 'update_not_retryable')
  assert.match(e.ok === false ? e.detail : '', /archived/)
})

test('the archived card no longer says "you can retry safely"', () => {
  const p = mapJobToProgress('failed', { hasJob: true, updateStatus: 'archived', failureCategory: 'apply_failed', attemptCount: 4 })
  assert.equal(p.canRetry, false)
  assert.doesNotMatch(p.message, /retry safely/i)
  assert.match(p.message, /archived/i)
  // The issue line must not promise a retry either.
  assert.doesNotMatch(p.issue ?? '', /you can retry/i)
  // History is still shown — blocked, not erased.
  assert.equal(p.blocked, true)
})

// ── Ineligible update statuses ───────────────────────────────────────────────

test('every non-approved update status blocks retry (archived, rejected, deployed, present, superseded)', () => {
  for (const status of ['archived', 'rejected', 'fully_deployed', 'already_present', 'superseded', 'queued', 'draft', 'unknown-future-status']) {
    const e = retryEligibility({ ...UPD_1004_JOB, attemptCount: 0, updateStatus: status })
    assert.equal(e.ok, false, `${status} must not be retryable`)
    assert.equal(e.ok === false && e.reason, 'update_not_retryable')
  }
})

test('a missing update status fails CLOSED — never offer a retry we cannot justify', () => {
  assert.equal(retryEligibility({ ...UPD_1004_JOB, attemptCount: 0, updateStatus: undefined }).ok, false)
  assert.equal(retryEligibility({ ...UPD_1004_JOB, attemptCount: 0, updateStatus: null }).ok, false)
  assert.equal(mapJobToProgress('failed', { hasJob: true, failureCategory: 'apply_failed' }).canRetry, false)
})

// ── Valid retries still work ─────────────────────────────────────────────────

test('an approved update with a retryable job CAN still retry — the fix is not a blanket block', () => {
  for (const status of APPROVED_STATUSES) {
    const e = retryEligibility({ jobStatus: 'failed', failureCategory: 'apply_failed', updateStatus: status, attemptCount: 0 })
    assert.equal(e.ok, true, `${status} should permit retry`)
  }
  const p = mapJobToProgress('build_failed', { hasJob: true, updateStatus: 'approved', failureCategory: 'build_failed', attemptCount: 1 })
  assert.equal(p.canRetry, true)
  assert.match(p.message, /retry safely/i)
})

test('job-side policy is unchanged: drift and merge conflicts are still never retryable', () => {
  for (const cat of ['commit_drift', 'merge_conflict']) {
    const e = retryEligibility({ jobStatus: 'failed', failureCategory: cat, updateStatus: 'approved', attemptCount: 0 })
    assert.equal(e.ok, false)
    assert.equal(e.ok === false && e.reason, 'job_not_retryable')
  }
  // A healthy job is not retryable either.
  assert.equal(retryEligibility({ jobStatus: 'preview_ready', updateStatus: 'approved' }).ok, false)
})

// ── Ceiling ──────────────────────────────────────────────────────────────────

test('owner retries are bounded — they used to be unlimited', () => {
  const at = (n: number) => retryEligibility({ jobStatus: 'failed', failureCategory: 'apply_failed', updateStatus: 'approved', attemptCount: n })
  assert.equal(at(MAX_OWNER_RETRIES - 1).ok, true)
  const capped = at(MAX_OWNER_RETRIES)
  assert.equal(capped.ok, false)
  assert.equal(capped.ok === false && capped.reason, 'retry_limit_reached')
  assert.equal(at(MAX_OWNER_RETRIES + 99).ok, false)
})

// ── One policy, shared ───────────────────────────────────────────────────────

test('the UI and the dispatcher read the SAME approval list (no duplicated policy)', () => {
  // If someone adds a status to APPROVED_STATUSES, retry must accept it automatically —
  // that is the point of importing the list rather than restating it.
  for (const status of APPROVED_STATUSES) {
    assert.equal(retryEligibility({ jobStatus: 'failed', failureCategory: 'apply_failed', updateStatus: status, attemptCount: 0 }).ok, true)
    assert.equal(mapJobToProgress('failed', { hasJob: true, updateStatus: status, failureCategory: 'apply_failed', attemptCount: 0 }).canRetry, true)
  }
  // And a status outside it must be refused by both.
  assert.equal(retryEligibility({ ...UPD_1004_JOB, updateStatus: 'archived' }).ok, false)
  assert.equal(mapJobToProgress('failed', { hasJob: true, updateStatus: 'archived', failureCategory: 'apply_failed', attemptCount: 4 }).canRetry, false)
})

// ── The dispatcher itself (not just the pure helper) ─────────────────────────

test('retryPreview REFUSES an archived update: no dispatch, and attemptCount is unchanged', async () => {
  const bizId = 'retry-policy-biz'
  await saveBusiness({
    recordVersion: 1, id: bizId, name: 'Target Co', slug: 'targetco', status: 'active', role: 'target',
    defaultBranch: 'main', releaseChannel: 'beta', updatePolicy: 'owner_approval', updatesPaused: false,
    manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy', configurationStatus: 'ready',
    githubInstallationId: '123', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'targetco', repoName: 'ratchetnu/targetco',
    automationWorkflowFile: 'operion-update.yml', previewProjectId: 'prj_x', previewDeploymentProvider: 'vercel',
    currentVersion: 'v0.1.0', currentCommit: 'live1', createdAt: 1, updatedAt: 1,
  } as PlatformBusiness)
  // An ARCHIVED update, exactly like UPD-1004.
  await saveUpdate({
    recordVersion: 1, key: 'UPD-ARCHIVED', title: 'Terminal update', summary: '', type: 'feature', scope: 'platform',
    severity: 'normal', priority: 50, status: 'archived', sourceBusinessId: 'jkiss', sourceRepo: 'ratchetnu/jkissllc',
    sourceCommit: 'abc1234', validation: { tests: 'passed', build: 'passed' } as ValidationChecklist,
    createdAt: 1, updatedAt: 1,
  } as unknown as PlatformUpdate)

  const jobId = 'job-archived-retry'
  await saveJob({
    id: jobId, businessId: bizId, updateId: 'UPD-ARCHIVED', status: 'failed', currentStep: 'apply',
    failureCategory: 'apply_failed', failureSummary: 'apply step failed', attemptCount: 4,
    workBranch: 'operion/upd-archived', strategy: 'deterministic', createdAt: 1, updatedAt: 1,
  } as never)

  const before = await getJob(jobId)
  const res = await retryPreview({ jobId })

  assert.equal(res.ok, false, 'an archived update must never re-dispatch')
  assert.equal(res.reason, 'update_not_retryable')

  const after = await getJob(jobId)
  // The whole point: policy refusal must not look like an attempt.
  assert.equal(after?.attemptCount, before?.attemptCount, 'attemptCount must not increment on a policy block')
  assert.equal(after?.attemptCount, 4)
  assert.equal(after?.status, 'failed', 'job status must be untouched')
  // A real dispatch attempt through the StubProvider would have flipped this to
  // creating_branch or blocked/provider_error. Neither happened.
  assert.notEqual(after?.status, 'creating_branch')
  assert.notEqual(after?.failureCategory, 'provider_error')
})

test('blocked retries get an owner-facing sentence, never a raw reason code', () => {
  const archived = retryEligibility({ ...UPD_1004_JOB, updateStatus: 'archived' })
  const capped = retryEligibility({ jobStatus: 'failed', failureCategory: 'apply_failed', updateStatus: 'approved', attemptCount: MAX_OWNER_RETRIES })
  for (const e of [archived, capped]) {
    const msg = retryBlockedMessage(e) ?? ''
    assert.ok(msg.length > 0)
    assert.doesNotMatch(msg, /update_not_retryable|retry_limit_reached|job_not_retryable|apply_failed/)
  }
  assert.equal(retryBlockedMessage({ ok: true }), null)
})
