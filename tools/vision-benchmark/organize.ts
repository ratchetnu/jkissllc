// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — split assignment and multi-photo job grouping.
//
// SPLITS. Development / holdout / edge-case, assigned once and never moved.
// Near-duplicate clusters are assigned as a unit, so the same scene cannot appear
// on both sides of the wall in a different crop. Anything a labeller marked
// `#edge` goes to the edge-case set. Re-running is safe: existing assignments are
// preserved, only unassigned images get a split.
//
// JOB GROUPS. A real customer uploads several photos of ONE job, and cross-photo
// deduplication is part of what we are measuring. The best automatic proxy for
// "several views of one job" is a near-duplicate cluster within a single category
// — the same scene photographed twice. Groups are PROPOSED here and left
// `pending`: whether two photos really are one job is a human judgement, and a
// wrong group would corrupt every volume number computed from it.
//
// Run: npx tsx tools/vision-benchmark/organize.ts [--apply]
// ─────────────────────────────────────────────────────────────────────────────

import {
  datasetRoot, loadManifest, saveManifest, loadGroups, saveGroups,
  planSplits, findDuplicates, nearDuplicateClusters, splitLeakage,
} from './dataset'
import type { JobGroup, ManifestEntry } from './schema'

/** Propose multi-photo groups from near-duplicate clusters inside one category. */
export function proposeGroups(entries: ManifestEntry[], existing: JobGroup[]): JobGroup[] {
  const already = new Set(existing.flatMap(g => g.imageIds))
  const dupes = findDuplicates(entries)
  const cluster = nearDuplicateClusters(entries, dupes)
  const byId = new Map(entries.map(e => [e.id, e]))

  const members = new Map<string, string[]>()
  for (const e of entries) {
    if (already.has(e.id)) continue
    const c = cluster.get(e.id)!
    members.set(c, [...(members.get(c) ?? []), e.id])
  }

  const proposed: JobGroup[] = []
  for (const [rep, ids] of members) {
    if (ids.length < 2) continue
    const first = byId.get(ids[0])!
    // Never group across categories or job types — that is not one job.
    if (!ids.every(id => byId.get(id)!.category === first.category && byId.get(id)!.jobType === first.jobType)) continue
    proposed.push({
      id: `grp_${first.jobType === 'moving' ? 'mv' : 'jr'}_${first.category}_${rep.slice(-8)}`,
      jobType: first.jobType,
      category: first.category,
      imageIds: ids,
      reviewStatus: 'pending',
      notes: 'AUTO: near-duplicate cluster — confirm these are views of ONE job before approving',
      split: byId.get(ids[0])!.split,
    })
  }
  return proposed
}

function main(): void {
  const apply = process.argv.includes('--apply')
  const root = datasetRoot()
  const entries = loadManifest(root)

  if (entries.length === 0) {
  console.log('\n  No manifest yet. Run acquire.ts first.\n')
  } else {
  const plan = planSplits(entries)
  const bySplit = new Map<string, string>()
  for (const id of plan.development) bySplit.set(id, 'development')
  for (const id of plan.holdout) bySplit.set(id, 'holdout')
  for (const id of plan.edge_case) bySplit.set(id, 'edge_case')

  const changed = entries.filter(e => e.split !== bySplit.get(e.id))
  const updated = entries.map(e => ({ ...e, split: (bySplit.get(e.id) ?? e.split) as ManifestEntry['split'] }))
  const groups = loadGroups(root)
  const newGroups = proposeGroups(updated, groups)

  console.log(`\n  images            : ${entries.length}`)
  console.log(`  development       : ${plan.development.length}`)
  console.log(`  holdout           : ${plan.holdout.length}`)
  console.log(`  edge cases        : ${plan.edge_case.length}`)
  console.log(`  newly assigned    : ${changed.length}`)
  console.log(`  existing groups   : ${groups.length}`)
  console.log(`  proposed groups   : ${newGroups.length} (pending human confirmation)`)

  if (apply) {
    saveManifest(updated, root)
    saveGroups([...groups, ...newGroups], root)
    const leaks = splitLeakage(updated)
    console.log(`\n  applied.`)
    console.log(leaks.length
      ? `  ⚠ SPLIT LEAKAGE: ${leaks.length} near-duplicate pairs straddle splits — investigate before using the holdout.`
      : `  ✅ no split leakage`)
    console.log(`\n  The holdout is now frozen. Do not develop prompts against it.\n`)
  } else {
    console.log(`\n  dry run — nothing written. Re-run with --apply.\n`)
  }
  }
}

if (require.main === module) main()
