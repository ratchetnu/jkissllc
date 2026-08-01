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
  return { restore() { globalThis.fetch = old.fetch; if (old.url == null) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = old.url; if (old.token == null) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = old.token } }
}

function job(id: string, status: UpdateAutomationJob['status'], updatedAt: number): UpdateAutomationJob {
  return {
    jobVersion: 1, id, updateId: 'UPD-1', businessId: 'supercharged', mode: 'manual',
    strategy: 'commit_transfer', status, attemptCount: 1, currentStep: 'preview',
    idempotencyKey: id, createdAt: updatedAt, updatedAt,
    ...(status === 'completed' ? { completedAt: updatedAt, recordsFinalizedAt: updatedAt } : {}),
  }
}

test('reconcile index cannot starve an old active job behind newer terminal history', async () => {
  const fake = fakeKv()
  try {
    const { saveJob, listReconcileJobs } = await import('../app/lib/platform/automation/store')
    const stuck = job('AUTO-STUCK', 'preview_deploying', 1)
    await saveJob(stuck)
    for (let i = 0; i < 1_050; i++) await saveJob(job(`AUTO-DONE-${i}`, 'completed', i + 10))
    assert.equal((await listReconcileJobs(10)).some((candidate) => candidate.id === stuck.id), true)

    stuck.status = 'completed'; stuck.recordsFinalizedAt = 2_000; stuck.updatedAt = 2_000
    await saveJob(stuck)
    assert.equal((await listReconcileJobs(10)).some((candidate) => candidate.id === stuck.id), false)
  } finally { fake.restore() }
})
