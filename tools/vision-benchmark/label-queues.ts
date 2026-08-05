// ─────────────────────────────────────────────────────────────────────────────
// Prioritised human-labelling queues.
//
// 13 of 210 entries are verified. The constraint on calibration is labelled
// data, not matcher code, and a labeller working an unordered 146-entry list
// spends most of their attention deciding what to open next. These queues make
// that decision once, in code, against the category coverage the benchmark
// actually needs.
//
// Two hard rules, both learned the expensive way:
//
//   1. NOTHING here rejects anything. Weak candidates are FLAGGED into a review
//      queue for a human to judge. An automatic reject is indistinguishable from
//      a labelling decision once it is in the manifest, and the owner's own
//      review already found stock pools full of images a rule would misread.
//   2. A prior human rejection is permanent. Rejected entries never appear in a
//      work queue — not even to "re-check" them.
// ─────────────────────────────────────────────────────────────────────────────

import { loadManifest } from './dataset'
import type { JobType, ManifestEntry } from './schema'

/** Categories the benchmark needs most, in priority order, per lane. */
export const PRIORITY_CATEGORIES: Record<JobType, string[]> = {
  junk_removal: [
    'curbside_pile', 'garage_cleanout', 'apartment_cleanout', 'storage_unit_cleanout',
    'mattress', 'couch_sectional', 'major_appliance', 'bagged_trash', 'mixed_full_load',
    'yard_waste', 'construction_debris', 'office_cleanout', 'eviction_cleanout',
    'exercise_equipment', 'piano_heavy',
  ],
  moving: [
    'studio_inventory', 'one_bed_inventory', 'two_bed_inventory', 'three_bed_inventory',
    'boxed_goods', 'living_room_furniture', 'appliances_moving', 'stairs_access',
    'elevator_access', 'bulky_furniture', 'fragile_electronics', 'cluttered_room',
    'incomplete_room_coverage',
  ],
}

/** The verified counts a lane needs before calibration may even be discussed. */
export const CALIBRATION_TARGET = { development: 25, holdout: 5 } as const

/**
 * Advisory flags. Each marks a candidate as WORTH A SECOND LOOK, never as
 * rejected. `sensitive` routes to its own queue because those decisions are
 * about people rather than about junk.
 */
export type WeakFlag =
  | 'stock_product_photo' | 'showroom' | 'repair_teardown' | 'recycling_facility'
  | 'scrapyard' | 'third_party_dumpster' | 'demolition_only' | 'rendering'
  | 'street_scene' | 'no_pickup_context' | 'possible_duplicate'
  | 'identifiable_people' | 'readable_document' | 'visible_address' | 'license_plate'

export const SENSITIVE_FLAGS: WeakFlag[] = [
  'identifiable_people', 'readable_document', 'visible_address', 'license_plate',
]

const TEXT_SIGNALS: Array<[WeakFlag, RegExp]> = [
  ['stock_product_photo', /\b(product shot|white background|isolated on|catalog(ue)? image|stock photo)\b/i],
  ['showroom', /\b(showroom|display model|retail floor|store display)\b/i],
  ['repair_teardown', /\b(teardown|disassembl\w+ for repair|repair shop|workbench)\b/i],
  ['recycling_facility', /\b(recycling (centre|center|facility|plant)|materials recovery)\b/i],
  ['scrapyard', /\b(scrap ?yard|junkyard|salvage yard|wrecking yard)\b/i],
  ['third_party_dumpster', /\b(dumpster|skip bin|roll ?off)\b/i],
  ['demolition_only', /\b(demolition|gutted|structural teardown)\b/i],
  ['rendering', /\b(render(ing)?|3d model|cgi|illustration|clip ?art)\b/i],
  ['street_scene', /\b(street view|traffic|cityscape|skyline)\b/i],
]

/**
 * Flag a candidate from what the manifest already records. Deliberately weak:
 * it reads text the acquisition step captured and the labeller's own marks. It
 * does NOT look at pixels and must never be described as image understanding.
 */
