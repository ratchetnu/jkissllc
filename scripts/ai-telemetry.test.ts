// AI telemetry & cost-accounting foundation — unit tests. Exercises the whole
// telemetry substrate with an in-memory Redis fake and injected service deps: record
// schema + kind attribution, provider/version derivation, PII redaction, idempotent
// writes, fail-soft persistence, versioned cost accounting, post-hoc enrichment, and
// the read-side breakdowns the later dashboard consumes. No network, no Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TENANT_ID = 'tele-tenant.example'   // read by tenantId() at call time

import {
  recordAiCall, getAiCall, listAiCalls, updateAiCall, setAiFeedback,
  redactText, deriveProviderModel, enrichRecord,
  estimateCostUsd, estimateCostDetailed,
  type AiCallRecord, type TelemetryStore,
} from '../app/lib/ai/telemetry'
import { activeCostTable, isKnownModel, modelRate } from '../app/lib/ai/cost-tables'
import {
  kindBreakdown, providerBreakdown, callsForBooking, rateFallbackShare,
} from '../app/lib/ai/telemetry-read'
import { runAiTask, type AiTaskDeps } from '../app/lib/ai/service'
import { COMMAND_SCHEMA } from '../app/lib/ai/schema'

// ── In-memory Redis fake (implements the TelemetryStore surface) ──────────────
function memStore(): TelemetryStore & { setThrows?: boolean } {
  const kv = new Map<string, string>()
  const z = new Map<string, Map<string, number>>()
  const nx = new Set<string>()
  const slice = (arr: string[], start: number, stop: number) => arr.slice(start, stop < 0 ? undefined : stop + 1)
  const store: TelemetryStore & { setThrows?: boolean } = {
    async get(k) { return kv.has(k) ? kv.get(k)! : null },
    async set(k, v) { if (store.setThrows) throw new Error('redis down'); kv.set(k, v) },
    async del(k) { kv.delete(k) },
    async zadd(k, score, member) { let m = z.get(k); if (!m) { m = new Map(); z.set(k, m) } m.set(member, score) },
    async zrevrange(k, start, stop) { const m = z.get(k); if (!m) return []; return slice([...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]), start, stop) },
    async zrange(k, start, stop) { const m = z.get(k); if (!m) return []; return slice([...m.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]), start, stop) },
    async zrem(k, member) { z.get(k)?.delete(member) },
    async zcard(k) { return z.get(k)?.size ?? 0 },
    async setNxPx(k) { if (nx.has(k)) return false; nx.add(k); return true },
  }
  return store
}

const rec = (over: Partial<AiCallRecord> = {}): AiCallRecord => ({
  id: 'r1', at: 1000, tenantId: 'tele-tenant.example', actor: 'public', role: 'public',
  feature: 'ops.junkAnalysis', taskId: 'ops.junkAnalysis', promptVersion: 1,
  model: 'anthropic/claude-sonnet-4-6', ok: true, outcome: 'success',
  latencyMs: 200, inputTokens: 1000, outputTokens: 200, totalTokens: 1200,
  estCostUsd: 0.006, requestChars: 10, responseValid: true, ...over,
})

// ── 1. PII / secret redaction ─────────────────────────────────────────────────
test('redactText strips urls, tokens, emails, and long hashes', () => {
  assert.equal(redactText('fetch failed for https://blob.vercel-storage.com/x?token=secret123'), 'fetch failed for [url]')
  assert.match(redactText('authorization: Bearer abc.def.ghi')!, /authorization=\[redacted\]/i)
  assert.equal(redactText('key sk-ABCD1234efgh5678 leaked'), 'key [key] leaked')
  assert.equal(redactText('email jo@example.com bounced'), 'email [email] bounced')
  assert.equal(redactText('sig 0123456789abcdef0123456789abcdef'), 'sig [hash]')
  assert.equal(redactText(undefined), undefined)
  assert.ok((redactText('x'.repeat(900)) ?? '').length <= 500)   // bounded
})

