// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — reports.
//
// Six reports, deliberately separated because they answer different questions and
// have different evidence requirements:
//
//   coverage     what the dataset contains, and where the GAPS are
//   duplicates   exact + near duplicates, and split leakage
//   latency      p50/p90/p95 against the product targets, split by job type
//   accuracy     only over images a human labelled — never over model output
//   calibration  does stated confidence predict actual correctness
//   failures     the gallery of cases worth a human's attention
//
// A REPORT THAT CANNOT BE COMPUTED SAYS SO. Accuracy over zero labelled images is
// not "100%" and not "0%" — it is unavailable, and printing a number there would
// be the single most misleading thing this tool could do.
//
// Accuracy is reported PER JOB TYPE. Junk removal and moving have different
// inventories, different volume distributions and different pricing rules; one
// pooled number would hide a regression in whichever type has fewer samples.
//
// Run: npx tsx tools/vision-benchmark/report.ts [results/run-….json]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  datasetRoot, paths, loadManifest, loadGroups, loadRejected,
  coverage, distributions, findDuplicates, splitLeakage,
} from './dataset'
import { ALL_CATEGORIES } from './queries'
import { hasGroundTruth, type ManifestEntry, type JobType, type Range } from './schema'
import type { BenchResult } from './run-benchmark'

