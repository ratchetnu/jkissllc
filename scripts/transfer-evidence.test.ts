// Transfer evidence persistence (§4 #7) — closing the audit-trail gap.
//
// The manifest builder decided everything and stored none of it: `targetBaseCommit`,
// the excluded paths, the drift/closure/symbol-checked paths were computed, handed to
// the CI runner, and discarded. The runner's own record is counts-only BY DESIGN, and
// the signed callback reports `filesApplied: 41` with no list — which is why
// reconstructing UPD-1004 for issue #48 required sweeping every ref in git history.
//
// Two layers are tested for two different reasons:
//   • the PURE shaping (evidence.ts), because "never stores contents or secrets" and
//     "truncation is never silent" are properties of the record's shape and can be
//     asserted exhaustively with no provider and no network;
//   • the REAL manifest route against an in-memory Upstash fake, because "a refusal
//     still leaves a record" and "a store outage still returns the manifest" are
//     properties of the handler and nothing else can prove them.
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import crypto from 'node:crypto'

// Must be set before any handler runs; redis.ts reads env lazily.
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.OPERION_AUTOMATION_ENABLED = 'true'
process.env.OPERION_CALLBACK_SECRET = 'test-callback-secret'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
/** Set by a test to make matching writes fail — the store-outage case. */
let failWritesMatching: RegExp | null = null
/** Every key a PEXPIRE was applied to, so TTL coverage can be asserted. */
const expired: string[] = []

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  const upper = String(cmd).toUpperCase()
  if (failWritesMatching && failWritesMatching.test(String(key)) && (upper === 'SET' || upper === 'PEXPIRE')) {
    return { ok: true, json: async () => ({ error: 'simulated store outage' }) }
  }
  let result: unknown = null
  switch (upper) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREVRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1); break
    }
    case 'PEXPIRE': expired.push(key); result = 1; break
    case 'SET_NX_PX': case 'EVAL': case 'EXPIRE': result = 1; break
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { POST as manifestPOST } from '../app/api/automation/manifest/route'
import { saveJob, getJob, saveTransferEvidence, getTransferEvidence } from '../app/lib/platform/automation/store'
import { saveBusiness, saveCompat } from '../app/lib/platform/updates/store'
import { buildTransferEvidence, buildRefusalEvidence, boundList } from '../app/lib/platform/automation/evidence'
import {
  AUTOMATION_JOB_VERSION, TRANSFER_EVIDENCE_VERSION, EVIDENCE_MAX_PATHS, EVIDENCE_TTL_MS,
  type UpdateAutomationJob, type TransferEvidence, type EvidenceTruncation,
} from '../app/lib/platform/automation/types'
import { buildCommitTransferManifest, type BuiltManifest } from '../app/lib/platform/automation/manifest-builder'
import type { PlatformBusiness, UpdateCompatibility } from '../app/lib/platform/updates/types'
import { sha256 } from '../app/lib/platform/automation/manifest'

const T = 1_700_000_000_000
const JOB_ID = 'AUTO-evidence-test'
const COMMON = { jobId: JOB_ID, attempt: 0, sourceCommit: 'source-new', now: T }

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SECRET_BODY = 'SUPER_SECRET_FILE_BODY_DO_NOT_STORE'
function mkBuilt(p: Partial<BuiltManifest> = {}): BuiltManifest {
  const body = `export const token = '${SECRET_BODY}'\n`
  return {
    manifest: {
      updateKey: 'UPD-TEST', sourceRepo: 'ratchetnu/jkissllc', sourceCommit: 'source-new',
      entries: [{ path: 'app/lib/new.ts', action: 'add', sha256: sha256(body) }],
    },
    contents: { 'app/lib/new.ts': { contentBase64: Buffer.from(body).toString('base64'), sha256: sha256(body) } },
    excludedPaths: ['app/lib/company.ts'],
    driftCheckedPaths: ['app/lib/new.ts'],
    targetBaseCommit: 'target-pinned-sha',
    closureCheckedPaths: ['app/lib/new.ts'],
    symbolCheckedPaths: ['app/lib/dep.ts'],
    skippedModules: [{ module: 'app/lib/barrel.ts', reason: 're-export barrel (export *)' }],
    ...p,
  } as BuiltManifest
}

