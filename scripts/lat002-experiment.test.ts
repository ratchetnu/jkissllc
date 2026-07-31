// ─────────────────────────────────────────────────────────────────────────────
// LAT-002 — the photo-estimate latency experiment.
//
// The property under test is the ASYMMETRY, because it is the whole design and the
// easiest thing to erode later:
//
//   latency / tokens / cost  → MEASURED. A slower candidate is a result.
//   quote / confidence /
//   review rate / schema     → GUARDRAILS. Breaching one is never promotable,
//                              however large the latency win.
//
// The sprint objective is "reduce latency WITHOUT changing schema, deterministic
// pricing, confidence, or manual-review behavior", so a fast candidate that moves
// any of those must be REFUSED. Several tests below deliberately pair a huge speed
// win with a small parity breach — the direction a real optimization fails in.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
// `scopeKey` no-ops with tenancy off, so isolation assertions would pass vacuously.
process.env.TENANCY_ENABLED = 'true'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 8660 + (process.pid % 120)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import {
  evaluateLat002, DEFAULT_LAT002_THRESHOLDS, LAT002_ID,
  type Lat002Pair, type Lat002Sample,
} from '../app/lib/estimation/lat002'
import { saveLat002Run, getLat002Run, listLat002Runs, MAX_RUN_PAIRS } from '../app/lib/estimation/lat002-store'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { latencyStats } from '../app/lib/ai/analytics'
import { FLAG_DEFAULTS, isEnabled } from '../app/lib/platform/flags'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(() => fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {}))

const TEN = 'jkiss'
const OTHER = 'supercharged'

const sample = (over: Partial<Lat002Sample> = {}): Lat002Sample => ({
  latencyMs: 30_000, outputTokens: 900, costUsd: 0.02,
  quoteUsd: 400, confidence: 0.82, manualReview: false, schemaValid: true, ...over,
})

/** N paired samples; `mut` shapes the candidate arm. */
const pairs = (n: number, mut: (i: number) => Partial<Lat002Sample> = () => ({})): Lat002Pair[] =>
  Array.from({ length: n }, (_, i) => ({
    bookingId: `bk_${i}`,
    baseline: sample(),
    candidate: sample(mut(i)),
  }))

const FASTER = { latencyMs: 12_000, outputTokens: 500, costUsd: 0.011 }

// ── The measured axis never fails a run ──────────────────────────────────────

test('MEASURED: a faster candidate that holds parity is safe to promote', () => {
  const r = evaluateLat002(pairs(30, () => FASTER))
  assert.equal(r.experiment, LAT002_ID)
  assert.equal(r.verdict, 'safe_to_promote')
  assert.ok(r.measured.latencyP50ImprovedPct > 50, `p50 improved ${r.measured.latencyP50ImprovedPct}%`)
  assert.ok(r.measured.outputTokenReductionPct > 0)
  assert.ok(r.measured.costReductionPct > 0)
  assert.equal(r.guardrails.breached.length, 0)
})

test('MEASURED: a SLOWER candidate is a result, not a failure', () => {
  const r = evaluateLat002(pairs(30, () => ({ latencyMs: 45_000 })))
  assert.equal(r.verdict, 'no_regression_no_benefit', 'slower is reported, never a regression')
  assert.equal(r.guardrails.breached.length, 0, 'latency is not a guardrail')
  assert.ok(r.measured.meanLatencyDeltaMs > 0, 'and the slowdown is stated, not hidden')
  assert.ok(r.measured.latencyP50ImprovedPct < 0,
    'a slowdown reads as a NEGATIVE improvement — flooring it at 0 would make "no change" and "half as fast" identical')
})

test('MEASURED: percentiles come from the SAME helper the AI Control Center uses', () => {
  const values = [10_000, 20_000, 30_000, 40_000, 50_000]
  const r = evaluateLat002(values.map((v, i) => ({
    bookingId: `bk_${i}`, baseline: sample({ latencyMs: v }), candidate: sample({ latencyMs: v }),
  })))
  assert.deepEqual(r.baseline.latency, latencyStats(values), 'one implementation, one answer')
})

