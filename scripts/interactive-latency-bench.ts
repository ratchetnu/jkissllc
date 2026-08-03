// Interactive photo-estimate latency — the before/after measurement harness.
//
// TWO MODES, and the difference matters when you read the output:
//
//   OFFLINE (default)  Runs anywhere, no credentials, no provider. Reports:
//                       • an EXACT measurement of the response-payload reduction
//                         (the compact spec vs v1 — real bytes, real token estimate,
//                         real cost table);
//                       • a SIMULATION of what each policy does to a request, given
//                         a provider-latency distribution you supply. Every
//                         assumption is printed. A simulation is not a measurement:
//                         it says what the policy WOULD do to a given distribution,
//                         which is exactly the question the policy change is about.
//
//   LIVE (opt-in)      Set BENCH_TARGET to a Preview deployment and BENCH_PHOTOS to
//                       a comma-separated list of Blob photo URLs. Issues N real
//                       requests against /api/quote/analyze and reports MEASURED
//                       p50/p95 end-to-end latency, provider latency, output tokens,
//                       and the decision distribution. This is the mode that
//                       produces the numbers a Production rollout needs.
//
// Run: npx tsx scripts/interactive-latency-bench.ts
//      BENCH_TARGET=https://…vercel.app BENCH_PHOTOS=https://…jpg npx tsx scripts/interactive-latency-bench.ts
import { estimateCostDetailed } from '../app/lib/ai/cost-tables'
import { aiModel } from '../app/lib/ai'
import { getPrompt } from '../app/lib/ai/prompts'
import { DEFAULT_INTERACTIVE_BUDGET } from '../app/lib/ai/interactive-policy'

const MODEL = aiModel()
const usd = (n: number) => `$${n.toFixed(5)}`
const ms = (n: number) => `${Math.round(n).toLocaleString()} ms`
const pctChange = (before: number, after: number) =>
  before === 0 ? 'n/a' : `${(((before - after) / before) * 100).toFixed(1)}% smaller`

// A rough but stable chars→tokens ratio for JSON output. Labelled, not claimed exact.
const CHARS_PER_TOKEN = 3.5
const tokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — EXACT: how much smaller is the compact response?
// ─────────────────────────────────────────────────────────────────────────────

