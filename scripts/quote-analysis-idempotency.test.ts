// ── One question, one paid analysis — proven by playing the races out ────────
//
// A vision analysis costs money. `ai/pre-analysis` dedupes only inside ONE browser
// controller; a refresh, a second tab, the back button or a double click all build a
// fresh controller and sail past it. The route's own contract advertised an
// `idempotencyKey` that nothing server-side ever read.
//
// These tests drive the real helpers against an executable store emulator that runs
// the ACTUAL Lua bodies from app/lib/kv-lock.ts (see scripts/kv-emulator.ts). That
// matters: a source-text test cannot tell a conditional transition from an
// unconditional one, so the precise bug the Lua exists to prevent would pass it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createKvEmulator } from './kv-emulator'

process.env.KV_REST_API_URL = 'http://quote-idem.test'
process.env.KV_REST_API_TOKEN = 'test-token'

const kv = createKvEmulator()
kv.install()

import {
  analysisFingerprint, claimAnalysis, completeAnalysis, releaseAnalysis, discardStaleDone,
  ANALYSIS_DONE_TTL_MS, ANALYSIS_PENDING_TTL_MS,
} from '../app/lib/ai/quote-analysis-idempotency'

const PHOTOS = ['https://blob.test/a.jpg', 'https://blob.test/b.jpg']
const req = { photoUrls: PHOTOS, service: 'junk-removal' }
const fpFor = (s: string) => analysisFingerprint({ ...req, service: s })
const marker = (fp: string) => `qa:idem:${fp}`

// ── The fingerprint ─────────────────────────────────────────────────────────

test('the fingerprint identifies the QUESTION, not the request', () => {
  const base = analysisFingerprint(req)
  assert.equal(analysisFingerprint({ ...req, photoUrls: [...PHOTOS].reverse() }), base, 'photo order is not part of the question')
  assert.notEqual(analysisFingerprint({ ...req, service: 'estate-cleanout' }), base)
  assert.notEqual(analysisFingerprint({ ...req, debris: 'concrete' }), base)
  assert.notEqual(analysisFingerprint({ ...req, photoUrls: [...PHOTOS, 'https://blob.test/c.jpg'] }), base)
})

test('the fingerprint leaks no customer data and no readable photo URL', () => {
  const fp = analysisFingerprint(req)
  assert.match(fp, /^[0-9a-f]{32}$/)
  for (const url of PHOTOS) assert.ok(!fp.includes(url))
})

test('NUL-separated fields cannot be rearranged into a collision', () => {
  // Without a separator that cannot occur in the inputs, ('ab','c') and ('a','bc')
  // would hash identically and two different questions would share one claim.
  const a = analysisFingerprint({ photoUrls: [], service: 'ab', debris: 'c' })
  const b = analysisFingerprint({ photoUrls: [], service: 'a', debris: 'bc' })
  assert.notEqual(a, b)
})

// ── Ownership ───────────────────────────────────────────────────────────────

test('the first caller acquires; the second is told who holds it', async () => {
  kv.clear()
  const fp = fpFor('first-wins')
  assert.deepEqual(await claimAnalysis(fp, 'a1'), { state: 'acquired' })
  assert.deepEqual(await claimAnalysis(fp, 'a2'), { state: 'pending', analysisId: 'a1' })
})

test('the claim is written with the pending TTL, and completion re-arms the done TTL atomically', async () => {
  kv.clear()
  const fp = fpFor('ttl')
  await claimAnalysis(fp, 'a1')
  assert.equal(kv.peek(marker(fp)), 'pending:a1')
  assert.equal(kv.ttlMs(marker(fp)), ANALYSIS_PENDING_TTL_MS)

  assert.equal(await completeAnalysis(fp, 'a1'), true)
  assert.equal(kv.peek(marker(fp)), 'done:a1')
  // The TTL arrives in the SAME atomic step as the value. An unconditional SET
  // followed by a separate EXPIRE could leave `done` carrying the 90s pending TTL —
  // or none — if the process died between the two calls.
  assert.equal(kv.ttlMs(marker(fp)), ANALYSIS_DONE_TTL_MS)
  const casCalls = kv.commands.filter(c => c === 'EVAL:cas').length
  assert.ok(casCalls >= 1, 'completion goes through compare-and-set')
  assert.equal(kv.commands.includes('EXPIRE'), false, 'never a separate EXPIRE step')
})

test('a completed analysis is reused, not repurchased', async () => {
  kv.clear()
  const fp = fpFor('reuse')
  await claimAnalysis(fp, 'a1')
  await completeAnalysis(fp, 'a1')
  assert.deepEqual(await claimAnalysis(fp, 'a2'), { state: 'done', analysisId: 'a1' })
})

