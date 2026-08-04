// ─────────────────────────────────────────────────────────────────────────────
// Benchmark readiness — is the pilot actually ready to run?
//
// Distinct from report.ts, which analyses a completed RUN. This answers the
// question you ask BEFORE spending anything: do enough verified labels exist,
// across enough categories and difficulties, from enough sources, for the
// resulting numbers to mean something?
//
// It refuses to say "ready" on volume alone. A hundred images from one source,
// all easy, all one category, is not a benchmark — it is a demo. Each gate
// below has to pass on its own, and the ones that fail are named.
//
// Run: npx tsx tools/vision-benchmark/readiness.ts [--job-type=junk_removal]
// ─────────────────────────────────────────────────────────────────────────────

import { datasetRoot, loadManifest, distributions } from './dataset'
import { hasGroundTruth, type JobType, type ManifestEntry } from './schema'
import { ALL_CATEGORIES } from './queries'

/** Minimums below which a result is a demo, not a measurement. */
export const READINESS_GATES = {
  minVerified: 10,
  minCategories: 5,
  minDifficulties: 2,
  maxSourceConcentration: 0.6,
  minDevelopmentVerified: 8,
}

export type ReadinessGate = { name: string; pass: boolean; detail: string }
/**
 * A caveat does NOT block the run — it qualifies what the results may be called.
 * Source concentration is the standing example: the pilot is explicitly allowed
 * to proceed under-diversified, but any accuracy figure it produces is
 * pilot-only and must not be presented as production accuracy.
 */
export type ReadinessCaveat = { name: string; triggered: boolean; detail: string }

export function assessReadiness(entries: ManifestEntry[], jobType: JobType): {
  gates: ReadinessGate[]; caveats: ReadinessCaveat[]; ready: boolean
  approved: number; verified: number; rejected: number; drafts: number
} {
  const ofType = entries.filter(e => e.jobType === jobType)
  const approved = ofType.filter(e => e.reviewStatus === 'approved')
  const rejected = ofType.filter(e => e.reviewStatus === 'rejected')
  const drafts = ofType.filter(e => e.labelStatus === 'draft')
  const verified = approved.filter(hasGroundTruth)

  const cats = new Set(verified.map(e => e.category))
  const diffs = new Set(verified.map(e => e.difficulty).filter(Boolean))
  const devVerified = verified.filter(e => e.split === 'development').length
  const conc = distributions(approved).topDomainShare
  const g = READINESS_GATES

  const gates: ReadinessGate[] = [
    { name: 'verified labels', pass: verified.length >= g.minVerified,
      detail: `${verified.length} / ${g.minVerified} required` },
    { name: 'categories represented', pass: cats.size >= g.minCategories,
      detail: `${cats.size} / ${g.minCategories} required${cats.size ? ` — ${[...cats].sort().join(', ')}` : ''}` },
    { name: 'difficulty spread', pass: diffs.size >= g.minDifficulties,
      detail: `${diffs.size} / ${g.minDifficulties} bands${diffs.size ? ` — ${[...diffs].join(', ')}` : ''}` },
    { name: 'development-split labels', pass: devVerified >= g.minDevelopmentVerified,
      detail: `${devVerified} / ${g.minDevelopmentVerified} (the holdout stays frozen)` },
  ]
  const caveats: ReadinessCaveat[] = [
    { name: 'source concentration', triggered: conc > g.maxSourceConcentration,
      detail: `top source holds ${(conc * 100).toFixed(0)}% (target ≤ ${(g.maxSourceConcentration * 100).toFixed(0)}%) — results are PILOT-ONLY, not production accuracy` },
  ]
  return {
    gates, caveats, ready: gates.every(x => x.pass),
    approved: approved.length, verified: verified.length,
    rejected: rejected.length, drafts: drafts.length,
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const jobType = (argv.find(a => a.startsWith('--job-type='))?.split('=')[1] as JobType) ?? 'junk_removal'
  const entries = loadManifest(datasetRoot())
  const r = assessReadiness(entries, jobType)
  const ofType = entries.filter(e => e.jobType === jobType)
  const approved = ofType.filter(e => e.reviewStatus === 'approved')
  const verified = approved.filter(hasGroundTruth)

  console.log(`\n=== Benchmark readiness — ${jobType} ===\n`)
  console.log(`  approved        : ${r.approved}`)
  console.log(`  verified labels : ${r.verified}`)
  console.log(`  drafts          : ${r.drafts}`)
  console.log(`  rejected        : ${r.rejected}`)
  console.log(`  pending review  : ${ofType.filter(e => e.reviewStatus === 'pending').length}\n`)

  console.log('  Blocking gates')
  for (const g of r.gates) console.log(`    ${g.pass ? '✅' : '❌'} ${g.name.padEnd(26)} ${g.detail}`)
  const active = r.caveats.filter(c => c.triggered)
  if (active.length) {
    console.log('\n  Caveats (do NOT block the run — they qualify the claim)')
    for (const c of active) console.log(`    ⚠ ${c.name.padEnd(26)} ${c.detail}`)
  }

  // Difficulty mix over VERIFIED entries only — an unverified guess is not a data point.
  const byDiff = new Map<string, number>()
  for (const e of verified) byDiff.set(e.difficulty ?? 'unset', (byDiff.get(e.difficulty ?? 'unset') ?? 0) + 1)
  console.log(`\n  Difficulty (verified only): ${byDiff.size ? [...byDiff].map(([k, v]) => `${k} ${v}`).join(' · ') : 'none yet'}`)

  // Categories approved but not yet verified — the concrete labelling queue.
  const approvedCats = new Set(approved.map(e => e.category))
  const verifiedCats = new Set(verified.map(e => e.category))
  const awaiting = [...approvedCats].filter(c => !verifiedCats.has(c)).sort()
  console.log(`  Awaiting labels : ${awaiting.length ? awaiting.join(', ') : 'none'}`)

  // Taxonomy categories with no approved image at all — a dataset gap, not a queue.
  const taxonomy = ALL_CATEGORIES.filter(c => c.jobType === jobType).map(c => c.category)
  const missing = taxonomy.filter(c => !approvedCats.has(c))
  console.log(`  Never sourced   : ${missing.length}/${taxonomy.length}${missing.length ? ` — ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}` : ''}`)

  console.log(`\n  VERDICT: ${r.ready ? '✅ ready to run once credits are added' : '❌ NOT ready'}`)
  if (r.ready && r.caveats.some(c => c.triggered)) {
    console.log('  Results must be reported as PILOT-ONLY (see caveats above).')
  }
  if (!r.ready) {
    console.log('  Blocking gates:')
    for (const g of r.gates.filter(x => !x.pass)) console.log(`    • ${g.name} — ${g.detail}`)
  }
  console.log()
}

if (require.main === module) main()