// ── Guardrails refuse a fast candidate ───────────────────────────────────────

test('GUARDRAIL: a huge speed win does NOT excuse a quote shift', () => {
  // Every pair 60% faster, but a fifth of them reprice beyond tolerance.
  const r = evaluateLat002(pairs(40, i => (i % 5 === 0 ? { ...FASTER, quoteUsd: 460 } : FASTER)))
  assert.equal(r.verdict, 'parity_regression')
  assert.ok(r.guardrails.breached.some(b => b.startsWith('quote_mismatch_rate')), r.guardrails.breached.join(','))
  assert.ok(r.measured.latencyP50ImprovedPct > 50, 'the speed win is still reported alongside the refusal')
})

test('GUARDRAIL: a confidence drop beyond tolerance blocks promotion', () => {
  const r = evaluateLat002(pairs(30, () => ({ ...FASTER, confidence: 0.70 })))
  assert.equal(r.verdict, 'parity_regression')
  assert.ok(r.guardrails.confidenceDrop > DEFAULT_LAT002_THRESHOLDS.maxConfidenceDrop)
  assert.ok(r.guardrails.breached.some(b => b.startsWith('confidence_drop')))
})

test('GUARDRAIL: a candidate that is MORE confident never breaches', () => {
  const r = evaluateLat002(pairs(30, () => ({ ...FASTER, confidence: 0.95 })))
  assert.equal(r.verdict, 'safe_to_promote')
  assert.ok(r.guardrails.confidenceDrop < 0, 'a negative "drop" is an improvement, not a breach')
})

test('GUARDRAIL: sending more work to manual review blocks promotion', () => {
  const r = evaluateLat002(pairs(40, i => (i < 4 ? { ...FASTER, manualReview: true } : FASTER)))
  assert.equal(r.verdict, 'parity_regression')
  assert.ok(r.guardrails.reviewRateDelta > DEFAULT_LAT002_THRESHOLDS.maxReviewRateIncrease)
  assert.ok(r.guardrails.breached.some(b => b.startsWith('review_rate_increase')))
})

test('GUARDRAIL: sending LESS work to manual review is fine', () => {
  const base = pairs(40, () => FASTER)
  base.forEach((p, i) => { if (i < 8) p.baseline = sample({ manualReview: true }) })
  const r = evaluateLat002(base)
  assert.ok(r.guardrails.reviewRateDelta < 0)
  assert.equal(r.verdict, 'safe_to_promote')
})

test('GUARDRAIL: ONE invalid schema response is a regression, not a rate', () => {
  const r = evaluateLat002(pairs(100, i => (i === 0 ? { ...FASTER, schemaValid: false } : FASTER)))
  assert.equal(r.guardrails.candidateSchemaInvalid, 1)
  assert.equal(r.verdict, 'parity_regression', 'the schema does not change — 1 in 100 is still a change')
})

test('GUARDRAIL: breaches are all reported together, not just the first', () => {
  const r = evaluateLat002(pairs(40, () => ({ ...FASTER, quoteUsd: 500, confidence: 0.5, manualReview: true, schemaValid: false })))
  assert.equal(r.verdict, 'parity_regression')
  assert.ok(r.guardrails.breached.length >= 4, `expected every breach, got ${r.guardrails.breached.join(',')}`)
  // `reasons` is what the page renders. Reporting only the first breach would send
  // someone to fix one thing and re-run into the next — every breach must survive
  // into the rendered list, not just into the structured field.
  for (const b of r.guardrails.breached) {
    assert.ok(r.reasons.includes(b), `reasons dropped "${b}" — the UI would hide it`)
  }
})

// ── Sample-size honesty ──────────────────────────────────────────────────────

test('SAMPLES: too few pairs can never read as safe, however good they look', () => {
  const r = evaluateLat002(pairs(3, () => FASTER))
  assert.equal(r.verdict, 'insufficient_samples')
  assert.ok(r.reasons[0].startsWith('pairs:3<'), 'and it says how short it was')
})