test('a FAILED analysis releases the claim so a retry can proceed', async () => {
  kv.clear()
  const fp = fpFor('retry')
  await claimAnalysis(fp, 'a1')
  assert.equal(await releaseAnalysis(fp, 'a1'), true)
  assert.equal(kv.peek(marker(fp)), null)
  assert.deepEqual(await claimAnalysis(fp, 'a2'), { state: 'acquired' })
})

// ── The adversarial races ───────────────────────────────────────────────────

test('an OLD request cannot complete a NEWER request\'s claim', async () => {
  kv.clear()
  const fp = fpFor('stale-complete')
  // A1 claims, then stalls past its 90s lease.
  await claimAnalysis(fp, 'a1')
  kv.advance(ANALYSIS_PENDING_TTL_MS + 1)
  // A2 takes the now-free key.
  assert.deepEqual(await claimAnalysis(fp, 'a2'), { state: 'acquired' })
  // A1 finally finishes and tries to publish. It must NOT win: publishing would
  // point this question at A1's analysis while A2 is still working on it.
  assert.equal(await completeAnalysis(fp, 'a1'), false)
  assert.equal(kv.peek(marker(fp)), 'pending:a2', "A2's claim is intact")
})

test('an OLD request cannot release a NEWER request\'s claim', async () => {
  kv.clear()
  const fp = fpFor('stale-release')
  await claimAnalysis(fp, 'a1')
  kv.advance(ANALYSIS_PENDING_TTL_MS + 1)
  await claimAnalysis(fp, 'a2')
  // The classic lock bug: A1's unconditional DEL would erase A2's claim, and a third
  // request would then start yet another paid analysis.
  assert.equal(await releaseAnalysis(fp, 'a1'), false)
  assert.equal(kv.peek(marker(fp)), 'pending:a2', "A2's claim survives A1's release")
})

test('an OLD request cannot delete a NEWER done marker', async () => {
  kv.clear()
  const fp = fpFor('stale-done')
  await claimAnalysis(fp, 'a1')
  await completeAnalysis(fp, 'a1')
  // A newer analysis republished the marker in the meantime.
  kv.set(marker(fp), 'done:a2', ANALYSIS_DONE_TTL_MS)
  assert.equal(await discardStaleDone(fp, 'a1'), false, 'compare-and-delete refuses a value we did not write')
  assert.equal(kv.peek(marker(fp)), 'done:a2')
})

test('two concurrent callers produce exactly one owner', async () => {
  kv.clear()
  const fp = fpFor('concurrent')
  const [c1, c2] = await Promise.all([claimAnalysis(fp, 'a1'), claimAnalysis(fp, 'a2')])
  const acquired = [c1, c2].filter(c => c.state === 'acquired')
  assert.equal(acquired.length, 1, 'exactly one caller may call the provider')
  const other = [c1, c2].find(c => c.state !== 'acquired')!
  assert.equal(other.state, 'pending')
})

test('a stale done marker is reclaimable after being retired', async () => {
  kv.clear()
  const fp = fpFor('repair')
  await claimAnalysis(fp, 'a1')
  await completeAnalysis(fp, 'a1')
  // The draft behind it is gone. Retire that exact marker, then re-compete.
  assert.equal(await discardStaleDone(fp, 'a1'), true)
  assert.equal(kv.peek(marker(fp)), null)
  assert.deepEqual(await claimAnalysis(fp, 'a2'), { state: 'acquired' })
})

// ── Store failure must not masquerade as ownership ──────────────────────────

test('a store outage reports `unavailable`, never `acquired`', async () => {
  kv.clear()
  kv.failNext(0)
  try {
    const c = await claimAnalysis('whatever', 'a1')
    // Fail-open: the request proceeds. But it owns NOTHING, and saying so is the
    // point — `acquired` here would license publishing a done marker we never earned.
    assert.deepEqual(c, { state: 'unavailable' })
  } finally { kv.stopFailing() }
})

test('completion and release are no-ops we can safely attempt during an outage', async () => {
  kv.clear()
  kv.failNext(0)
  try {
    assert.equal(await completeAnalysis('x', 'a1'), false)
    assert.equal(await releaseAnalysis('x', 'a1'), false)
    assert.equal(await discardStaleDone('x', 'a1'), false)
  } finally { kv.stopFailing() }
})

test('a corrupt marker is treated as absent rather than wedging the key', async () => {
  kv.clear()
  const fp = fpFor('corrupt')
  kv.set(marker(fp), 'nonsense-without-a-colon', ANALYSIS_PENDING_TTL_MS)
  // Unparseable state must not be mistaken for a claim; the caller retakes the key.
  const c = await claimAnalysis(fp, 'a1')
  assert.equal(c.state === 'acquired' || c.state === 'unavailable', true)
})