export function weakFlags(e: ManifestEntry, seenPhash = new Map<string, string>()): WeakFlag[] {
  const flags: WeakFlag[] = []
  const haystack = [e.searchQuery, e.notes, e.sourcePageUrl, e.category].filter(Boolean).join(' ')
  for (const [flag, re] of TEXT_SIGNALS) if (re.test(haystack)) flags.push(flag)
  if (e.containsPeople) flags.push('identifiable_people')
  // phash collision against an already-seen entry — the acquisition step stores it.
  if (e.phash) {
    const owner = seenPhash.get(e.phash)
    if (owner && owner !== e.id) flags.push('possible_duplicate')
    else seenPhash.set(e.phash, e.id)
  }
  return flags
}

export type QueueName =
  | 'junk_development' | 'moving_development'
  | 'junk_holdout' | 'moving_holdout'
  | 'sensitive_review' | 'weak_review' | 'multi_photo_acquisition'

export type RankedCandidate = {
  id: string
  jobType: JobType
  category: string
  split: string
  score: number
  reasons: string[]
  flags: WeakFlag[]
}

/**
 * Rank one candidate. Higher is better. The weights encode what actually makes
 * a labelling hour pay: an unrepresented priority category is worth far more
 * than a fourth example of one already covered.
 */
function scoreCandidate(
  e: ManifestEntry, verifiedCategoryCounts: Map<string, number>, flags: WeakFlag[],
): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  const priority = PRIORITY_CATEGORIES[e.jobType as JobType] ?? []
  const rank = priority.indexOf(e.category)
  if (rank >= 0) { score += 40 - rank; reasons.push(`priority category (#${rank + 1})`) }

  const already = verifiedCategoryCounts.get(e.category) ?? 0
  if (already === 0) { score += 30; reasons.push('category not yet represented') }
  else if (already === 1) { score += 12; reasons.push('category has only one verified example') }
  else { score -= already * 4; reasons.push(`category already has ${already} verified`) }

  if (e.reviewStatus === 'approved') { score += 15; reasons.push('already approved') }
  if (e.licenseVerified) { score += 8; reasons.push('licence verified') }
  if (e.imageQuality === 'high') { score += 10; reasons.push('high image quality') }
  else if (e.imageQuality === 'medium') { score += 6; reasons.push('medium image quality') }
  else if (e.imageQuality === 'low') { score -= 8; reasons.push('low image quality') }
  if ((e.widthPx ?? 0) >= 1200) { score += 5; reasons.push('large enough to judge volume') }

  if (flags.length) { score -= 12 * flags.length; reasons.push(`flagged: ${flags.join(', ')}`) }
  return { score, reasons }
}

export type Queues = Record<QueueName, RankedCandidate[]>

/**
 * Build every queue from the manifest. Lanes never mix, rejections never
 * reappear, and holdout candidates are drawn only from entries already sitting
 * in the holdout split — the labeller cannot move an entry between splits.
 */
export function buildQueues(entries: ManifestEntry[]): Queues {
  const verified = entries.filter(e => e.labelStatus === 'verified')
  const counts = new Map<string, number>()
  for (const e of verified) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)

  const seenPhash = new Map<string, string>()
  for (const e of verified) if (e.phash) seenPhash.set(e.phash, e.id)

  const q: Queues = {
    junk_development: [], moving_development: [], junk_holdout: [], moving_holdout: [],
    sensitive_review: [], weak_review: [], multi_photo_acquisition: [],
  }

  // A prior human rejection is permanent — it never enters any work queue.
  const workable = entries.filter(e => e.reviewStatus !== 'rejected' && e.labelStatus !== 'verified')

  for (const e of workable) {
    const flags = weakFlags(e, seenPhash)
    const { score, reasons } = scoreCandidate(e, counts, flags)
    const c: RankedCandidate = {
      id: e.id, jobType: e.jobType as JobType, category: e.category,
      split: e.split, score, reasons, flags,
    }
    const sensitive = flags.some(f => SENSITIVE_FLAGS.includes(f))
    if (sensitive) { q.sensitive_review.push(c); continue }
    if (flags.length) { q.weak_review.push(c); continue }
    if (e.split === 'holdout') {
      ;(e.jobType === 'moving' ? q.moving_holdout : q.junk_holdout).push(c)
    } else {
      ;(e.jobType === 'moving' ? q.moving_development : q.junk_development).push(c)
    }
  }

  for (const k of Object.keys(q) as QueueName[]) q[k].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return q
}

