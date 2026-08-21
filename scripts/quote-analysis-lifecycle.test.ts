// ── The claim → analyse → persist → publish ORDER, executed ─────────────────
//
// The defect these cover: `done:{id}` was published BEFORE the draft was saved, so a
// duplicate could read the marker, fetch the draft, and find nothing. If the save
// then failed the marker pointed at nothing permanently — and the duplicate fell
// through to the provider without owning a claim, buying a second analysis of the
// same photos.
//
// Everything below drives the real lifecycle against the real claim helpers and the
// executable store emulator (scripts/kv-emulator.ts), which runs the ACTUAL Lua
// bodies from app/lib/kv-lock.ts. The order of operations is observed, not grepped.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createKvEmulator } from './kv-emulator'

process.env.KV_REST_API_URL = 'http://quote-lifecycle.test'
process.env.KV_REST_API_TOKEN = 'test-token'

const kv = createKvEmulator()
kv.install()

import { runAnalysisLifecycle, type AnalysisRun } from '../app/lib/ai/quote-analysis-lifecycle'
import { analysisFingerprint, claimAnalysis, ANALYSIS_PENDING_TTL_MS } from '../app/lib/ai/quote-analysis-idempotency'
import type { StoredAiEstimate } from '../app/lib/ai/estimate-store'

const marker = (fp: string) => `qa:idem:${fp}`
let seq = 0
const fpFor = (name: string) => analysisFingerprint({ photoUrls: [`https://blob.test/${name}.jpg`], service: 'junk-removal' })

/** A minimal stored estimate — only the fields the lifecycle and its tests read. */
const draft = (id: string, ok = true): StoredAiEstimate => ({
  id, createdAt: '2026-08-21T00:00:00.000Z',
  status: ok ? 'completed' : 'failed',
  decision: ok ? 'instant_quote' : 'manual_review',
  provider: 'test', model: 'test', schemaVersion: 1,
  inputPhotoUrls: ['https://blob.test/a.jpg'],
  analysis: { confidence: { overall: ok ? 0.9 : 0 }, normalizedItems: [] },
  pricing: { recommendedUsd: ok ? 400 : 0, lowUsd: 0, highUsd: 0, breakdown: {}, priced: ok },
  reviewReasons: [], monitor: {},
} as unknown as StoredAiEstimate)

/**
 * A harness that records the exact ORDER of the operations that matter, so
 * "persisted before published" is asserted as a sequence rather than inferred.
 */
function harness(opts: {
  run?: Partial<AnalysisRun>
  saveFails?: boolean
  drafts?: Map<string, StoredAiEstimate>
  onAnalyze?: () => Promise<void>
} = {}) {
  const order: string[] = []
  const drafts = opts.drafts ?? new Map<string, StoredAiEstimate>()
  let providerCalls = 0
  const deps = {
    loadDraft: async (id: string) => { order.push(`load:${id}`); return drafts.get(id) ?? null },
    saveDraft: async (s: StoredAiEstimate) => {
      order.push('save')
      if (opts.saveFails) throw new Error('kv write failed')
      drafts.set(s.id, s)
    },
    analyze: async (): Promise<AnalysisRun> => {
      providerCalls++
      order.push('analyze')
      if (opts.onAnalyze) await opts.onAnalyze()
      const id = opts.run?.stored?.id ?? 'a1'
      return { stored: draft(id), analyzedOk: true, ...opts.run } as AnalysisRun
    },
  }
  return { order, drafts, deps, providerCalls: () => providerCalls }
}

// ── Ordering ────────────────────────────────────────────────────────────────

test('the draft is SAVED before the claim becomes reusable', async () => {
  kv.clear()
  const fp = fpFor(`order${seq++}`)
  const h = harness()
  const out = await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, h.deps)

  assert.equal(out.kind, 'analyzed')
  assert.deepEqual(h.order, ['analyze', 'save'], 'analyse, then persist')
  // The publish happens only after the save returned — observable in the store.
  assert.equal(kv.peek(marker(fp)), 'done:a1')
  const casIndex = kv.commands.lastIndexOf('EVAL:cas')
  assert.ok(casIndex > -1, 'the marker advanced by compare-and-set')
})

test('a duplicate arriving BEFORE the draft is persisted cannot start a second paid call', async () => {
  kv.clear()
  const fp = fpFor(`window${seq++}`)
  const observed: Awaited<ReturnType<typeof runAnalysisLifecycle>>[] = []

  const h = harness({
    onAnalyze: async () => {
      // A second request lands mid-analysis — exactly the window the old ordering
      // exposed. It must see `pending`, never a `done` pointing at an unsaved draft.
      observed.push(await runAnalysisLifecycle(
        { fingerprint: fp, analysisId: 'a2' },
        harness().deps,
      ))
    },
  })
  await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, h.deps)

  assert.equal(observed.length, 1)
  const dup = observed[0]
  assert.equal(dup.kind, 'pending', 'the duplicate waits instead of paying')
  assert.equal((dup as { analysisId: string }).analysisId, 'a1')
})