function mkJob(p: Partial<UpdateAutomationJob> = {}): UpdateAutomationJob {
  return {
    jobVersion: AUTOMATION_JOB_VERSION, id: JOB_ID, updateId: 'UPD-TEST', businessId: 'supercharged',
    mode: 'manual_prompt', strategy: 'commit_transfer', status: 'creating_branch', currentStep: 'branch',
    attemptCount: 0, idempotencyKey: 'auto:supercharged:UPD-TEST:source-new',
    sourceRepository: 'ratchetnu/jkissllc', sourceCommit: 'source-new',
    targetRepository: 'ratchetnu/supercharged', baseBranch: 'main', workBranch: 'operion/upd-test',
    createdAt: T, updatedAt: T, ...p,
  }
}
function mkBiz(): PlatformBusiness {
  return {
    recordVersion: 1, id: 'supercharged', name: 'SC', slug: 'sc', status: 'active', role: 'target',
    defaultBranch: 'main', releaseChannel: 'beta', updatePolicy: 'owner_approval', updatesPaused: false,
    manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy', configurationStatus: 'ready',
    githubInstallationId: '123', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'supercharged',
    automationWorkflowFile: 'operion-update.yml', previewProjectId: 'prj_x', previewDeploymentProvider: 'vercel',
    createdAt: T, updatedAt: T,
  } as PlatformBusiness
}

function signedManifestRequest(jobId: string): NextRequest {
  const body = JSON.stringify({ jobId })
  const ts = String(Date.now())
  const sig = crypto.createHmac('sha256', 'test-callback-secret').update(`${ts}.${body}`).digest('hex')
  return new NextRequest('http://localhost/api/automation/manifest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-operion-timestamp': ts, 'x-operion-signature': sig },
    body,
  })
}

async function seed(job: UpdateAutomationJob = mkJob()): Promise<void> {
  await saveJob(job)
  await saveBusiness(mkBiz())
  await saveCompat({ recordVersion: 1, updateKey: 'UPD-TEST', businessId: 'supercharged', status: 'compatible', createdAt: T, updatedAt: T } as UpdateCompatibility)
}

beforeEach(() => { kv.clear(); zsets.clear(); expired.length = 0; failWritesMatching = null })

// ── Pure shaping: what a successful build records ────────────────────────────

test('a built manifest records every list, the pinned target commit, and the true entry count', () => {
  const e = buildTransferEvidence(mkBuilt(), COMMON)
  assert.equal(e.outcome, 'built')
  assert.equal(e.evidenceVersion, TRANSFER_EVIDENCE_VERSION)
  assert.equal(e.jobId, JOB_ID)
  assert.equal(e.recordedAt, T)
  assert.equal(e.targetBaseCommit, 'target-pinned-sha')
  assert.equal(e.sourceCommit, 'source-new')
  assert.equal(e.manifestEntryCount, 1)
  assert.deepEqual(e.manifestPaths, ['app/lib/new.ts'])
  assert.deepEqual(e.excludedPaths, ['app/lib/company.ts'])
  assert.deepEqual(e.driftCheckedPaths, ['app/lib/new.ts'])
  assert.deepEqual(e.closureCheckedPaths, ['app/lib/new.ts'])
  assert.deepEqual(e.symbolCheckedPaths, ['app/lib/dep.ts'])
  assert.equal(e.truncated, undefined, 'nothing dropped ⇒ no truncation key at all')
})

// ── skippedModules: what the symbol gate knowingly did NOT verify ────────────

test('skippedModules is captured with its reasons — the fail-open record', () => {
  const e = buildTransferEvidence(mkBuilt({
    symbolCheckedPaths: ['app/lib/dep.ts'],
    skippedModules: [
      { module: 'app/lib/barrel.ts', reason: 're-export barrel (export *)' },
      { module: 'app/lib/legacy.d.ts', reason: 'declaration file' },
      { module: 'app/lib/cjs.ts', reason: 'CommonJS module.exports' },
    ],
  }), COMMON)
  assert.deepEqual(e.skippedModules, [
    { module: 'app/lib/barrel.ts', reason: 're-export barrel (export *)' },
    { module: 'app/lib/legacy.d.ts', reason: 'declaration file' },
    { module: 'app/lib/cjs.ts', reason: 'CommonJS module.exports' },
  ], 'module AND reason survive — the reason is the whole point of the field')
  // Checked and skipped together are the complete account of the gate's decision.
  assert.deepEqual(e.symbolCheckedPaths, ['app/lib/dep.ts'])
  assert.equal(e.truncated?.skippedModules, undefined, 'a short list is not reported as truncated')
})

test('an empty skippedModules list is preserved as empty — "nothing skipped" is a real answer', () => {
  const e = buildTransferEvidence(mkBuilt({ skippedModules: [] }), COMMON)
  assert.deepEqual(e.skippedModules, [], 'distinct from absent; the gate analysed everything it looked at')
})