export type LaneProgress = {
  jobType: JobType
  developmentVerified: number
  holdoutVerified: number
  developmentTarget: number
  holdoutTarget: number
  categoriesRepresented: string[]
  missingPriorityCategories: string[]
  difficultyBands: string[]
}

/** Per-lane progress against the calibration target. Never a combined total. */
export function laneProgress(entries: ManifestEntry[], jobType: JobType): LaneProgress {
  const verified = entries.filter(e => e.jobType === jobType && e.labelStatus === 'verified')
  const cats = [...new Set(verified.map(e => e.category))].sort()
  return {
    jobType,
    developmentVerified: verified.filter(e => e.split === 'development').length,
    holdoutVerified: verified.filter(e => e.split === 'holdout').length,
    developmentTarget: CALIBRATION_TARGET.development,
    holdoutTarget: CALIBRATION_TARGET.holdout,
    categoriesRepresented: cats,
    missingPriorityCategories: (PRIORITY_CATEGORIES[jobType] ?? []).filter(c => !cats.includes(c)),
    difficultyBands: [...new Set(verified.map(e => e.difficulty).filter(Boolean) as string[])].sort(),
  }
}

/** The next N candidates a human should actually open, for one lane. */
export function batch(entries: ManifestEntry[], jobType: JobType, size = 10): RankedCandidate[] {
  const q = buildQueues(entries)
  return (jobType === 'moving' ? q.moving_development : q.junk_development).slice(0, size)
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `npx tsx tools/vision-benchmark/label-queues.ts [--lane=junk_removal] [--size=10]`
// Prints the queues and the next human batch. Read-only: it never writes to the
// manifest, so running it can never change a label or a split.

function main(): void {
  const entries = loadManifest()
  const argv = process.argv.slice(2)
  const size = Number(argv.find(a => a.startsWith('--size='))?.split('=')[1]) || 10
  const only = argv.find(a => a.startsWith('--lane='))?.split('=')[1] as JobType | undefined

  const q = buildQueues(entries)
  console.log('\n=== Labelling queues ===\n')
  for (const [name, rows] of Object.entries(q)) {
    console.log(`  ${name.padEnd(26)} ${String(rows.length).padStart(4)}`)
  }

  for (const lane of (only ? [only] : ['junk_removal', 'moving']) as JobType[]) {
    const p = laneProgress(entries, lane)
    const done = p.developmentVerified >= p.developmentTarget && p.holdoutVerified >= p.holdoutTarget
    console.log(`\n── ${lane} ${done ? '✔ target met' : ''}`)
    console.log(`   development ${p.developmentVerified}/${p.developmentTarget} · holdout ${p.holdoutVerified}/${p.holdoutTarget}`)
    console.log(`   categories represented : ${p.categoriesRepresented.join(', ') || '(none)'}`)
    console.log(`   missing priority       : ${p.missingPriorityCategories.join(', ') || '(none)'}`)
    console.log(`   difficulty bands       : ${p.difficultyBands.join(', ') || '(none)'}`)
    console.log(`\n   NEXT ${size} TO LABEL:`)
    for (const c of batch(entries, lane, size)) {
      console.log(`     ${String(c.score).padStart(3)}  ${c.category.padEnd(24)} ${c.id}`)
      console.log(`          ${c.reasons.join(' · ')}`)
    }
  }
  console.log('\n  Nothing here is rejected or written. Human judgement remains final.\n')
}

if (require.main === module) main()