/** One item as each spec requires it to be emitted. */
const V1_ITEM = {
  category: 'furniture', label: 'sectional couch', estimatedQuantity: 1,
  estimatedVolumeCubicYards: 4.5,
  estimatedWeightPounds: { minimum: 180, likely: 240, maximum: 320 },
  bulky: true, heavy: true, requiresDisassembly: true, likelyDisposalType: 'landfill',
  confidence: 0.82,
  evidence: 'Large three-piece sectional visible against the garage wall in both photos, roughly two metres wide.',
}
const COMPACT_ITEM = {
  category: 'furniture', label: 'sectional couch', estimatedQuantity: 1,
  estimatedVolumeCubicYards: 4.5, heavy: true, requiresDisassembly: true, confidence: 0.82,
}
const V1_PHOTO_OBS = {
  photoUrl: 'https://blob.example.com/aaaaaaaaaaaaaaaaaaaa.jpg', estimatedPhotoVolumeCubicYards: 7.2,
  accessObservations: ['garage door access', 'level driveway'],
  possibleDuplicateViewOfOtherPhoto: false, duplicateGroupId: '', imageQuality: 'good',
}
const COMPACT_PHOTO_OBS = {
  photoUrl: 'https://blob.example.com/aaaaaaaaaaaaaaaaaaaa.jpg', imageQuality: 'good',
}
const SHARED_TAIL = {
  totalEstimatedVolumeCubicYards: { minimum: 9, likely: 11.1, maximum: 13 },
  totalEstimatedWeightPounds: { minimum: 600, likely: 700, maximum: 900 },
  estimatedTruckLoadFraction: { minimum: 0.2, likely: 0.25, maximum: 0.32 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  detectedConditions: {
    stairs: false, elevator: false, longCarry: false, narrowAccess: false,
    indoorRemoval: true, outdoorRemoval: false, disassemblyRequired: true, heavyItemsPresent: true,
    hazardousMaterialPossible: false, refrigerantAppliancePossible: true, concreteOrSoilPossible: false,
    tiresPossible: false, paintOrChemicalPossible: false,
  },
  additionalQuestions: ['Is the freezer empty and disconnected?'],
  warnings: ['Rear of the pile is partly obscured.'],
  reviewRequired: false, reviewReasons: [],
}

function responseChars(items: number, photos: number, compact: boolean): number {
  const body = {
    normalizedItems: Array.from({ length: items }, () => (compact ? COMPACT_ITEM : V1_ITEM)),
    photoObservations: Array.from({ length: photos }, () => (compact ? COMPACT_PHOTO_OBS : V1_PHOTO_OBS)),
    ...SHARED_TAIL,
    laborEstimate: compact ? { crewSize: 2, likelyMinutes: 90 } : { crewSize: 2, minimumMinutes: 60, likelyMinutes: 90, maximumMinutes: 150 },
    confidence: compact
      ? { overall: 0.78, volume: 0.72 }
      : { overall: 0.78, volume: 0.72, weight: 0.6, itemClassification: 0.8, accessDifficulty: 0.7 },
  }
  return JSON.stringify(body).length
}

console.log(`\n=== Interactive photo estimate — before/after (model ${MODEL}) ===\n`)

console.log('PART 1 — MEASURED: response payload, v1 spec vs compact spec')
console.log('  Exact serialization of the same job described under each spec. Output tokens')
console.log('  are the dominant term in vision latency: the model must generate every')
console.log(`  character before we see any of it. Token estimate at ${CHARS_PER_TOKEN} chars/token (labelled assumption).\n`)
console.log('  items │ photos │ v1 chars → compact │ v1 tok → compact │ reduction │ cost/call (v1 → compact)')
for (const [items, photos] of [[3, 2], [6, 3], [10, 4], [14, 6]] as const) {
  const v1 = responseChars(items, photos, false)
  const compact = responseChars(items, photos, true)
  // Input tokens are identical under both specs (same images, near-identical prompt),
  // so cost per call differs only in the output term. Held constant at 4000 in.
  const v1Cost = estimateCostDetailed(MODEL, 4000, tokens(v1)).usd
  const cCost = estimateCostDetailed(MODEL, 4000, tokens(compact)).usd
  console.log(
    `  ${String(items).padStart(5)} │ ${String(photos).padStart(6)} │ ${String(v1).padStart(5)} → ${String(compact).padStart(5)}` +
    ` │ ${String(tokens(v1)).padStart(4)} → ${String(tokens(compact)).padStart(4)}` +
    ` │ ${pctChange(v1, compact).padStart(13)} │ ${usd(v1Cost)} → ${usd(cCost)}`,
  )
}

const promptV1 = getPrompt('ops.junkAnalysis').system.length
const promptCompact = getPrompt('ops.junkAnalysisCompact').system.length
console.log(`\n  Spec text itself: ${promptV1} → ${promptCompact} chars (${pctChange(promptV1, promptCompact)}).`)
console.log('  NOTE: this part measures the RESPONSE SHAPE only. Whether the model reads photos')
console.log('  as well under the smaller spec is a live-model question — LAT-002 in Preview.\n')

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — SIMULATION: what each policy does to a provider-latency distribution
// ─────────────────────────────────────────────────────────────────────────────

// Provider round-trip samples (ms) for one multi-photo vision call. Override with
// BENCH_PROVIDER_MS="12000,18000,…" once real telemetry is in hand — that turns this
// from an illustrative distribution into your distribution.
const PROVIDER_SAMPLES = (process.env.BENCH_PROVIDER_MS ?? '')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
const SAMPLES = PROVIDER_SAMPLES.length > 0 ? PROVIDER_SAMPLES : [
  // Illustrative: a long-tailed vision distribution centred around ~20s.
  9_000, 11_000, 12_500, 14_000, 15_000, 16_500, 18_000, 19_000, 20_000, 21_000,
  22_500, 24_000, 26_000, 28_000, 31_000, 34_000, 38_000, 45_000, 52_000, 70_000,
]
const SAMPLE_SOURCE = PROVIDER_SAMPLES.length > 0 ? 'BENCH_PROVIDER_MS (yours)' : 'illustrative default'

const ROUTE_CEILING = DEFAULT_INTERACTIVE_BUDGET.routeCeilingMs
const OLD_PER_CALL_TIMEOUT = 30_000   // aiCallTimeoutMs() default
const OLD_ATTEMPTS = 2                // AI service retries a transient failure
const OVERHEAD = 1_500                // KV reads, pricing, serialization

/** The policy in force before this change. */
function oldPolicy(primaryMs: number, criticMs: number) {
  let spent = OVERHEAD
  let attempts = 0
  let primaryOk = false
  while (attempts < OLD_ATTEMPTS) {
    attempts++
    const took = Math.min(primaryMs, OLD_PER_CALL_TIMEOUT)
    spent += took
    if (spent >= ROUTE_CEILING) return { outcome: 'platform_kill' as const, spent }
    if (primaryMs <= OLD_PER_CALL_TIMEOUT) { primaryOk = true; break }
  }
  if (!primaryOk) return { outcome: 'review_fallback' as const, spent }
  // Confident reads then paid a FULL second vision pass on the same photos.
  const criticTook = Math.min(criticMs, OLD_PER_CALL_TIMEOUT)
  spent += criticTook
  if (spent >= ROUTE_CEILING) return { outcome: 'platform_kill' as const, spent }
  return { outcome: 'answered' as const, spent }
}

/** The policy this branch introduces. */
function newPolicy(primaryMs: number, criticMs: number) {
  const b = DEFAULT_INTERACTIVE_BUDGET
  const deadline = b.routeCeilingMs - b.responseMarginMs
  let spent = OVERHEAD
  const primarySlice = Math.min(b.primaryMaxMs, deadline - spent)
  const primaryTook = Math.min(primaryMs, primarySlice)
  spent += primaryTook
  if (primaryMs > primarySlice) return { outcome: 'structured_timeout' as const, spent, criticSkipped: false }
  const criticSlice = Math.min(b.criticMaxMs, deadline - spent)
  if (criticSlice < b.criticMinMs) return { outcome: 'answered' as const, spent, criticSkipped: true }
  spent += Math.min(criticMs, criticSlice)
  return { outcome: 'answered' as const, spent, criticSkipped: false }
}

console.log('PART 2 — SIMULATION: policy behaviour over a provider-latency distribution')
console.log(`  Distribution: ${SAMPLE_SOURCE}, n=${SAMPLES.length}.`)
console.log(`  Assumptions: route ceiling ${ms(ROUTE_CEILING)}; old per-call timeout ${ms(OLD_PER_CALL_TIMEOUT)}`)
console.log(`  × ${OLD_ATTEMPTS} attempts; critic latency modelled as 0.8× the primary call (same images,`)
console.log(`  shorter output); ${ms(OVERHEAD)} non-model overhead. NOT a measurement of production.\n`)

const oldResults = SAMPLES.map(p => oldPolicy(p, p * 0.8))
const newResults = SAMPLES.map(p => newPolicy(p, p * 0.8))

const oldLat = oldResults.map(r => r.spent).sort((a, b) => a - b)
const newLat = newResults.map(r => r.spent).sort((a, b) => a - b)
const share = (rs: Array<{ outcome: string }>, o: string) =>
  `${((rs.filter(r => r.outcome === o).length / rs.length) * 100).toFixed(0)}%`

console.log('  metric                                  │ before        │ after')
console.log(`  end-to-end p50                          │ ${ms(percentile(oldLat, 50)).padEnd(13)} │ ${ms(percentile(newLat, 50))}`)
console.log(`  end-to-end p95                          │ ${ms(percentile(oldLat, 95)).padEnd(13)} │ ${ms(percentile(newLat, 95))}`)
console.log(`  worst case                              │ ${ms(oldLat[oldLat.length - 1]).padEnd(13)} │ ${ms(newLat[newLat.length - 1])}`)
console.log(`  killed by the platform (no answer, 504) │ ${share(oldResults, 'platform_kill').padEnd(13)} │ ${share(newResults, 'platform_kill')}`)
console.log(`  structured timeout (answer + reason)    │ ${'0%'.padEnd(13)} │ ${share(newResults, 'structured_timeout')}`)
console.log(`  answered within budget                  │ ${share(oldResults, 'answered').padEnd(13)} │ ${share(newResults, 'answered')}`)
const skipped = newResults.filter(r => 'criticSkipped' in r && r.criticSkipped).length
console.log(`  critic skipped for budget               │ ${'n/a'.padEnd(13)} │ ${((skipped / newResults.length) * 100).toFixed(0)}%`)
console.log('\n  The headline is not p50 — it is that "killed by the platform" goes to zero.')
console.log('  A killed request is the one the customer experiences as "We\'ll review your photos".\n')

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — LIVE: measured numbers against a Preview deployment
// ─────────────────────────────────────────────────────────────────────────────

type LiveSample = { ms: number; decision: string; degraded: string | null; ok: boolean }

async function live(target: string, photos: string[], runs: number): Promise<void> {
  console.log(`PART 3 — LIVE: ${runs} requests against ${target}\n`)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Preview deployments sit behind protection; the bypass secret is read from the
  // env, never hardcoded, and only ever sent to the target you named.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (bypass) headers['x-vercel-protection-bypass'] = bypass

  const samples: LiveSample[] = []
  for (let i = 0; i < runs; i++) {
    const started = Date.now()
    try {
      const res = await fetch(`${target.replace(/\/$/, '')}/api/quote/analyze`, {
        method: 'POST', headers,
        body: JSON.stringify({ photos, service: 'junk-removal' }),
      })
      const elapsed = Date.now() - started
      const j = await res.json().catch(() => ({} as Record<string, unknown>))
      const est = (j as { estimate?: { decision?: string } }).estimate
      const analyzed = (j as { analyzed?: { degraded?: string | null } }).analyzed
      samples.push({
        ms: elapsed,
        decision: est?.decision ?? (res.ok ? 'no_estimate' : `http_${res.status}`),
        degraded: analyzed?.degraded ?? null,
        ok: res.ok,
      })
      console.log(`  run ${String(i + 1).padStart(2)} │ ${String(elapsed).padStart(6)} ms │ ${samples[i].decision}${samples[i].degraded ? ` (${samples[i].degraded})` : ''}`)
    } catch (e) {
      const elapsed = Date.now() - started
      samples.push({ ms: elapsed, decision: 'request_failed', degraded: null, ok: false })
      console.log(`  run ${String(i + 1).padStart(2)} │ ${String(elapsed).padStart(6)} ms │ request_failed (${e instanceof Error ? e.message : 'unknown'})`)
    }
  }

  const lat = samples.map(s => s.ms).sort((a, b) => a - b)
  const rate = (pred: (s: LiveSample) => boolean) => `${((samples.filter(pred).length / samples.length) * 100).toFixed(0)}%`
  console.log('\n  MEASURED')
  console.log(`  p50 end-to-end                 │ ${ms(percentile(lat, 50))}`)
  console.log(`  p95 end-to-end                 │ ${ms(percentile(lat, 95))}`)
  console.log(`  max                            │ ${ms(lat[lat.length - 1])}`)
  console.log(`  instant quote                  │ ${rate(s => s.decision === 'instant_quote')}`)
  console.log(`  estimate range                 │ ${rate(s => s.decision === 'estimate_range')}`)
  console.log(`  manual review                  │ ${rate(s => s.decision === 'manual_review')}`)
  console.log(`  budget timeout (structured)    │ ${rate(s => s.degraded != null)}`)
  console.log(`  no answer at all (kill / fail) │ ${rate(s => !s.ok)}`)
  console.log('\n  Queued rate is measured on the SUBMIT path, not here: a booking that arrives')
  console.log('  with no attached estimate is the one that lands in the durable queue.')
  console.log('  Read it from the funnel counters (quote_analyze_started vs ai_analysis_timeout')
  console.log('  and quote_analyze_speculative) after a Preview session.\n')
}

const target = process.env.BENCH_TARGET
const photoList = (process.env.BENCH_PHOTOS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const runs = Math.max(1, Math.min(50, Number(process.env.BENCH_RUNS) || 10))

if (target && photoList.length > 0) {
  // Not top-level await: this file is transformed to CJS by tsx.
  void live(target, photoList, runs).catch(e => {
    console.error('  live run failed:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
} else {
  console.log('PART 3 — LIVE: skipped.')
  console.log('  Set BENCH_TARGET=<preview url> and BENCH_PHOTOS=<blob url[,url…]> to measure')
  console.log('  real p50/p95, decision distribution and timeout rate. Optionally BENCH_RUNS (default 10)')
  console.log('  and VERCEL_AUTOMATION_BYPASS_SECRET for a protected Preview deployment.')
  console.log('  Live runs make real provider calls and cost real money — Preview only, never Production.\n')
}
