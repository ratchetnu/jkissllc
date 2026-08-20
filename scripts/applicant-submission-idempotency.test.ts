import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://applicant-kv.test'
process.env.KV_REST_API_TOKEN = 'test-token'

const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
let failCommit = false
const commands: string[] = []

globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const [rawCommand, ...args] = JSON.parse(String(init?.body)) as string[]
  const command = rawCommand.toUpperCase()
  commands.push(command)
  let result: unknown = null
  if (command === 'GET') result = kv.get(args[0]) ?? null
  else if (command === 'SET') {
    if (args.map(x => x.toUpperCase()).includes('NX') && kv.has(args[0])) result = null
    else { kv.set(args[0], args[1]); result = 'OK' }
  } else if (command === 'INCR') {
    const value = Number(kv.get(args[0]) ?? 0) + 1
    kv.set(args[0], String(value)); result = value
  } else if (command === 'ZREVRANGE') {
    result = [...(zsets.get(args[0]) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(Number(args[1]), Number(args[2]) === -1 ? undefined : Number(args[2]) + 1)
      .map(([member]) => member)
  } else if (command === 'MGET') {
    result = args.map(key => kv.get(key) ?? null)
  } else if (command === 'EVAL') {
    const script = args[0]
    const keyCount = Number(args[1])
    const keys = args.slice(2, 2 + keyCount)
    const argv = args.slice(2 + keyCount)
    if (script.includes("redis.call('zadd'")) {
      if (failCommit) { failCommit = false; throw new Error('injected commit failure') }
      if (kv.get(keys[3]) !== argv[4]) result = 0
      else {
        kv.set(keys[0], argv[0]); kv.set(keys[1], argv[1])
        const z = zsets.get(keys[2]) ?? new Map<string, number>()
        z.set(argv[1], Number(argv[2])); zsets.set(keys[2], z)
        kv.set(keys[3], argv[3]); result = 1
      }
    } else {
      const owned = kv.get(keys[0]) === argv[0]
      if (owned) kv.delete(keys[0])
      result = owned ? 1 : 0
    }
  }
  return { ok: true, json: async () => ({ result }) } as Response
}) as typeof fetch

import {
  generateApplicantId, listApplicants, nextApplicantNumber, rescore, submitApplicantOnce, type Applicant,
} from '../app/lib/applicants'

function reset() { kv.clear(); zsets.clear(); failCommit = false }

async function applicant(): Promise<Applicant> {
  const now = Date.now()
  return rescore({
    id: generateApplicantId(), applicantNumber: await nextApplicantNumber(), position: 'driver',
    name: 'Ida Potent', email: 'ida@example.test', phone: '5551234567',
    skills: {}, scenarios: [], documents: [], status: 'new',
    score: {} as Applicant['score'], createdAt: now, updatedAt: now,
  })
}

test('an ambiguous retry returns the original application and number', async () => {
  reset(); let creates = 0
  const create = async () => { creates++; return applicant() }
  const first = await submitApplicantOnce('submission-1234567890123456', create)
  const retry = await submitApplicantOnce('submission-1234567890123456', create)
  assert.equal(first.ok, true); assert.equal(retry.ok, true)
  if (!first.ok || !retry.ok) return
  assert.equal(creates, 1)
  assert.equal(retry.replayed, true)
  assert.equal(retry.applicant.id, first.applicant.id)
  assert.equal(retry.applicant.applicantNumber, first.applicant.applicantNumber)
  assert.equal(zsets.get('app:index')?.size, 1)
})

test('a failed atomic commit leaves no partial applicant and permits retry', async () => {
  reset(); failCommit = true
  await assert.rejects(() => submitApplicantOnce('submission-abcdef1234567890', applicant), /injected commit failure/)
  assert.equal([...kv.keys()].some(k => /^app:[a-f0-9]{16,}$/.test(k)), false)
  assert.equal(zsets.get('app:index')?.size ?? 0, 0)
  const retry = await submitApplicantOnce('submission-abcdef1234567890', applicant)
  assert.equal(retry.ok, true)
})

test('the admin queue is uncapped and hydrates in one batch', async () => {
  reset()
  const index = new Map<string, number>()
  for (let i = 0; i < 501; i++) {
    const id = i.toString(16).padStart(16, '0')
    const record = await applicant()
    record.id = id
    kv.set(`app:${id}`, JSON.stringify(record))
    index.set(id, i)
  }
  zsets.set('app:index', index)
  commands.length = 0
  assert.equal((await listApplicants()).length, 501, 'the queue is not truncated at 500')
  // Hydration must be batched. A per-applicant GET fan-out is 501 REST round trips
  // against Upstash on every admin page load, and it was the shape this replaced.
  assert.equal(commands.filter(c => c === 'GET').length, 0, 'no per-applicant GET fan-out')
  assert.equal(commands.filter(c => c === 'MGET').length, 1, 'one batched read')
})
