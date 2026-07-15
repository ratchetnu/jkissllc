// ─────────────────────────────────────────────────────────────────────────────
// scripts/eval-photo-estimator.mjs — the runnable offline evaluation.
//
//   npm run eval:photo-estimator
//
// Runs the DETERMINISTIC V2 photo-estimator pipeline (v2-bridge + load-tier +
// confidence + clarify-v2) over the stored, privacy-safe fixture analyses
// (app/lib/estimation/fixtures.ts) and prints a readable per-case table + the
// aggregate metrics + the regression-threshold verdict. Exits non-zero if any
// EVAL_THRESHOLDS gate is breached, so CI (and `npm run predeploy`) catch a
// silent regression in the deterministic estimator.
//
// NO live AI calls, NO real customer photos — fixtures are hand-authored,
// anonymized structured outputs. Deterministic + reproducible.
// ─────────────────────────────────────────────────────────────────────────────

import { runEval } from '../app/lib/estimation/eval-harness.ts'
import { FIXTURES } from '../app/lib/estimation/fixtures.ts'

const pct = (n) => `${(n * 100).toFixed(0)}%`
const yn = (b) => (b ? 'yes' : 'no')

const report = runEval(FIXTURES)

// ── Per-case table ────────────────────────────────────────────────────────────
console.log('\nV2 PHOTO-ESTIMATOR OFFLINE EVAL')
console.log('='.repeat(96))
const header =
  'case'.padEnd(26) +
  'tier'.padEnd(20) +
  'cu-yd(exp)'.padEnd(12) +
  'cnt'.padEnd(5) +
  'rev'.padEnd(5) +
  'haz'.padEnd(5) +
  'spc'.padEnd(5) +
  'clr'.padEnd(5) +
  'result'
console.log(header)
console.log('-'.repeat(96))
for (const c of report.perCase) {
  const row =
    c.id.padEnd(26) +
    c.predictedTier.padEnd(20) +
    String(c.detVolumeCuYd.expected).padEnd(12) +
    String(c.predictedItemCount).padEnd(5) +
    yn(c.predictedManualReview).padEnd(5) +
    yn(c.predictedHazard).padEnd(5) +
    yn(c.predictedSpecialty).padEnd(5) +
    String(c.predictedClarificationCount).padEnd(5) +
    (c.pass ? 'PASS' : 'FAIL')
  console.log(row)
  if (!c.pass) for (const f of c.failures) console.log('    - ' + f)
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────
const m = report.metrics
console.log('\nMETRICS')
console.log('-'.repeat(96))
console.log(`  inventory precision / recall     ${pct(m.inventoryPrecision)} / ${pct(m.inventoryRecall)}`)
console.log(`  count accuracy (mean abs err)    ${pct(m.countAccuracy)} (${m.meanCountAbsError})`)
console.log(`  duplicate-object error rate      ${pct(m.duplicateErrorRate)}  (${m.duplicateCaseCount} dedup cases)`)
console.log(`  volume coverage (mean abs err)   ${pct(m.volumeCoverageRate)} (${m.meanVolumeAbsError} cu-yd)`)
console.log(`  load-tier exact / within-one     ${pct(m.loadTierExactAccuracy)} / ${pct(m.loadTierWithinOneAccuracy)}`)
console.log(`  quote-range presence             ${pct(m.quoteRangePresenceRate)}`)
console.log(`  manual-review recall             ${pct(m.manualReviewRecall)}`)
console.log(`  hazard / specialty recall        ${pct(m.hazardRecall)} / ${pct(m.specialtyRecall)}`)
console.log(`  clarification recall             ${pct(m.clarificationRecall)}`)

// ── Threshold gates ───────────────────────────────────────────────────────────
console.log('\nREGRESSION GATES')
console.log('-'.repeat(96))
const t = report.thresholds
console.log(`  inventoryRecall        >= ${pct(t.minInventoryRecall)}   -> ${pct(m.inventoryRecall)}`)
console.log(`  duplicateErrorRate     <= ${pct(t.maxDuplicateErrorRate)}    -> ${pct(m.duplicateErrorRate)}`)
console.log(`  loadTierWithinOne      >= ${pct(t.minLoadTierWithinOne)}   -> ${pct(m.loadTierWithinOneAccuracy)}`)
console.log(`  manualReviewRecall     >= ${pct(t.minManualReviewRecall)}  -> ${pct(m.manualReviewRecall)}`)
console.log(`  hazardRecall           >= ${pct(t.minHazardRecall)}  -> ${pct(m.hazardRecall)}`)
console.log(`  volumeCoverageMiss     <= ${pct(t.maxVolumeCoverageMiss)}   -> ${pct(m.volumeCoverageMiss)}`)

console.log('\n' + '='.repeat(96))
console.log(`CASES: ${report.totals.passed}/${report.totals.cases} passed`)
if (report.breaches.length) {
  console.log('THRESHOLD BREACHES:')
  for (const b of report.breaches) console.log('  - ' + b)
}
console.log(report.pass ? 'RESULT: PASS' : 'RESULT: FAIL')
console.log('='.repeat(96) + '\n')

process.exit(report.pass ? 0 : 1)