test('SAMPLES: an empty run is insufficient, not a division by zero', () => {
  const r = evaluateLat002([])
  assert.equal(r.verdict, 'insufficient_samples')
  assert.equal(r.pairs, 0)
  assert.equal(r.baseline.reviewRate, 0)
  assert.equal(r.measured.costReductionPct, 0)
  assert.equal(Number.isFinite(r.guardrails.worstQuoteDeltaPct), true)
})

test('SAMPLES: a zero-value baseline does not produce Infinity or NaN', () => {
  const r = evaluateLat002(pairs(25, () => ({ latencyMs: 0, outputTokens: 0, costUsd: 0, quoteUsd: 0 })).map(p => ({
    ...p, baseline: sample({ latencyMs: 0, outputTokens: 0, costUsd: 0, quoteUsd: 0 }),
  })))
  for (const v of Object.values(r.measured)) assert.equal(Number.isFinite(v), true, `measured ${v}`)
  assert.equal(Number.isFinite(r.guardrails.worstQuoteDeltaPct), true)
})

// ── The store is evidence ────────────────────────────────────────────────────

const RUN = 'lat002_abc1234567'

test('STORE: the report is RECOMPUTED from the stored pairs, never trusted from input', async () => {
  const run = await runWithTenant({ tenantId: TEN }, () => saveLat002Run({
    runId: RUN, arms: { baseline: 'v2-sonnet', candidate: 'v2-haiku' },
    createdAt: 1_700_000_000_000, createdBy: 'u_admin', pairs: pairs(30, () => FASTER),
  }))
  assert.equal(run.report.verdict, 'safe_to_promote')

  const back = await runWithTenant({ tenantId: TEN }, () => getLat002Run(RUN))
  assert.ok(back)
  assert.equal(back!.pairs.length, 30, 'the evidence travels with the verdict')
  assert.deepEqual(back!.report, evaluateLat002(back!.pairs), 'a stored verdict cannot disagree with its own evidence')
})

test('STORE: re-saving the same runId replaces it rather than minting a second', async () => {
  const save = () => runWithTenant({ tenantId: TEN }, () => saveLat002Run({
    runId: RUN, arms: { baseline: 'a', candidate: 'b' },
    createdAt: 1_700_000_000_000, createdBy: 'u_admin', pairs: pairs(25, () => FASTER),
  }))
  await save(); await save()
  const runs = await runWithTenant({ tenantId: TEN }, () => listLat002Runs(20))
  assert.equal(runs.length, 1, 'a retry after an unknown response is safe')
})

test('STORE: pairs are bounded so one run cannot become an unbounded blob', async () => {
  const run = await runWithTenant({ tenantId: TEN }, () => saveLat002Run({
    runId: RUN, arms: { baseline: 'a', candidate: 'b' },
    createdAt: 1, createdBy: 'u', pairs: pairs(MAX_RUN_PAIRS + 50, () => FASTER),
  }))
  assert.equal(run.pairs.length, MAX_RUN_PAIRS)
  assert.equal(run.report.pairs, MAX_RUN_PAIRS, 'and the report describes what was actually kept')
})

test('STORE: listing returns summaries WITHOUT every pair of every run', async () => {
  await runWithTenant({ tenantId: TEN }, () => saveLat002Run({
    runId: RUN, arms: { baseline: 'a', candidate: 'b' },
    createdAt: 1, createdBy: 'u', pairs: pairs(30, () => FASTER),
  }))
  const runs = await runWithTenant({ tenantId: TEN }, () => listLat002Runs(20))
  assert.equal(runs.length, 1)
  assert.equal('pairs' in runs[0], false, 'a listing must not ship every sample')
  assert.ok(runs[0].report, 'but the verdict is still there')
})

test('STORE: a malformed runId is null, never a store read', async () => {
  for (const bad of ['', 'nope', '../../etc/passwd', 'lat002_x', 'LAT002_ABCDEFGHIJ']) {
    assert.equal(await runWithTenant({ tenantId: TEN }, () => getLat002Run(bad)), null, bad)
  }
})