test('skippedModules is bounded and its truncation is accounted for', () => {
  const many = Array.from({ length: EVIDENCE_MAX_PATHS + 12 }, (_, i) => ({
    module: `app/lib/skip${i}.ts`, reason: 'no recognisable export form',
  }))
  const e = buildTransferEvidence(mkBuilt({ skippedModules: many }), COMMON)
  assert.equal(e.skippedModules?.length, EVIDENCE_MAX_PATHS, 'capped like every other list')
  assert.equal(e.truncated?.skippedModules, 12, 'the dropped count is recorded, never silent')
  assert.deepEqual(e.skippedModules?.[0], { module: 'app/lib/skip0.ts', reason: 'no recognisable export form' })
  assert.equal(e.truncated?.symbolCheckedPaths, undefined, 'lists that fit are untouched')
})

test('boundList bounds object lists exactly as it bounds path lists', () => {
  const t: EvidenceTruncation = {}
  const pairs = [{ module: 'a.ts', reason: 'r' }, { module: 'b.ts', reason: 'r' }, { module: 'c.ts', reason: 'r' }]
  assert.deepEqual(boundList(pairs, 'skippedModules', t, 2), pairs.slice(0, 2))
  assert.equal(t.skippedModules, 1)
  assert.equal(boundList(undefined, 'skippedModules', t), undefined)
})

test('THE SAFETY PROPERTY: no file contents, no content hashes, no secrets reach the record', () => {
  const raw = JSON.stringify(buildTransferEvidence(mkBuilt(), COMMON))
  assert.ok(!raw.includes(SECRET_BODY), 'no file body')
  assert.ok(!raw.includes('contentBase64'), 'no base64 payload')
  assert.ok(!raw.includes(sha256(`export const token = '${SECRET_BODY}'\n`)), 'no content hash')
  assert.ok(!raw.includes('test-callback-secret'), 'no signing secret')
  assert.ok(!raw.includes('test-token'), 'no store token')
  // Belt and braces: the record's own keys are a closed, reviewed set.
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
    'attempt', 'closureCheckedPaths', 'driftCheckedPaths', 'evidenceVersion', 'excludedPaths',
    'jobId', 'manifestEntryCount', 'manifestPaths', 'outcome', 'recordedAt', 'skippedModules',
    'sourceCommit', 'symbolCheckedPaths', 'targetBaseCommit',
  ])
})

test('skipped-module reasons are static gate vocabulary, never file content', () => {
  // The reasons come from a fixed set in exports.ts, so they cannot leak target bytes.
  const e = buildTransferEvidence(mkBuilt({
    skippedModules: [{ module: 'app/lib/barrel.ts', reason: 're-export barrel (export *)' }],
  }), COMMON)
  const raw = JSON.stringify(e)
  assert.ok(!raw.includes(SECRET_BODY))
  assert.ok(!raw.includes('contentBase64'))
  for (const s of e.skippedModules ?? []) {
    assert.ok(s.reason.length < 80, 'a reason is a short label, not a payload')
  }
})

test('a refusal records the reason and claims no manifest fields', () => {
  const e = buildRefusalEvidence('dependency closure failed — the target is missing 2 required modules', COMMON)
  assert.equal(e.outcome, 'refused')
  assert.match(e.failureReason ?? '', /dependency closure failed/)
  assert.equal(e.targetBaseCommit, undefined)
  assert.equal(e.manifestPaths, undefined)
  assert.equal(e.manifestEntryCount, undefined)
})

test('a very long refusal reason is capped like failureSummary', () => {
  const e = buildRefusalEvidence('x'.repeat(5000), COMMON)
  assert.equal(e.failureReason?.length, 2000)
})

// ── Bounded, and never silently so ───────────────────────────────────────────

test('truncation reports the dropped count and preserves the true total', () => {
  const many = Array.from({ length: EVIDENCE_MAX_PATHS + 37 }, (_, i) => `app/lib/f${i}.ts`)
  const built = mkBuilt({
    manifest: { updateKey: 'U', sourceRepo: 'r', sourceCommit: 'c', entries: many.map((p) => ({ path: p, action: 'add' as const })) },
    driftCheckedPaths: many,
  })
  const e = buildTransferEvidence(built, COMMON)
  assert.equal(e.manifestEntryCount, EVIDENCE_MAX_PATHS + 37, 'the real size survives even when the list does not')
  assert.equal(e.manifestPaths?.length, EVIDENCE_MAX_PATHS)
  assert.equal(e.truncated?.manifestPaths, 37)
  assert.equal(e.driftCheckedPaths?.length, EVIDENCE_MAX_PATHS)
  assert.equal(e.truncated?.driftCheckedPaths, 37)
  assert.equal(e.truncated?.excludedPaths, undefined, 'lists that fit are not reported as truncated')
})

