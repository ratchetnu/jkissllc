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

/**
 * SMALL-PILOT gates. Deliberately lowered from the original ten because the
 * owner's own review found only five of eleven stock images to be truck-loadable
 * junk-removal jobs — the Openverse pool simply does not contain many real ones.
 *
 * Five images is enough to measure inference success, structured-output
 * validity, latency, token use, cost, critic invocation and decision
 * distribution. It is NOT enough for accuracy, calibration or category-general
 * claims, and PILOT_LIMITATIONS below must accompany every result.
 */
export const READINESS_GATES = {
  minVerified: 5,
  minCategories: 5,          // five distinct categories across five images
  minDifficulties: 1,        // relaxed for the first latency/cost pilot
  maxSourceConcentration: 0.6,
  minDevelopmentVerified: 4, // the single holdout image stays frozen
}

/**
 * MOVING gates. Not a relaxed copy of the junk pilot — the moving set is the one
 * that is actually complete. The owner labelled the whole approved moving queue:
 * ten verified images, one of them the frozen holdout, so nine development labels
 * are the maximum obtainable and the gate says nine rather than "most of them".
 *
 * minVerified is TEN, not five. There is no reason to lower it: unlike the junk
 * pool, this one is already full. If a moving image is later rejected, the honest
 * response is to promote a replacement — not to move this number.
 */
export const MOVING_READINESS_GATES = {
  minVerified: 10,
  minCategories: 5,
  minDifficulties: 1,
  maxSourceConcentration: 0.6,
  minDevelopmentVerified: 9, // ten verified minus the one frozen holdout
}

export function gatesFor(jobType: JobType): typeof READINESS_GATES {
  return jobType === 'moving' ? MOVING_READINESS_GATES : READINESS_GATES
}

/**
 * At or below this many verified images, every artefact must carry PILOT_BANNER.
 * Ten was the original gate; the pilot runs under it deliberately, so the
 * warning is bound to the actual sample size rather than to a flag someone has
 * to remember to unset later.
 */
export const SMALL_PILOT_MAX_VERIFIED = 9

/** Must appear on every artefact produced from this pilot. */
export const PILOT_BANNER = 'small pilot — directional only'
export const PILOT_LIMITATIONS = [
  'Sample is 5 images: latency percentiles are directional, not statistically meaningful.',
  'Does NOT establish production accuracy.',
  'Does NOT establish representative junk-removal coverage.',
  'Does NOT establish reliable confidence calibration.',
  'Does NOT establish final volume accuracy.',
  'Does NOT establish final pricing accuracy.',
  'Does NOT establish category-general performance.',
  'Difficulty banding relaxed to a single band for this run.',
]

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
  const g = gatesFor(jobType)

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

  // Bound to THIS LANE's verified count, which is what the banner always claimed
  // to be. It was printed unconditionally, and that was invisible only while every
  // lane happened to be small: the complete ten-image moving set was being stamped
  // "small pilot — directional only" alongside the five-image junk one.
  const smallPilot = r.verified > 0 && r.verified <= SMALL_PILOT_MAX_VERIFIED

  console.log(`\n=== Benchmark readiness — ${jobType} ===`)
  if (smallPilot) console.log(`    ${PILOT_BANNER.toUpperCase()}\n`)
  else console.log('')
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

  // The limitation list describes an UNDERSIZED sample. Printing it under a
  // complete one would train the reader to skip it, which is the one thing a
  // warning must never become.
  if (smallPilot) {
    console.log('\n  Limitations that MUST accompany any result from this pilot:')
    for (const l of PILOT_LIMITATIONS) console.log(`    • ${l}`)
  } else {
    console.log(`\n  Sample: ${r.verified} verified ${jobType} labels — above the small-pilot threshold of ${SMALL_PILOT_MAX_VERIFIED}.`)
    console.log('  Still NOT production accuracy: stock photos, one dominant source, no real job outcomes.')
  }

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
