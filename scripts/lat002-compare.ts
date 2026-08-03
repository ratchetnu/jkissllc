// LAT-002 comparison runner — turn a Preview A/B session into a promotion verdict.
//
// Three of the changes on this branch are Production behaviour changes that must NOT
// be promoted on latency evidence alone:
//
//   • OPERION_CRITIC_JSON          vision critic  vs  JSON critic
//   • AI_COMPACT_ANALYSIS_PROMPT   v1 spec        vs  compact spec
//   • a faster first-pass model    sonnet         vs  haiku (or any Gateway model)
//
// All three are the SAME experiment shape: run both arms over the same bookings and
// ask whether the candidate moved anything it was not allowed to move. LAT-002
// already encodes that asymmetry — latency, tokens and cost are MEASURED and can
// never fail; quote, confidence, review rate and schema validity are GUARDRAILS and
// a breach is `parity_regression` however fast the candidate was.
//
// This script is the thin runner: it reads paired samples collected in Preview and
// prints the report. It performs NO model calls and reaches no network — collection
// is a separate, deliberate Preview step, so a promotion decision is always made
// against data somebody chose to gather rather than data this script invented.
//
// Run: npx tsx scripts/lat002-compare.ts <pairs.json> [--arm=critic_json|compact_prompt|model]
//
// pairs.json shape:
//   [{ "bookingId": "…",
//      "baseline":  { "latencyMs": 0, "outputTokens": 0, "costUsd": 0, "quoteUsd": 0,
//                     "confidence": 0, "manualReview": false, "schemaValid": true },
//      "candidate": { … same shape … } }]
import { readFileSync } from 'node:fs'
import { evaluateLat002, DEFAULT_LAT002_THRESHOLDS, type Lat002Pair } from '../app/lib/estimation/lat002'

const ARMS: Record<string, { title: string; flag: string; note: string }> = {
  critic_json: {
    title: 'Second-opinion critic: full vision pass vs JSON-only pass',
    flag: 'OPERION_CRITIC_JSON',
    note: 'Watch reviewRateDelta hardest. A JSON critic that reviews LESS than the vision '
      + 'critic is not cheaper — it is blinder, and the saving is an illusion.',
  },
  compact_prompt: {
    title: 'Primary analysis spec: v1 vs compact',
    flag: 'AI_COMPACT_ANALYSIS_PROMPT',
    note: 'Schema-consumer equivalence is already proven offline '
      + '(scripts/compact-analysis-prompt.test.ts). What this measures is whether the '
      + 'model still READS the photos as well when asked for less.',
  },
  model: {
    title: 'First-pass model: current vs faster candidate',
    flag: 'AI_MODEL_OPS_JUNKANALYSIS',
    note: 'A cheaper model that quotes differently is a pricing change wearing a '
      + 'latency costume. quoteMismatchRate is the number that decides this one.',
  },
}

function usage(): never {
  console.error('usage: npx tsx scripts/lat002-compare.ts <pairs.json> [--arm=critic_json|compact_prompt|model]')
  console.error('       arms: ' + Object.keys(ARMS).join(', '))
  process.exit(2)
}

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
const armKey = (args.find(a => a.startsWith('--arm='))?.split('=')[1] ?? 'critic_json')
if (!file) usage()
const arm = ARMS[armKey]
if (!arm) usage()

let pairs: Lat002Pair[]
try {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of pairs')
  pairs = parsed as Lat002Pair[]
} catch (e) {
  console.error(`could not read pairs from ${file}: ${e instanceof Error ? e.message : e}`)
  process.exit(2)
}

const report = evaluateLat002(pairs)
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const rate = (n: number) => `${(n * 100).toFixed(1)}%`

console.log(`\n=== ${report.experiment} v${report.version} — ${arm.title} ===`)
console.log(`Flag: ${arm.flag}   Pairs: ${report.pairs}\n`)

console.log('MEASURED (never fails the experiment)')
console.log(`  latency p50            ${Math.round(report.baseline.latency.p50)} → ${Math.round(report.candidate.latency.p50)} ms   (${pct(report.measured.latencyP50ImprovedPct)} better)`)
console.log(`  latency p95            ${Math.round(report.baseline.latency.p95)} → ${Math.round(report.candidate.latency.p95)} ms   (${pct(report.measured.latencyP95ImprovedPct)} better)`)
console.log(`  mean latency delta     ${report.measured.meanLatencyDeltaMs} ms`)
console.log(`  output tokens          ${report.baseline.totalOutputTokens} → ${report.candidate.totalOutputTokens}   (${pct(report.measured.outputTokenReductionPct)} reduction)`)
console.log(`  cost                   $${report.baseline.totalCostUsd.toFixed(4)} → $${report.candidate.totalCostUsd.toFixed(4)}   (${pct(report.measured.costReductionPct)} reduction)`)

console.log('\nGUARDRAILS (a breach blocks promotion at any speed)')
const g = report.guardrails
const t = DEFAULT_LAT002_THRESHOLDS
console.log(`  quote mismatch rate    ${rate(g.quoteMismatchRate)}   (limit ${rate(t.maxQuoteMismatchRate)})`)
console.log(`  worst quote delta      ${g.worstQuoteDeltaPct.toFixed(1)}%   (tolerance ${t.maxQuoteDeltaPct}%)`)
console.log(`  confidence drop        ${g.confidenceDrop.toFixed(3)}   (limit ${t.maxConfidenceDrop})`)
console.log(`  review-rate delta      ${g.reviewRateDelta >= 0 ? '+' : ''}${(g.reviewRateDelta * 100).toFixed(1)} pts   (limit +${(t.maxReviewRateIncrease * 100).toFixed(1)} pts)`)
console.log(`  baseline review rate   ${rate(report.baseline.reviewRate)}    candidate ${rate(report.candidate.reviewRate)}`)
console.log(`  schema valid           ${rate(report.baseline.schemaValidRate)} → ${rate(report.candidate.schemaValidRate)}`)

console.log(`\nVERDICT: ${report.verdict}`)
switch (report.verdict) {
  case 'safe_to_promote':
    console.log('  Parity held and the candidate is measurably faster. Promote to Preview-wide,')
    console.log('  then Production behind the flag, watching the same guardrails on live traffic.')
    break
  case 'no_regression_no_benefit':
    console.log('  Harmless but pointless. Do not add a flag to Production for this.')
    break
  case 'parity_regression':
    console.log('  A guardrail moved. DO NOT promote. The speed is real and irrelevant.')
    break
  case 'insufficient_samples':
    console.log(`  Fewer than ${t.minPairs} pairs — no verdict is meaningful yet. Collect more.`)
    break
}
console.log(`\n${arm.note}\n`)