test('boundList passes short lists through untouched and leaves undefined undefined', () => {
  const t: EvidenceTruncation = {}
  assert.deepEqual(boundList(['a', 'b'], 'manifestPaths', t), ['a', 'b'])
  assert.equal(boundList(undefined, 'manifestPaths', t), undefined)
  assert.deepEqual(t, {})
  assert.deepEqual(boundList(['a', 'b', 'c'], 'manifestPaths', t, 2), ['a', 'b'])
  assert.equal(t.manifestPaths, 1)
})

// ── Store round-trip + retention ─────────────────────────────────────────────

test('evidence round-trips through its own key family and carries a TTL', async () => {
  const e = buildTransferEvidence(mkBuilt(), COMMON)
  await saveTransferEvidence(e)
  assert.deepEqual(await getTransferEvidence(JOB_ID), e)
  assert.ok(expired.some((k) => k.includes(`platform:autoev:${JOB_ID}`)), 'retention is bounded by TTL')
  assert.equal(EVIDENCE_TTL_MS, 90 * 24 * 60 * 60_000)
  assert.ok([...kv.keys()].some((k) => k.includes('platform:autoev:')), 'stored off the job key family')
})

test('unknown job id reads back null rather than throwing', async () => {
  assert.equal(await getTransferEvidence('AUTO-does-not-exist'), null)
})

test('an evidence record from a future version reads without throwing', async () => {
  await saveTransferEvidence({ evidenceVersion: 99, recordedAt: T, jobId: JOB_ID, attempt: 0, outcome: 'built' } as TransferEvidence)
  assert.equal((await getTransferEvidence(JOB_ID))?.evidenceVersion, 99)
})

// ── Backward compatibility ───────────────────────────────────────────────────

test('a job written before this feature reads back unchanged, with no evidence', async () => {
  const legacy = mkJob()
  delete (legacy as Partial<UpdateAutomationJob>).transferEvidenceAt
  await saveJob(legacy)
  const back = await getJob(JOB_ID)
  assert.ok(back)
  assert.equal(back.transferEvidenceAt, undefined)
  assert.equal(back.status, 'creating_branch')
  assert.equal(back.jobVersion, AUTOMATION_JOB_VERSION, 'no version bump — the field is additive and optional')
  assert.equal(await getTransferEvidence(JOB_ID), null)
})

// ── What the CI runner actually receives ─────────────────────────────────────
//
// The manifest route answers `{ jobId, ...built.data }`, so EVERY field added to
// `BuiltManifest` is also handed to the runner over the wire. That is easy to miss:
// `symbolCheckedPaths` (PR #55) and `skippedModules` (this PR) each widened that
// payload as a side effect of adding builder output. Both are harmless — the runner
// destructures `{ manifest, contents, targetBaseCommit }` and ignores the rest — but
// nothing pinned the boundary, so a future field carrying something it should not
// would reach a CI runner silently. This test is that boundary.

test('the runner payload is a closed set — a new BuiltManifest field cannot widen it silently', async () => {
  const body = `export const n = 1\n`
  const mock = {
    name: 'payload-mock',
    readCommit: async (_i: string, _r: unknown, sha: string) => ({ ok: true, data: { sha, message: 'u', parentSha: 'source-parent', parentCount: 1 } }),
    readBranch: async () => ({ ok: true, data: { commit: 'target-pinned-sha' } }),
    readTree: async () => ({ ok: true, data: { paths: [] } }),
    readCommitFiles: async () => ({ ok: true, data: { files: [{ filename: 'app/lib/new.ts', status: 'added' }] } }),
    readFileContent: async (_i: string, repo: { name: string }, path: string) => (
      repo.name === 'supercharged' || path !== 'app/lib/new.ts'
        ? { ok: false, error: 'not found', category: 'not_found' }
        : { ok: true, data: { contentBase64: Buffer.from(body).toString('base64'), sha256: sha256(body) } }
    ),
  } as never

  const built = await buildCommitTransferManifest({
    provider: mock, installationId: '1',
    sourceRepo: { owner: 'ratchetnu', name: 'jkissllc' }, sourceRepoName: 'ratchetnu/jkissllc',
    sourceCommit: 'source-new', targetRepo: { owner: 'ratchetnu', name: 'supercharged' },
    targetBranch: 'main', updateKey: 'UPD-TEST', compatibility: { status: 'compatible' },
  })
  assert.equal(built.ok, true)
  if (!built.ok) return

  // Exactly what `{ jobId, ...built.data }` puts on the wire. Adding a field here is a
  // deliberate act — it changes a machine-facing contract, so it must change this list.
  assert.deepEqual(Object.keys({ jobId: 'x', ...built.data }).sort(), [
    'closureCheckedPaths', 'contents', 'driftCheckedPaths', 'excludedPaths',
    'jobId', 'manifest', 'skippedModules', 'symbolCheckedPaths', 'targetBaseCommit',
  ])
  // The three fields the runner actually consumes stay present and well-formed.
  assert.ok(Array.isArray(built.data.manifest.entries))
  assert.ok(built.data.contents['app/lib/new.ts'])
  assert.equal(built.data.targetBaseCommit, 'target-pinned-sha')
})