// ── 2. Provider / model-version derivation ────────────────────────────────────
test('deriveProviderModel splits provider and trailing version', () => {
  assert.deepEqual(deriveProviderModel('anthropic/claude-sonnet-4-6'), { provider: 'anthropic', modelVersion: '4-6' })
  assert.deepEqual(deriveProviderModel('openai/gpt-4.1-mini-2025'), { provider: 'openai', modelVersion: '2025' })
  assert.deepEqual(deriveProviderModel('openai/gpt-4o'), { provider: 'openai', modelVersion: undefined })  // no trailing version token
  assert.deepEqual(deriveProviderModel('barecmodel'), { provider: 'vercel-ai-gateway', modelVersion: undefined })
  assert.deepEqual(deriveProviderModel(''), { provider: 'unknown' })
})

test('enrichRecord defaults kind, derives provider, redacts, stamps timestamps', () => {
  const e = enrichRecord(rec({ kind: undefined, error: 'see https://x.io/a?token=q', at: 1234 }))
  assert.equal(e.kind, 'primary')
  assert.equal(e.provider, 'anthropic')
  assert.equal(e.modelVersion, '4-6')
  assert.equal(e.error, 'see [url]')
  assert.equal(e.createdAt, 1234)
  assert.equal(e.updatedAt, 1234)
})

// ── 3. Versioned cost accounting ──────────────────────────────────────────────
test('estimateCostUsd preserves the documented per-model rates', () => {
  assert.equal(estimateCostUsd('anthropic/claude-sonnet-4-6', 1_000_000, 1_000_000), 18)  // 3 + 15
  assert.equal(estimateCostUsd('unknown/model', 1_000_000, 0), 3)                          // default in-rate
  assert.equal(estimateCostUsd('anthropic/claude-haiku-4-5', 1_000_000, 1_000_000), 6)     // 1 + 5
})

test('estimateCostDetailed reports table version and rate fallback', () => {
  const known = estimateCostDetailed('anthropic/claude-sonnet-4-6', 1000, 200)
  assert.equal(known.tableVersion, activeCostTable().version)
  assert.equal(known.rateFallback, false)
  assert.ok(known.usd > 0)
  const unknown = estimateCostDetailed('some/unlisted-model', 1000, 200)
  assert.equal(unknown.rateFallback, true)          // priced at the default rate
  assert.equal(isKnownModel('some/unlisted-model'), false)
  assert.equal(isKnownModel('anthropic/claude-sonnet-4-6'), true)
  assert.deepEqual(modelRate('some/unlisted-model'), modelRate('default'))
})

test('AI_COST_RATES_JSON env override adds a model rate live', () => {
  process.env.AI_COST_RATES_JSON = '{"acme/model-9":{"in":10,"out":20}}'
  try {
    assert.equal(isKnownModel('acme/model-9'), true)
    assert.equal(estimateCostUsd('acme/model-9', 1_000_000, 1_000_000), 30)
  } finally {
    delete process.env.AI_COST_RATES_JSON
  }
})

// ── 4. Persist + read round-trip, tenant attribution ──────────────────────────
test('recordAiCall persists an enriched record and getAiCall reads it back', async () => {
  const s = memStore()
  await recordAiCall(rec({ id: 'a1', bookingId: 'bk-1', kind: 'primary' }), s)
  const back = await getAiCall('a1', s)
  assert.ok(back)
  assert.equal(back!.bookingId, 'bk-1')
  assert.equal(back!.provider, 'anthropic')          // derived on write
  assert.equal(back!.tenantId, 'tele-tenant.example')
  assert.equal(back!.kind, 'primary')
})

