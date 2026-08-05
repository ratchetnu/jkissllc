// ─────────────────────────────────────────────────────────────────────────────
// Dataset curation commands.
//
//   dataset:screen        deterministic pre-screen only — free, no model calls
//   dataset:label         labeler only, for one candidate (debugging a prompt)
//   dataset:verify        verifier only, against an existing proposed label
//   dataset:consensus     replay the gate over stored results — free
//   dataset:review-queue  what a human must look at, and why
//   dataset:report        terminal-state distribution, Gold/Silver separated
//   dataset:auto          the full pipeline, dry-run first, spend-gated
//
// `dataset:auto` will not spend without a dry run, a printed estimate and — over
// the ceiling — an explicit confirmation. Concurrency is 1: a curation run is
// not latency-sensitive, and serial execution makes a partial run trivially
// resumable and its cost trivially attributable.
// ─────────────────────────────────────────────────────────────────────────────

import { loadManifest, datasetRoot, paths } from '../dataset'
import { estimateCost } from './tiers'
import { DEFAULT_ROLES, checkIndependence, modelForRole } from './roles'
import { preScreen } from './consensus'
import { fileCache, fileCheckpoint, runCandidate, type CandidateOutcome, type VisionCaller } from './runtime'
import type { JobType, ManifestEntry } from '../schema'

/** Per-call cost estimates. Deliberately generous — an under-estimate is worse. */
export const USD_PER_CALL: Record<string, number> = {
  'openai/gpt-4o': 0.012,
  'openai/gpt-4o-mini': 0.001,
  'openai/gpt-4.1-mini': 0.002,
}

export const DEFAULT_CEILING_USD = 2.0

const arg = (argv: string[], name: string): string | undefined =>
  argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

/** Selection: development split, never a prior human rejection, never holdout. */
export function selectCandidates(
  entries: ManifestEntry[], jobType: JobType, limit: number,
): ManifestEntry[] {
  const pool = entries.filter(e =>
    e.jobType === jobType
    && e.split === 'development'
    && e.reviewStatus !== 'rejected'
    && e.labelStatus !== 'verified')
  // Category-diverse: round-robin across categories so a run never becomes ten
  // examples of the easiest category.
  const byCat = new Map<string, ManifestEntry[]>()
  for (const e of pool) {
    if (!byCat.has(e.category)) byCat.set(e.category, [])
    byCat.get(e.category)!.push(e)
  }
  const cats = [...byCat.keys()].sort()
  const out: ManifestEntry[] = []
  for (let round = 0; out.length < limit; round++) {
    let added = false
    for (const c of cats) {
      const row = byCat.get(c)![round]
      if (row) { out.push(row); added = true; if (out.length >= limit) break }
    }
    if (!added) break
  }
  return out
}

export type AutoOptions = {
  jobType: JobType
  limit: number
  dryRun: boolean
  ceilingUsd: number
  confirmed: boolean
  caller?: VisionCaller
  now: string
}

export type AutoResult = {
  dryRun: boolean
  selected: Array<{ id: string; lane: string; category: string }>
  predictedCalls: number
  estimatedUsd: number
  withinCeiling: boolean
  outcomes: CandidateOutcome[]
  spentUsd: number
  stopped?: string
}

/**
 * The batch processor. Returns without spending when `dryRun`, when the estimate
 * exceeds the ceiling without confirmation, or when role independence fails.
 */