// ── The real route ───────────────────────────────────────────────────────────
// With no GitHub App credentials `getAutomationProvider` returns the inert StubProvider,
// so the builder refuses at its first read. That is precisely the path that previously
// stored nothing, which makes it the one worth driving end to end.

test('THE POINT: a route-level REFUSAL now leaves a record where it previously left none', async () => {
  await seed()
  const res = await manifestPOST(signedManifestRequest(JOB_ID))
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.match(body.error, /read source commit/)

  const e = await getTransferEvidence(JOB_ID)
  assert.ok(e, 'the refusal is recorded')
  assert.equal(e.outcome, 'refused')
  assert.equal(e.jobId, JOB_ID)
  assert.equal(e.sourceCommit, 'source-new')
  assert.match(e.failureReason ?? '', /read source commit/)
  assert.ok(e.recordedAt > 0)
})

test('the job gains only a timestamp marker — status and updatedAt are untouched', async () => {
  await seed()
  const before = await getJob(JOB_ID)
  await manifestPOST(signedManifestRequest(JOB_ID))
  const after = await getJob(JOB_ID)
  assert.ok(after?.transferEvidenceAt, 'marker set so a reader knows evidence exists')
  assert.equal(after?.status, before?.status, 'status untouched')
  assert.equal(after?.updatedAt, before?.updatedAt, 'updatedAt untouched — an audit write cannot reorder the index')
})

test('a retry records the newer attempt number', async () => {
  await seed(mkJob({ attemptCount: 3 }))
  await manifestPOST(signedManifestRequest(JOB_ID))
  assert.equal((await getTransferEvidence(JOB_ID))?.attempt, 3)
})

test('FAIL-SOFT: a store outage does not change the response the runner receives', async () => {
  await seed()
  const clean = await manifestPOST(signedManifestRequest(JOB_ID))
  const cleanBody = await clean.json()

  kv.clear(); zsets.clear()
  await seed()
  failWritesMatching = /autoev:/                      // every evidence write throws
  const degraded = await manifestPOST(signedManifestRequest(JOB_ID))
  const degradedBody = await degraded.json()

  assert.equal(degraded.status, clean.status, 'an audit write must never break the thing it audits')
  assert.deepEqual(degradedBody, cleanBody, 'byte-identical response with the audit store down')
  assert.equal(await getTransferEvidence(JOB_ID), null, 'and the evidence is simply absent')
})

test('existing gates are untouched: automation disabled still 403s before any evidence is written', async () => {
  await seed()
  process.env.OPERION_AUTOMATION_ENABLED = 'false'
  try {
    const res = await manifestPOST(signedManifestRequest(JOB_ID))
    assert.equal(res.status, 403)
    assert.equal(await getTransferEvidence(JOB_ID), null, 'a gated request records nothing')
  } finally { process.env.OPERION_AUTOMATION_ENABLED = 'true' }
})

test('existing gates are untouched: an unsigned request still 401s and records nothing', async () => {
  await seed()
  const res = await manifestPOST(new NextRequest('http://localhost/api/automation/manifest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: JOB_ID }),
  }))
  assert.equal(res.status, 401)
  assert.equal(await getTransferEvidence(JOB_ID), null)
})

test('an unknown job still 404s and records nothing', async () => {
  await seed()
  const res = await manifestPOST(signedManifestRequest('AUTO-nope'))
  assert.equal(res.status, 404)
  assert.equal(await getTransferEvidence('AUTO-nope'), null)
})