// ── 5. Idempotent / duplicate telemetry write ─────────────────────────────────
test('recordAiCall is idempotent — a duplicate execution id is not double-written', async () => {
  const s = memStore()
  await recordAiCall(rec({ id: 'dup', outputTokens: 200 }), s)
  await recordAiCall(rec({ id: 'dup', outputTokens: 999 }), s)  // same id → skipped
  const all = await listAiCalls(100, s)
  assert.equal(all.filter(r => r.id === 'dup').length, 1)
  assert.equal((await getAiCall('dup', s))!.outputTokens, 200)  // first writer won
})

// ── 6. Persistence failure never blocks (fail-soft) ───────────────────────────
test('recordAiCall swallows a store failure (telemetry never throws)', async () => {
  const s = memStore(); s.setThrows = true
  await assert.doesNotReject(recordAiCall(rec({ id: 'x' }), s))
})

// ── 7. Post-hoc enrichment (confidence + manual-review reason) ─────────────────
test('updateAiCall attaches confidence and a redacted manual-review reason', async () => {
  const s = memStore()
  await recordAiCall(rec({ id: 'm1' }), s)
  const ok = await updateAiCall('m1', { confidenceScore: 0.42, manualReviewReason: 'low read at https://x/a' }, s)
  assert.equal(ok, true)
  const back = await getAiCall('m1', s)
  assert.equal(back!.confidenceScore, 0.42)
  assert.equal(back!.manualReviewReason, 'low read at [url]')
  assert.equal(await updateAiCall('missing', { confidenceScore: 1 }, s), false)  // absent → false, no throw
})

test('setAiFeedback is tenant-scoped', async () => {
  const s = memStore()
  await recordAiCall(rec({ id: 'f1' }), s)
  assert.equal(await setAiFeedback('f1', true, 'other-tenant', s), false)
  assert.equal(await setAiFeedback('f1', true, 'tele-tenant.example', s), true)
  assert.equal((await getAiCall('f1', s))!.feedback, 'helpful')
})

// ── 8. runAiTask records kind / booking / image-count / cost provenance / timing
type Gen = AiTaskDeps['generate']
const okGen = (text: string, usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, model = 'anthropic/claude-sonnet-4-6'): Gen =>
  async () => ({ ok: true, text, usage, model })

function harness(gen: Gen, times: number[] = [1000, 1100, 1400]) {
  const records: AiCallRecord[] = []
  let i = 0
  const deps: AiTaskDeps = { generate: gen, record: async r => { records.push(r) }, now: () => times[Math.min(i++, times.length - 1)] }
  return { deps, records }
}

test('a primary AI call records kind, booking, image count, cost provenance, and timing', async () => {
  const { deps, records } = harness(okGen('{"targetId":"ops"}'))
  const r = await runAiTask({
    taskId: 'ops.command', feature: 'ops.command', vars: { query: 'q', targetsText: 't', summaryJson: '{}' },
    schema: COMMAND_SCHEMA, kind: 'primary', bookingId: 'bk-9', imageCount: 3, queuedAt: 900, requestChars: 5,
  }, deps)
  assert.equal(r.ok, true)
  const rc = records[0]
  assert.equal(rc.kind, 'primary')
  assert.equal(rc.bookingId, 'bk-9')
  assert.equal(rc.imageCount, 3)
  assert.equal(rc.costTableVersion, activeCostTable().version)
  assert.equal(rc.rateFallback, false)
  assert.equal(rc.startedAt, 1100)
  assert.equal(rc.completedAt, 1400)
  assert.equal(rc.queueLatencyMs, 200)   // startedAt 1100 − queuedAt 900
  assert.equal(rc.totalLatencyMs, 500)   // completedAt 1400 − queuedAt 900
  assert.equal(rc.latencyMs, 300)        // processing only
})

