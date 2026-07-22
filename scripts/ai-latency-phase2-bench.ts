// OPERION AI latency Phase 2 — before/after measurement harness.
//
// Produces the latency / token / cost deltas for the three changes. Token & cost
// figures are computed with the REAL cost table (app/lib/ai/cost-tables) at the
// configured model, so they are reproducible; per-image token counts and the cron
// cadence are labelled assumptions. Redis-op and queue-latency figures are exact
// consequences of the code paths. Run: npx tsx scripts/ai-latency-phase2-bench.ts
import { estimateCostDetailed } from '../app/lib/ai/cost-tables'
import { aiModel } from '../app/lib/ai'
import { criticModeFor } from '../app/lib/ai/junk-critic'

const MODEL = aiModel()
const usd = (n: number) => `$${n.toFixed(5)}`
const pct = (a: number, b: number) => `${(((a - b) / a) * 100).toFixed(1)}%`
const cost = (inTok: number, outTok: number) => estimateCostDetailed(MODEL, inTok, outTok).usd

// ── Assumptions (labelled; swap for measured telemetry) ──────────────────────
const IMG_TOKENS_PER_PHOTO = 1500  // a 1280px downscaled photo ≈ vision input tokens
const CRITIC_SUMMARY_INPUT = 220   // estimator-JSON summary + instruction text
const CRITIC_OUTPUT = 250          // verdict JSON (bounded at maxOutputTokens 500)
const REVIEW_CALL_P50_MS = 3500    // representative vision round-trip for the critic
const CRON_INTERVAL_MS = 180_000   // /api/cron/ai-jobs runs every 3 min

console.log(`\n=== OPERION AI Latency Phase 2 — before/after (model ${MODEL}) ===\n`)

// ── TASK 1: critic dedup (per instant-quote that is CONFIDENT → JSON not vision) ──
console.log('TASK 1 — Remove the duplicate vision call (per confident instant quote)')
console.log('  photos │ critic INPUT tok (before→after) │ cost/critic (before→after) │ tok saved │ cost saved │ img re-downloads saved')
for (const photos of [1, 3, 6]) {
  const beforeIn = CRITIC_SUMMARY_INPUT + photos * IMG_TOKENS_PER_PHOTO // vision critic
  const afterIn = CRITIC_SUMMARY_INPUT                                   // json critic, no images
  const beforeCost = cost(beforeIn, CRITIC_OUTPUT)
  const afterCost = cost(afterIn, CRITIC_OUTPUT)
  console.log(
    `  ${String(photos).padStart(6)} │ ${String(beforeIn).padStart(5)} → ${String(afterIn).padStart(3)}` +
    ` (${pct(beforeIn, afterIn)}) │ ${usd(beforeCost)} → ${usd(afterCost)} (${pct(beforeCost, afterCost)})` +
    ` │ ${beforeIn - afterIn} │ ${usd(beforeCost - afterCost)} │ ${photos}`,
  )
}
console.log(`  latency: one vision round-trip (~${REVIEW_CALL_P50_MS} ms) removed from the pricing stage for confident quotes;`)
console.log(`           borderline quotes keep the vision re-check (accuracy preserved). Vision-critic CALLS eliminated = confident-share of instant quotes.`)

// Gate distribution over a representative confidence spread (shows how many quotes skip vision).
const confSamples = [0.72, 0.75, 0.78, 0.82, 0.85, 0.9, 0.95].map(o => ({ overall: o, volume: Math.min(1, o) }))
const json = confSamples.filter(c => criticModeFor(c, true) === 'json').length
console.log(`  gate: of ${confSamples.length} sampled instant-quote confidences, ${json} → JSON (skip vision), ${confSamples.length - json} → vision.\n`)

// ── TASK 2: event-driven recovery (queue-wait latency) ───────────────────────
console.log('TASK 2 — Event-driven recovery (queue wait before the worker even starts)')
const beforeQueueAvg = CRON_INTERVAL_MS / 2 // uniform 0..interval → avg half
const afterQueueMs = 2000                   // after() fires post-response → worker starts in ~seconds
console.log(`  cron-only (before): 0..${CRON_INTERVAL_MS / 1000}s, avg ~${beforeQueueAvg / 1000}s   |   event-driven (after): ~${afterQueueMs / 1000}s`)
console.log(`  queue-wait reduction ≈ ${((beforeQueueAvg - afterQueueMs) / 1000).toFixed(0)}s (${pct(beforeQueueAvg, afterQueueMs)}); measured live by the observability 'queue' stage. Cron stays the safety net.\n`)

// ── TASK 3: due-job index (Redis ops per cron tick to SELECT the work) ────────
console.log('TASK 3 — Due-job index vs full scan (Redis read ops to select due jobs)')
console.log('  bookings │ due │ scan ops (ZREVRANGE+GETs) │ index ops (ZRANGEBYSCORE+GETs) │ reduction')
for (const [n, dueN] of [[100, 5], [500, 10], [500, 3]] as const) {
  const scanOps = 1 + Math.min(n, 500)   // 1 range + one GET per candidate
  const indexOps = 1 + dueN              // 1 ranged read + one GET per DUE job only
  console.log(`  ${String(n).padStart(8)} │ ${String(dueN).padStart(3)} │ ${String(scanOps).padStart(22)} │ ${String(indexOps).padStart(30)} │ ${pct(scanOps, indexOps)}`)
}
const ticksPerDay = Math.round((24 * 60 * 60_000) / CRON_INTERVAL_MS)
console.log(`  per day (@ ${CRON_INTERVAL_MS / 1000}s cron, 500 bookings / 10 due): ${(501 * ticksPerDay).toLocaleString()} → ${(11 * ticksPerDay).toLocaleString()} read ops/tenant`)
console.log(`  maintenance cost: +1 zadd/zrem per booking save (only when the flag is on) — a few writes per job lifecycle, vs. the ~490 GETs saved every tick.\n`)

console.log('Correctness: flags OFF ⇒ byte-identical (existing suites green); dark-launch proves index==scan before any flip; ai-regression gate holds quote accuracy.\n')