// ── Tenancy ──────────────────────────────────────────────────────────────────

test('TENANCY: a run recorded in one tenant is invisible to another', async () => {
  await runWithTenant({ tenantId: TEN }, () => saveLat002Run({
    runId: RUN, arms: { baseline: 'a', candidate: 'b' },
    createdAt: 1, createdBy: 'u', pairs: pairs(25, () => FASTER),
  }))
  assert.ok(await runWithTenant({ tenantId: TEN }, () => getLat002Run(RUN)))
  assert.equal(await runWithTenant({ tenantId: OTHER }, () => getLat002Run(RUN)), null)
  assert.deepEqual(await runWithTenant({ tenantId: OTHER }, () => listLat002Runs(20)), [])
})

test('TENANCY: the store fails closed with no tenant context', async () => {
  await assert.rejects(() => getLat002Run(RUN))
  await assert.rejects(() => listLat002Runs(5))
})

// ── Flag + authorization ─────────────────────────────────────────────────────

test('FLAG: LAT002_EXPERIMENT_ENABLED defaults OFF everywhere', () => {
  assert.equal(FLAG_DEFAULTS.LAT002_EXPERIMENT_ENABLED, false)
  assert.equal(isEnabled('LAT002_EXPERIMENT_ENABLED', {}), false)
  assert.equal(isEnabled('LAT002_EXPERIMENT_ENABLED', { LAT002_EXPERIMENT_ENABLED: 'true' }), true)
})

test('API: reading needs ai:analytics; RECORDING needs ai:prompts:manage and the flag', () => {
  const src = readFileSync(new URL('../app/api/admin/ai/lat002/route.ts', import.meta.url), 'utf8')
  const get = src.slice(src.indexOf('export const GET'), src.indexOf('export const POST'))
  const post = src.slice(src.indexOf('export const POST'))

  assert.match(get, /requirePermission\(req, 'ai:analytics'\)/)
  assert.doesNotMatch(get, /isEnabled\('LAT002_EXPERIMENT_ENABLED'\)\)\s*\{\s*\n\s*return/,
    'reading must NOT be gated — evidence has to outlive the flag')

  assert.match(post, /requirePermission\(req, 'ai:prompts:manage'\)/)
  assert.match(post, /if \(!isEnabled\('LAT002_EXPERIMENT_ENABLED'\)\)/)
  assert.match(post, /status: 403/)
  // Both verbs must be tenant-wrapped or the chokepoint has no context to scope by.
  assert.equal((src.match(/withTenantRoute\(/g) ?? []).length, 2)
})

test('API: a partially-valid arm is rejected rather than scored as zero', () => {
  const src = readFileSync(new URL('../app/api/admin/ai/lat002/route.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('function parseSample'), src.indexOf('export const GET'))
  for (const field of ['latencyMs', 'outputTokens', 'costUsd', 'quoteUsd', 'confidence']) {
    assert.ok(fn.includes(field), `${field} must be validated`)
  }
  assert.match(fn, /typeof o\.manualReview !== 'boolean' \|\| typeof o\.schemaValid !== 'boolean'/)
  assert.match(fn, /confidence < 0 \|\| confidence > 1/, 'confidence is a 0..1 proportion')
  // A dropped pair would change the denominator of every rate in the report.
  const post = src.slice(src.indexOf('export const POST'))
  assert.match(post, /Every pair needs a bookingId and two complete arms/)
  assert.match(post, /Duplicate bookingId in pairs/)
})

test('DOCS: LAT-002 is documented as an experiment id, NOT a latency SLO', () => {
  const src = readFileSync(new URL('../app/lib/estimation/lat002.ts', import.meta.url), 'utf8')
  assert.match(src, /EXPERIMENT IDENTIFIER, not a service level objective/)
  // The asymmetry must stay written down — it is the thing a future edit erodes.
  assert.match(src, /never fail the\n\/\/     experiment/)
  assert.doesNotMatch(src, /maxLatencyMs|latencySlo|LATENCY_BUDGET/i, 'no latency threshold may be introduced')
})