export async function auto(opts: AutoOptions): Promise<AutoResult> {
  const root = datasetRoot()
  const entries = loadManifest(root)
  const selected = selectCandidates(entries, opts.jobType, opts.limit)

  const ind = checkIndependence()
  const est = estimateCost({
    candidates: selected.length,
    labelerModel: modelForRole('labeler'),
    verifierModel: modelForRole('verifier'),
    adjudicatorModel: modelForRole('adjudicator'),
    expectedDisagreementRate: 0.3,
    usdPerCall: USD_PER_CALL,
    ceilingUsd: opts.ceilingUsd,
  })
  // classifier is a third per-candidate call the shared estimator does not model
  const predictedCalls = est.calls + selected.length
  const estimatedUsd = est.estimatedUsd + selected.length * (USD_PER_CALL[modelForRole('classifier')] ?? 0)
  const withinCeiling = estimatedUsd <= opts.ceilingUsd

  const base: AutoResult = {
    dryRun: opts.dryRun,
    selected: selected.map(e => ({ id: e.id, lane: e.jobType, category: e.category })),
    predictedCalls, estimatedUsd, withinCeiling, outcomes: [], spentUsd: 0,
  }

  if (!ind.ok) return { ...base, stopped: `role independence violated: ${ind.errors.join('; ')}` }
  if (opts.dryRun) return base
  if (!withinCeiling && !opts.confirmed) {
    return { ...base, stopped: `estimate $${estimatedUsd.toFixed(2)} exceeds ceiling $${opts.ceilingUsd.toFixed(2)} — re-run with --confirm` }
  }
  if (!opts.caller) return { ...base, stopped: 'no transport configured' }

  const cache = fileCache(paths(root).root)
  const checkpoint = fileCheckpoint(paths(root).root)
  const seenHashes = new Map<string, string>()
  for (const e of entries) if (e.sha256 && e.labelStatus === 'verified') seenHashes.set(e.sha256, e.id)

  const outcomes: CandidateOutcome[] = []
  let spentUsd = 0
  // Concurrency 1, on purpose. See the file header.
  for (const e of selected) {
    if (checkpoint.done(e.id)) continue
    const out = await runCandidate(e, { caller: opts.caller, cache }, {
      imageRoot: paths(root).images, now: opts.now,
    }, seenHashes)
    outcomes.push(out)
    spentUsd += out.usd
    checkpoint.record(e.id, out.decision.state)
    // A credit or auth failure stops the run rather than repeating itself.
    if (out.failure && ['credit_exhausted', 'auth'].includes(out.failure.kind)) {
      return { ...base, outcomes, spentUsd, stopped: `provider health: ${out.failure.kind}` }
    }
  }
  return { ...base, outcomes, spentUsd }
}

/** Free: what the deterministic screen alone concludes. */
export function screen(jobType: JobType): Array<{ id: string; state: string; reasons: string[] }> {
  const entries = loadManifest()
  const seen = new Map<string, string>()
  return entries.filter(e => e.jobType === jobType).map(e => {
    const r = preScreen(e, seen)
    return { id: e.id, state: r.state ?? 'passes_to_model', reasons: r.reasons }
  })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? 'report'
  const jobType = (arg(argv, 'lane') ?? 'junk_removal') as JobType
  const limit = Number(arg(argv, 'limit') ?? 10)

  if (cmd === 'screen') {
    const rows = screen(jobType)
    const tally = rows.reduce<Record<string, number>>((a, r) => { a[r.state] = (a[r.state] ?? 0) + 1; return a }, {})
    console.log(`\n=== dataset:screen — ${jobType} (deterministic, free) ===\n`)
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`)
    return
  }

  if (cmd === 'auto') {
    const dryRun = !argv.includes('--execute')
    const res = await auto({
      jobType, limit, dryRun,
      ceilingUsd: Number(arg(argv, 'ceiling') ?? DEFAULT_CEILING_USD),
      confirmed: argv.includes('--confirm'),
      now: new Date().toISOString(),
      // Transport is wired by the caller; the CLI never invents one, so a
      // mis-invocation cannot spend by accident.
      caller: undefined,
    })
    console.log(`\n=== dataset:auto — ${jobType} ${res.dryRun ? '(DRY RUN)' : ''} ===\n`)
    console.log(`  selected        : ${res.selected.length}`)
    for (const s of res.selected) console.log(`    ${s.id.padEnd(42)} ${s.category}`)
    console.log(`  predicted calls : ${res.predictedCalls}`)
    console.log(`  estimated spend : $${res.estimatedUsd.toFixed(3)}  (ceiling $${arg(argv, 'ceiling') ?? DEFAULT_CEILING_USD})`)
    console.log(`  within ceiling  : ${res.withinCeiling}`)
    if (res.stopped) console.log(`\n  STOPPED: ${res.stopped}`)
    else if (res.dryRun) console.log('\n  Dry run only. Re-run with --execute to spend.')
    return
  }

  console.log(`\nUsage: tsx tools/vision-benchmark/curation/cli.ts <screen|auto> [--lane=] [--limit=] [--ceiling=] [--execute] [--confirm]\n`)
}

if (require.main === module) void main()