const pct = (n: number, d: number) => d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`
const UNAVAILABLE = 'unavailable — no human-labelled ground truth yet'

function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))]
}

// ── Product latency targets (from the product requirement) ───────────────────
export const LATENCY_TARGETS = { p50Max: 15_000, p90Max: 25_000, p95Max: 30_000, hardCeiling: 45_000 }

// ── 1. Coverage ──────────────────────────────────────────────────────────────
export function coverageReport(entries: ManifestEntry[]): string {
  const rows = coverage(entries, ALL_CATEGORIES)
  const dist = distributions(entries)
  const out: string[] = ['## Category coverage', '']
  out.push('| job type | category | total | approved | labelled | dev | holdout | edge |')
  out.push('|---|---|---:|---:|---:|---:|---:|---:|')
  for (const r of rows) {
    out.push(`| ${r.jobType} | ${r.category} | ${r.total} | ${r.approved} | ${r.labelled} | ${r.development} | ${r.holdout} | ${r.edge_case} |`)
  }
  const gaps = rows.filter(r => r.total === 0)
  out.push('', `**Empty categories (${gaps.length}/${rows.length}):** ${gaps.length ? gaps.map(g => g.category).join(', ') : 'none'}`)
  out.push('', '## Distributions', '')
  for (const [name, m] of [['lighting', dist.lighting], ['clutter', dist.clutter], ['image quality', dist.imageQuality]] as const) {
    out.push(`- **${name}**: ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  }
  out.push(`- **licences**: ${Object.entries(dist.licenses).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  out.push(`- **source concentration**: top domain holds ${(dist.topDomainShare * 100).toFixed(0)}% of images` +
    (dist.topDomainShare > 0.6 ? ' ⚠ one source dominates — diversify before drawing conclusions' : ''))
  return out.join('\n')
}

// ── 2. Duplicates ────────────────────────────────────────────────────────────
export function duplicateReport(entries: ManifestEntry[]): string {
  const d = findDuplicates(entries)
  const leaks = splitLeakage(entries)
  const out: string[] = ['## Duplicates', '']
  out.push(`- exact duplicate clusters: **${d.exact.length}**`)
  out.push(`- near-duplicate pairs: **${d.near.length}**`)
  out.push(`- redundant ids (safe to drop): **${d.redundantIds.length}**`)
  if (d.near.length) {
    out.push('', '| a | b | hamming |', '|---|---|---:|')
    for (const n of d.near.slice(0, 25)) out.push(`| ${n.a} | ${n.b} | ${n.distance} |`)
  }
  out.push('', leaks.length
    ? `⚠ **SPLIT LEAKAGE: ${leaks.length} near-duplicate pairs straddle different splits.** A photo tuned against in development is reachable in the holdout. Re-run organise before trusting any holdout number.`
    : '✅ No split leakage: every near-duplicate cluster sits in one split.')
  return out.join('\n')
}

// ── 3. Latency ───────────────────────────────────────────────────────────────
export function latencyReport(results: BenchResult[]): string {
  const out: string[] = ['## Latency', '']
  if (results.length === 0) return out.concat('No benchmark run found.').join('\n')
  const t = LATENCY_TARGETS
  out.push('| job type | n | p50 | p90 | p95 | max | p50 ✓ | p90 ✓ | p95 ✓ | over ceiling |')
  out.push('|---|---:|---:|---:|---:|---:|---|---|---|---:|')
  const groups: Array<[string, BenchResult[]]> = [
    ['all', results],
    ['junk_removal', results.filter(r => r.jobType === 'junk_removal')],
    ['moving', results.filter(r => r.jobType === 'moving')],
  ]
  for (const [name, rs] of groups) {
    if (rs.length === 0) { out.push(`| ${name} | 0 | — | — | — | — | — | — | — | — |`); continue }
    const lat = rs.map(r => r.latencyMs)
    const p50 = percentile(lat, 50), p90 = percentile(lat, 90), p95 = percentile(lat, 95)
    const over = rs.filter(r => r.latencyMs > t.hardCeiling).length
    const ok = (v: number, max: number) => v <= max ? '✅' : '❌'
    out.push(`| ${name} | ${rs.length} | ${p50} | ${p90} | ${p95} | ${Math.max(...lat)} | ${ok(p50, t.p50Max)} | ${ok(p90, t.p90Max)} | ${ok(p95, t.p95Max)} | ${over} |`)
  }
  out.push('', `Targets: p50 ≤ ${t.p50Max / 1000}s · p90 ≤ ${t.p90Max / 1000}s · p95 ≤ ${t.p95Max / 1000}s · hard ceiling ${t.hardCeiling / 1000}s`)

  const timeouts = results.filter(r => r.degraded != null).length
  const kills = results.filter(r => !r.ok && r.httpStatus >= 500).length
  const decisions = ['instant_quote', 'estimate_range', 'manual_review']
  out.push('', '## Outcome distribution', '')
  out.push('| outcome | all | junk | moving |', '|---|---:|---:|---:|')
  for (const d of decisions) {
    const c = (rs: BenchResult[]) => pct(rs.filter(r => r.decision === d).length, rs.length)
    out.push(`| ${d} | ${c(results)} | ${c(groups[1][1])} | ${c(groups[2][1])} |`)
  }
  out.push(`| budget timeout | ${pct(timeouts, results.length)} | | |`)
  out.push(`| platform kill / 5xx | ${pct(kills, results.length)} | | |`)
  out.push(`| structured output valid | ${pct(results.filter(r => r.structuredOutputValid).length, results.length)} | | |`)
  return out.join('\n')
}

// ── 4. Accuracy (per job type, labelled images only) ─────────────────────────
const mid = (r: Range) => (r.min + r.max) / 2
const withinRange = (v: number, r: Range) => v >= r.min && v <= r.max
/** Signed error against the nearest edge of the accepted range; 0 when inside. */
function rangeError(v: number, r: Range): number {
  if (withinRange(v, r)) return 0
  return v < r.min ? (v - r.min) / Math.max(1e-6, mid(r)) : (v - r.max) / Math.max(1e-6, mid(r))
}

export function accuracyReport(entries: ManifestEntry[], results: BenchResult[]): string {
  const out: string[] = ['## Accuracy', '']
  const byId = new Map(entries.map(e => [e.id, e]))
  const scorable = results.filter(r => r.imageIds.length === 1 && byId.has(r.imageIds[0]) && hasGroundTruth(byId.get(r.imageIds[0])!))
  if (scorable.length === 0) {
    out.push(`**${UNAVAILABLE}.**`, '',
      'Accuracy is scored only against ranges a human entered in the review UI. Until images',
      'are labelled there is nothing to score against, and any number printed here would be',
      'the model grading its own homework.')
    return out.join('\n')
  }
  out.push('| job type | n | item recall | vol. within range | truck-space within range | mean vol. error | underquote | overquote |')
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const jt of ['junk_removal', 'moving'] as JobType[]) {
    const rs = scorable.filter(r => r.jobType === jt)
    if (rs.length === 0) { out.push(`| ${jt} | 0 | — | — | — | — | — | — |`); continue }
    let recallNum = 0, recallDen = 0, volIn = 0, volDen = 0, truckIn = 0, truckDen = 0
    let volErrSum = 0, under = 0, over = 0
    for (const r of rs) {
      const gt = byId.get(r.imageIds[0])!
      const detected = r.items.map(i => i.label.toLowerCase())
      for (const expected of gt.expectedObjects) {
        recallDen++
        if (detected.some(d => d.includes(expected.toLowerCase()) || expected.toLowerCase().includes(d))) recallNum++
      }
      // Truck loads → cubic yards using the same 44 cu yd truck the analyzer assumes.
      if (gt.expectedVolumeRangeCubicYards && r.estimatedTruckLoads != null) {
        const cuYd = r.estimatedTruckLoads * 44
        volDen++
        if (withinRange(cuYd, gt.expectedVolumeRangeCubicYards)) volIn++
        const err = rangeError(cuYd, gt.expectedVolumeRangeCubicYards)
        volErrSum += Math.abs(err)
        if (err < 0) under++; else if (err > 0) over++
      }
      if (gt.expectedTruckSpaceRangePercent && r.estimatedTruckLoads != null) {
        truckDen++
        if (withinRange(r.estimatedTruckLoads * 100, gt.expectedTruckSpaceRangePercent)) truckIn++
      }
    }
    out.push(`| ${jt} | ${rs.length} | ${pct(recallNum, recallDen)} | ${pct(volIn, volDen)} | ${pct(truckIn, truckDen)} | ${volDen ? (volErrSum / volDen * 100).toFixed(0) + '%' : '—'} | ${pct(under, volDen)} | ${pct(over, volDen)} |`)
  }
  out.push('', `Scored over ${scorable.length} single-image jobs with human labels. Multi-photo groups are excluded until group-level ground truth exists.`)
  return out.join('\n')
}

// ── 5. Confidence calibration ────────────────────────────────────────────────
export function calibrationReport(entries: ManifestEntry[], results: BenchResult[]): string {
  const out: string[] = ['## Confidence calibration', '']
  const byId = new Map(entries.map(e => [e.id, e]))
  const scorable = results.filter(r =>
    r.confidence != null && r.imageIds.length === 1 && byId.has(r.imageIds[0]) && hasGroundTruth(byId.get(r.imageIds[0])!))
  if (scorable.length === 0) {
    out.push(`**${UNAVAILABLE}.**`, '',
      'Calibration asks whether stated confidence predicts actual correctness. That needs',
      'both a confidence score AND an independent answer; without labels only half exists.')
    return out.join('\n')
  }
  const bands: Array<[string, (c: number) => boolean]> = [
    ['0.9–1.0', c => c >= 0.9], ['0.8–0.9', c => c >= 0.8 && c < 0.9],
    ['0.7–0.8', c => c >= 0.7 && c < 0.8], ['< 0.7', c => c < 0.7],
  ]
  out.push('| confidence band | n | within volume range | false-high-confidence | manual review |')
  out.push('|---|---:|---:|---:|---:|')
  for (const [label, pred] of bands) {
    const rs = scorable.filter(r => pred(r.confidence!))
    if (rs.length === 0) { out.push(`| ${label} | 0 | — | — | — |`); continue }
    let inRange = 0, falseHigh = 0
    for (const r of rs) {
      const gt = byId.get(r.imageIds[0])!
      const cuYd = (r.estimatedTruckLoads ?? 0) * 44
      const ok = gt.expectedVolumeRangeCubicYards ? withinRange(cuYd, gt.expectedVolumeRangeCubicYards) : false
      if (ok) inRange++
      // The serious failure: confident AND materially wrong.
      if (!ok && r.confidence! >= 0.8) falseHigh++
    }
    out.push(`| ${label} | ${rs.length} | ${pct(inRange, rs.length)} | ${pct(falseHigh, rs.length)} | ${pct(rs.filter(r => r.decision === 'manual_review').length, rs.length)} |`)
  }
  out.push('', 'A confident-and-wrong result is worse than an uncertain one: the customer is quoted a',
    'number nobody checked. `false-high-confidence` is therefore the column that matters most,',
    'and it should fall as confidence rises. If it does not, confidence is being driven by',
    'model phrasing rather than measurable evidence.')
  return out.join('\n')
}

// ── 6. Failure gallery ───────────────────────────────────────────────────────
export function failureReport(entries: ManifestEntry[], results: BenchResult[]): string {
  const byId = new Map(entries.map(e => [e.id, e]))
  const failures = results.filter(r =>
    !r.ok || r.degraded != null || !r.structuredOutputValid || r.itemCount === 0 || r.latencyMs > LATENCY_TARGETS.hardCeiling)
  const out: string[] = ['## Failure-case gallery', '']
  if (failures.length === 0) return out.concat('No failures in this run.').join('\n')
  out.push(`${failures.length} of ${results.length} jobs need a look.`, '')
  out.push('| job | category | why | latency | decision | source |', '|---|---|---|---:|---|---|')
  for (const f of failures.slice(0, 60)) {
    const why = [
      !f.ok ? `http ${f.httpStatus}` : '', f.degraded ? f.degraded : '',
      !f.structuredOutputValid ? 'invalid structured output' : '',
      f.itemCount === 0 ? 'no items detected' : '',
      f.latencyMs > LATENCY_TARGETS.hardCeiling ? 'over hard ceiling' : '',
      f.error ?? '',
    ].filter(Boolean).join('; ')
    const src = byId.get(f.imageIds[0])?.sourcePageUrl ?? ''
    out.push(`| ${f.jobId} | ${f.category} | ${why} | ${f.latencyMs}ms | ${f.decision ?? '—'} | ${src ? `[src](${src})` : '—'} |`)
  }
  return out.join('\n')
}

// ── Driver ───────────────────────────────────────────────────────────────────
function latestRun(dir: string): BenchResult[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  if (files.length === 0) return []
  try {
    const j = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')) as { results?: BenchResult[] }
    return j.results ?? []
  } catch { return [] }
}

const root = datasetRoot()
const p = paths(root)
const entries = loadManifest(root)
const explicit = process.argv.slice(2).find(a => a.endsWith('.json'))
const results = explicit
  ? (JSON.parse(readFileSync(explicit, 'utf8')) as { results?: BenchResult[] }).results ?? []
  : latestRun(p.results)

const doc = [
  `# Vision benchmark report`,
  ``,
  `- dataset: \`${root}\``,
  `- images: **${entries.length}** · approved: **${entries.filter(e => e.reviewStatus === 'approved').length}** · labelled: **${entries.filter(e => hasGroundTruth(e)).length}**`,
  `- job groups: **${loadGroups(root).length}** · rejected sources logged: **${loadRejected(root).length}**`,
  `- benchmark jobs in this run: **${results.length}**`,
  ``,
  coverageReport(entries), ``,
  duplicateReport(entries), ``,
  latencyReport(results), ``,
  accuracyReport(entries, results), ``,
  calibrationReport(entries, results), ``,
  failureReport(entries, results), ``,
].join('\n')

mkdirSync(p.reports, { recursive: true })
const out = join(p.reports, 'report.md')
writeFileSync(out, doc)
console.log(doc)
console.log(`\n  written → ${out}\n`)