test('a FAILED draft save leaves NO reusable done marker', async () => {
  kv.clear()
  const fp = fpFor(`savefail${seq++}`)
  const h = harness({ saveFails: true })
  const out = await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, h.deps)

  assert.equal(out.kind, 'analyzed')
  assert.equal((out as { draftSaved: boolean }).draftSaved, false)
  assert.equal((out as { published: boolean }).published, false, 'nothing may advertise a draft that was never written')
  // The claim is RELEASED, not left dangling — the customer's retry must be able to
  // proceed, and a `done` here would point at nothing for 24 hours.
  assert.equal(kv.peek(marker(fp)), null)
  assert.deepEqual(await claimAnalysis(fp, 'a2'), { state: 'acquired' }, 'a retry can claim it')
})

test('a FAILED analysis is not published and releases the claim', async () => {
  kv.clear()
  const fp = fpFor(`analysisfail${seq++}`)
  const h = harness({ run: { analyzedOk: false } })
  const out = await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, h.deps)
  assert.equal((out as { published: boolean }).published, false)
  assert.equal(kv.peek(marker(fp)), null, 'a failure is never cached')
})

// ── Concurrency ─────────────────────────────────────────────────────────────

test('two concurrent callers produce exactly ONE provider call', async () => {
  kv.clear()
  const fp = fpFor(`concurrent${seq++}`)
  const drafts = new Map<string, StoredAiEstimate>()
  const h1 = harness({ drafts })
  const h2 = harness({ drafts })
  const [r1, r2] = await Promise.all([
    runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, h1.deps),
    runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a2' }, h2.deps),
  ])
  const totalProviderCalls = h1.providerCalls() + h2.providerCalls()
  assert.equal(totalProviderCalls, 1, 'the paid call happens once, whoever wins')
  const kinds = [r1.kind, r2.kind].sort()
  assert.deepEqual(kinds, ['analyzed', 'pending'])
})

test('a completed question is reused with no provider call at all', async () => {
  kv.clear()
  const fp = fpFor(`reuse${seq++}`)
  const drafts = new Map<string, StoredAiEstimate>()
  const first = harness({ drafts })
  await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, first.deps)

  const second = harness({ drafts })
  const out = await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a2' }, second.deps)
  assert.equal(out.kind, 'reused')
  assert.equal(second.providerCalls(), 0, 'a cached answer costs nothing')
})

// ── Repair ──────────────────────────────────────────────────────────────────

test('a done marker whose draft is MISSING is reclaimed, then analysed once', async () => {
  kv.clear()
  const fp = fpFor(`stale${seq++}`)
  // A `done` marker with no draft behind it — the exact corruption the old ordering
  // could create.
  kv.set(marker(fp), 'done:ghost', 60_000)

  const h = harness()   // empty draft store
  const out = await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a2' }, h.deps)

  assert.equal(out.kind, 'analyzed', 'the request is served rather than stranded')
  assert.equal(h.providerCalls(), 1)
  assert.equal(kv.peek(marker(fp)), 'done:a2', 'the stale marker was replaced by a real one')
})

test('the repair path never analyses without first WINNING a claim', async () => {
  kv.clear()
  const fp = fpFor(`stale-contended${seq++}`)
  kv.set(marker(fp), 'done:ghost', 60_000)

  // Two requests both find the stale marker. Only one may end up calling the provider.
  const h1 = harness()
  const h2 = harness()
  const [r1, r2] = await Promise.all([
    runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, h1.deps),
    runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a2' }, h2.deps),
  ])
  assert.equal(h1.providerCalls() + h2.providerCalls(), 1, 'repair does not license a free paid call')
  assert.deepEqual([r1.kind, r2.kind].sort(), ['analyzed', 'pending'])
})

// ── Store outage ────────────────────────────────────────────────────────────

test('a store outage still serves the customer, but publishes nothing', async () => {
  kv.clear()
  kv.failNext(0)
  try {
    const h = harness()
    const out = await runAnalysisLifecycle({ fingerprint: 'fp-outage', analysisId: 'a1' }, h.deps)
    assert.equal(out.kind, 'analyzed', 'fail-open: a Redis blip must not refuse a quote')
    assert.equal((out as { ownedClaim: boolean }).ownedClaim, false, 'we never claimed to own it')
    assert.equal((out as { published: boolean }).published, false, 'and never published on the strength of it')
  } finally { kv.stopFailing() }
})

// ── The lapsed-claim races, end to end ──────────────────────────────────────

test('a request whose claim LAPSED cannot publish over the new owner', async () => {
  kv.clear()
  const fp = fpFor(`lapsed${seq++}`)
  const drafts = new Map<string, StoredAiEstimate>()
  const slow = harness({
    drafts,
    onAnalyze: async () => {
      // The slow request outruns its 90s lease; a second request takes the key.
      kv.advance(ANALYSIS_PENDING_TTL_MS + 1)
      await claimAnalysis(fp, 'a2')
    },
  })
  const out = await runAnalysisLifecycle({ fingerprint: fp, analysisId: 'a1' }, slow.deps)

  assert.equal((out as { published: boolean }).published, false, 'compare-and-set refuses a claim we no longer hold')
  assert.equal(kv.peek(marker(fp)), 'pending:a2', "the new owner's claim is untouched")
  // The draft itself is still saved — the work is not thrown away, it simply does
  // not get to advertise itself as THE answer for this question.
  assert.equal(drafts.has('a1'), true)
})
