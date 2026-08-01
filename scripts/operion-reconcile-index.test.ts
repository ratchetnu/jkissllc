import assert from 'node:assert/strict'
import test from 'node:test'
import type { UpdateAutomationJob } from '../app/lib/platform/automation/types'

function fakeKv() {
  const kv = new Map<string, string>()
  const z = new Map<string, { score: number; member: string }[]>()
  const old = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, fetch: globalThis.fetch }
  process.env.KV_REST_API_URL = 'http://fake-kv'; process.env.KV_REST_API_TOKEN = 'fake'
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const a = (JSON.parse(init.body) as unknown[]).map(String)
    const cmd = a[0].toUpperCase(); let result: unknown = null
    if (cmd === 'GET') result = kv.get(a[1]) ?? null
    else if (cmd === 'SET') { kv.set(a[1], a[2]); result = 'OK' }
    else if (cmd === 'ZADD') {
      const rows = (z.get(a[1]) ?? []).filter((row) => row.member !== a[3])
      rows.push({ score: Number(a[2]), member: a[3] }); z.set(a[1], rows); result = 1
    } else if (cmd === 'ZREM') {
      z.set(a[1], (z.get(a[1]) ?? []).filter((row) => row.member !== a[2])); result = 1
    } else if (cmd === 'ZRANGE' || cmd === 'ZREVRANGE') {
      const rows = [...(z.get(a[1]) ?? [])].sort((l, r) => cmd === 'ZRANGE' ? l.score - r.score : r.score - l.score)
      result = rows.slice(Number(a[2]), Number(a[3]) + 1).map((row) => row.member)
    }
    return { json: async () => ({ result }) }
  }) as never
  return {
    seedLegacy(j: UpdateAutomationJob) {
      kv.set(`platform:autojob:${j.id}`, JSON.stringify(j))
      const rows = (z.get('platform:autojob:index') ?? []).filter((row) => row.member !== j.id)
      rows.push({ score: j.updatedAt, member: j.id }); z.set('platform:autojob:index', rows)
    },
    restore() { globalThis.fetch = old.fetch; if (old.url == null) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = old.url; if (old.token == null) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = old.token },
  }
}

function job(id: string, status: UpdateAutomationJob['status'], updatedAt: number): UpdateAutomationJob {
  return {
    jobVersion: 1, id, updateId: 'UPD-1', businessId: 'supercharged', mode: 'manual',
    strategy: 'commit_transfer', status, attemptCount: 1, currentStep: 'preview',
    idempotencyKey: id, createdAt: updatedAt, updatedAt,
    ...(status === 'completed' ? { completedAt: updatedAt } : {}),
  }
}

test('reconcile index cannot starve an old active job behind newer terminal history', async () => {
  const fake = fakeKv()
  try {
    const { saveJob, listReconcileJobs } = await import('../app/lib/platform/automation/store')
    const stuck = job('AUTO-STUCK', 'preview_deploying', 1)
    // Seed the OLD key families directly: saveJob would populate the new index and make
    // this a test of writes rather than the one-time migration.
    fake.seedLegacy(stuck)
    for (let i = 0; i < 1_050; i++) fake.seedLegacy(job(`AUTO-DONE-${i}`, 'completed', i + 10))
    const candidates = await listReconcileJobs(10)
    assert.equal(candidates.some((candidate) => candidate.id === stuck.id), true,
      'oldest active work survives more candidates than the read limit')
    assert.equal(candidates.some((candidate) => candidate.id.startsWith('AUTO-DONE-')), true,
      'completed-but-unfinalized records are migrated for record reconciliation')

    stuck.status = 'completed'; stuck.recordsFinalizedAt = 2_000; stuck.updatedAt = 2_000
    await saveJob(stuck)
    assert.equal((await listReconcileJobs(10)).some((candidate) => candidate.id === stuck.id), false)
  } finally { fake.restore() }
})

test('healthy owner-review jobs do not crowd the background index', async () => {
  const fake = fakeKv()
  try {
    const { saveJob, listReconcileJobs } = await import('../app/lib/platform/automation/store')
    const healthy = { ...job('AUTO-REVIEWED', 'awaiting_owner_review', 1), pullRequestUrl: 'https://example/pr/1', previewUrl: 'https://preview.example' }
    const incomplete = { ...job('AUTO-INCOMPLETE', 'awaiting_owner_review', 2), pullRequestUrl: 'https://example/pr/2' }
    await saveJob(healthy); await saveJob(incomplete)
    const candidates = await listReconcileJobs(10)
    assert.equal(candidates.some((candidate) => candidate.id === healthy.id), false)
    assert.equal(candidates.some((candidate) => candidate.id === incomplete.id), true)
  } finally { fake.restore() }
})