// ── 9. Failed provider call records providerErrorCode + retried ───────────────
test('a provider error records a redacted error code, timing, and retry state', async () => {
  const failGen: Gen = async () => ({ ok: false, error: 'network fetch failed', retryable: true, errorKind: 'timeout' })
  const { deps, records } = harness(failGen)
  const r = await runAiTask({ taskId: 'ops.command', feature: 'ops.command', vars: { query: 'q', targetsText: 't', summaryJson: '{}' }, kind: 'primary' }, deps)
  assert.equal(r.ok, false)
  assert.equal(records[0].outcome, 'provider_error')
  assert.equal(records[0].providerErrorCode, 'timeout')
  assert.equal(records[0].retried, true)             // network class → retried
  assert.equal(records[0].attempts, 2)
})

// ── 10. Missing optional provider usage data ──────────────────────────────────
test('missing provider usage yields a zero-cost record, still ok', async () => {
  const { deps, records } = harness(okGen('{"targetId":"ops"}', { inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
  const r = await runAiTask({ taskId: 'ops.command', feature: 'ops.command', vars: { query: 'q', targetsText: 't', summaryJson: '{}' }, schema: COMMAND_SCHEMA }, deps)
  assert.equal(r.ok, true)
  assert.equal(records[0].estCostUsd, 0)
  assert.equal(records[0].totalTokens, 0)
})

// ── 11. Read-side: kind breakdown separates shadow from primary spend ─────────
test('kindBreakdown separates primary / shadow / fallback cost and tokens', () => {
  const recs = [
    rec({ id: 'p', kind: 'primary', estCostUsd: 0.01, totalTokens: 100, imageCount: 2 }),
    rec({ id: 's', kind: 'shadow', estCostUsd: 0.05, totalTokens: 400, imageCount: 4 }),
    rec({ id: 'f', kind: 'fallback', estCostUsd: 0.002, totalTokens: 30 }),
    rec({ id: 'legacy', kind: undefined, estCostUsd: 0.003, totalTokens: 20 }),  // absent → primary
  ]
  const b = kindBreakdown(recs)
  assert.equal(b.primary.calls, 2)                   // explicit primary + legacy
  assert.equal(b.shadow.calls, 1)
  assert.equal(b.shadow.estCostUsd, 0.05)
  assert.equal(b.shadow.imageCount, 4)
  assert.equal(b.fallback.calls, 1)
  assert.equal(b.total.calls, 4)
  assert.equal(b.total.estCostUsd, 0.065)
})

// ── 12. Read-side: provider breakdown, fallback share, per-booking join ────────
test('providerBreakdown groups by provider and sorts by cost', () => {
  const recs = [
    rec({ id: '1', provider: 'anthropic', model: 'anthropic/claude-sonnet-4-6', estCostUsd: 0.02, costSource: 'estimated' }),
    rec({ id: '2', provider: 'openai', model: 'openai/gpt-4o', estCostUsd: 0.10, costSource: 'estimated' }),
  ]
  const p = providerBreakdown(recs)
  assert.equal(p[0].provider, 'openai')              // higher cost first
  assert.equal(p[1].provider, 'anthropic')
})

test('rateFallbackShare flags the portion priced at the default rate', () => {
  const recs = [
    rec({ id: '1', rateFallback: false }),
    rec({ id: '2', rateFallback: true }),
    rec({ id: '3', outcome: 'forbidden', ok: false }),   // never reached the model — excluded
  ]
  const share = rateFallbackShare(recs)
  assert.equal(share.calls, 2)
  assert.equal(share.fallbackCalls, 1)
  assert.equal(share.share, 0.5)
})

test('callsForBooking joins AI calls to a booking, newest first', () => {
  const recs = [
    rec({ id: 'old', bookingId: 'bk-1', at: 100 }),
    rec({ id: 'new', bookingId: 'bk-1', at: 300 }),
    rec({ id: 'other', bookingId: 'bk-2', at: 200 }),
  ]
  const got = callsForBooking(recs, 'bk-1')
  assert.deepEqual(got.map(r => r.id), ['new', 'old'])
})
