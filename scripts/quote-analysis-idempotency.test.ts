// ── One question, one paid analysis ─────────────────────────────────────────
//
// A vision analysis costs money. `ai/pre-analysis` already dedupes, but only inside
// ONE browser controller — a refresh, a second tab, the back button or an impatient
// double click all build a fresh controller and sail straight past it. The route's
// own contract advertised an `idempotencyKey` that nothing server-side ever read.
//
// In-memory KV emulator (the convention from applicant-submission-idempotency).
// No network, no provider.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://quote-idem.test'
process.env.KV_REST_API_TOKEN = 'test-token'

const kv = new Map<string, string>()

globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const [rawCommand, ...args] = JSON.parse(String(init?.body)) as string[]
  const command = rawCommand.toUpperCase()
  let result: unknown = null
  if (command === 'GET') result = kv.get(args[0]) ?? null
  else if (command === 'SET') {
    if (args.map(x => String(x).toUpperCase()).includes('NX') && kv.has(args[0])) result = null
    else { kv.set(args[0], args[1]); result = 'OK' }
  } else if (command === 'DEL') { result = kv.delete(args[0]) ? 1 : 0 }
  else if (command === 'EXPIRE') { result = kv.has(args[0]) ? 1 : 0 }
  return new Response(JSON.stringify({ result }), { status: 200 })
}) as typeof fetch

// Static import is safe: redis.ts reads KV_REST_API_URL lazily inside each call,
// not at module scope, so the env assignments above are already in effect.
import {
  analysisFingerprint, claimAnalysis, completeAnalysis, releaseAnalysis,
} from '../app/lib/ai/quote-analysis-idempotency'

const PHOTOS = ['https://blob.test/a.jpg', 'https://blob.test/b.jpg']
const req = { photoUrls: PHOTOS, service: 'junk-removal' }

test('the fingerprint identifies the QUESTION, not the request', () => {
  const base = analysisFingerprint(req)
  // Order must not matter — the same photos dragged in a different order is the same
  // question, and paying twice for it is exactly the waste this prevents.
  assert.equal(analysisFingerprint({ ...req, photoUrls: [...PHOTOS].reverse() }), base)
  // Anything that changes the prompt changes the answer, so it must change the key.
  assert.notEqual(analysisFingerprint({ ...req, service: 'estate-cleanout' }), base)
  assert.notEqual(analysisFingerprint({ ...req, debris: 'concrete' }), base)
  assert.notEqual(analysisFingerprint({ ...req, photoUrls: [...PHOTOS, 'https://blob.test/c.jpg'] }), base)
})

test('the fingerprint leaks nothing about the customer', () => {
  const fp = analysisFingerprint(req)
  assert.match(fp, /^[0-9a-f]{32}$/, 'an opaque digest, not a reconstructable key')
  for (const url of PHOTOS) assert.ok(!fp.includes(url))
})

test('the first caller wins and may spend; the second is told to wait', async () => {
  kv.clear()
  const fp = analysisFingerprint({ ...req, service: 'first-wins' })
  assert.deepEqual(await claimAnalysis(fp, 'analysis-1'), { state: 'free' }, 'winner may call the provider')
  assert.deepEqual(
    await claimAnalysis(fp, 'analysis-2'),
    { state: 'pending', analysisId: 'analysis-1' },
    'the loser learns WHOSE answer is coming, so it can wait rather than buy a second',
  )
})

test('a completed analysis is reused, not repurchased', async () => {
  kv.clear()
  const fp = analysisFingerprint({ ...req, service: 'reuse' })
  await claimAnalysis(fp, 'analysis-1')
  await completeAnalysis(fp, 'analysis-1')
  assert.deepEqual(await claimAnalysis(fp, 'analysis-2'), { state: 'done', analysisId: 'analysis-1' })
})

test('a FAILED analysis releases the claim so a retry can try again', async () => {
  kv.clear()
  const fp = analysisFingerprint({ ...req, service: 'retry' })
  await claimAnalysis(fp, 'analysis-1')
  await releaseAnalysis(fp)
  // Caching a failure would turn one bad minute into a bad day: the customer's own
  // retry IS the recovery path, so it must not be locked out for the 24h done-TTL.
  assert.deepEqual(await claimAnalysis(fp, 'analysis-2'), { state: 'free' })
})

test('a different photo set is a different question and proceeds independently', async () => {
  kv.clear()
  const a = analysisFingerprint({ photoUrls: ['https://blob.test/x.jpg'], service: 'junk-removal' })
  const b = analysisFingerprint({ photoUrls: ['https://blob.test/y.jpg'], service: 'junk-removal' })
  assert.deepEqual(await claimAnalysis(a, 'a1'), { state: 'free' })
  assert.deepEqual(await claimAnalysis(b, 'b1'), { state: 'free' }, 'one customer never blocks another')
})

test('a store outage fails OPEN — a Redis blip must not cost a quote', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('kv down') }) as typeof fetch
  try {
    // A rare duplicate analysis costs cents. A refused quote costs the job.
    assert.deepEqual(await claimAnalysis('whatever', 'a1'), { state: 'free' })
    await completeAnalysis('whatever', 'a1')   // must not throw
    await releaseAnalysis('whatever')          // must not throw
  } finally { globalThis.fetch = saved }
})

test('a corrupt marker is treated as free rather than wedging the key', async () => {
  kv.clear()
  const fp = analysisFingerprint({ ...req, service: 'corrupt' })
  kv.set(`qa:idem:${fp}`, 'nonsense-without-a-colon')
  assert.deepEqual(await claimAnalysis(fp, 'a1'), { state: 'free' })
})
