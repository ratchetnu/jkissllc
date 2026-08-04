// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — execution against a Preview deployment.
//
// Uploads each approved image through the deployment's own /api/upload (the
// analyzer only accepts URLs from our Blob host, by design), then runs each JOB
// through /api/quote/analyze and records everything the reports need.
//
// A JOB, not an image, is the unit of evaluation. Multi-photo groups are sent as
// one request because that is what a customer does and because cross-photo
// deduplication is part of what we are measuring — scoring each photo separately
// would silently skip it. Single images run as one-photo jobs.
//
// GUARDS. Preview only: a target that is not a preview host is refused, so this
// can never be pointed at Production. Only reviewStatus="approved" images run.
// Live model calls cost money, so the run prints its estimated spend and honours
// --limit and --dry-run.
//
// Run: BENCH_TARGET=https://<preview>.vercel.app VERCEL_AUTOMATION_BYPASS_SECRET=… \
//        npx tsx tools/vision-benchmark/run-benchmark.ts --split=development
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { datasetRoot, paths, loadManifest, loadGroups } from './dataset'
import type { ManifestEntry, JobType, Split } from './schema'

const UPLOAD_GAP_MS = 400
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export type BenchJob = {
  jobId: string
  jobType: JobType
  category: string
  imageIds: string[]
  split: Split
}

export type BenchResult = {
  jobId: string
  jobType: JobType
  category: string
  imageIds: string[]
  split: Split
  ok: boolean
  httpStatus: number
  latencyMs: number
  decision: string | null
  degraded: string | null
  analyzedOk: boolean | null
  confidence: number | null
  items: Array<{ label: string; quantity: number; category: string; confidence: number }>
  itemCount: number
  estimatedTruckLoads: number | null
  lowUsd: number | null
  highUsd: number | null
  recommendedUsd: number | null
  reviewReasons: string[]
  structuredOutputValid: boolean
  error?: string
}

/** Build the job list: explicit groups first, then every ungrouped approved image. */
export function buildJobs(entries: ManifestEntry[], groups: ReturnType<typeof loadGroups>, split?: Split): BenchJob[] {
  const approved = entries.filter(e => e.reviewStatus === 'approved')
  const byId = new Map(approved.map(e => [e.id, e]))
  const grouped = new Set<string>()
  const jobs: BenchJob[] = []

  for (const g of groups) {
    if (g.reviewStatus !== 'approved') continue
    const ids = g.imageIds.filter(id => byId.has(id))
    if (ids.length === 0) continue
    ids.forEach(id => grouped.add(id))
    jobs.push({ jobId: g.id, jobType: g.jobType, category: g.category, imageIds: ids, split: g.split })
  }
  for (const e of approved) {
    if (grouped.has(e.id)) continue
    jobs.push({ jobId: `single_${e.id}`, jobType: e.jobType, category: e.category, imageIds: [e.id], split: e.split })
  }
  return split ? jobs.filter(j => j.split === split) : jobs
}

/** Refuse anything that is not a Vercel preview host. */
export function assertPreviewTarget(target: string): void {
  let host: string
  try { host = new URL(target).hostname } catch { throw new Error(`BENCH_TARGET is not a URL: ${target}`) }
  const isPreview = /\.vercel\.app$/.test(host) && !/^jkissllc\.vercel\.app$/.test(host)
  if (!isPreview) {
    throw new Error(
      `refusing to benchmark "${host}" — this runner is Preview-only. ` +
      `Live model calls against Production would bill real traffic and pollute production telemetry.`,
    )
  }
}

async function uploadImage(target: string, headers: Record<string, string>, abs: string, mime: string): Promise<string | null> {
  const b64 = readFileSync(abs).toString('base64')
  try {
    const res = await fetch(`${target}/api/upload`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:${mime};base64,${b64}` }),
    })
    const j = await res.json().catch(() => ({})) as { url?: string }
    return j.url ?? null
  } catch { return null }
}

const mimeOf = (path: string): string =>
  path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg'

/** Map a benchmark jobType onto the analyzer's service parameter. */
export function serviceFor(jobType: JobType, category: string): string {
  if (jobType === 'moving') return 'moving'
  if (category.includes('construction') || category.includes('concrete') || category.includes('drywall')
    || category.includes('lumber') || category.includes('roofing')) return 'junk-removal'
  return 'junk-removal'
}

export async function run(opts: {
  target: string; bypass?: string; split?: Split; limit?: number; dryRun: boolean
}): Promise<BenchResult[]> {
  assertPreviewTarget(opts.target)
  const root = datasetRoot()
  const p = paths(root)
  const entries = loadManifest(root)
  const byId = new Map(entries.map(e => [e.id, e]))
  let jobs = buildJobs(entries, loadGroups(root), opts.split)
  if (opts.limit) jobs = jobs.slice(0, opts.limit)

  const headers: Record<string, string> = {}
  if (opts.bypass) headers['x-vercel-protection-bypass'] = opts.bypass

  const photoCount = jobs.reduce((n, j) => n + j.imageIds.length, 0)
  console.log(`\n  target : ${opts.target}`)
  console.log(`  jobs   : ${jobs.length} (${photoCount} photos)${opts.split ? ` · split=${opts.split}` : ''}`)
  console.log(`  est.   : ~$${(jobs.length * 0.03).toFixed(2)} in live model calls\n`)
  if (opts.dryRun) { jobs.forEach(j => console.log(`  [would run] ${j.jobId} (${j.imageIds.length} photo)`)); return [] }
  if (jobs.length === 0) {
    console.log('  Nothing to run — no APPROVED images. Label them first:')
    console.log('    npx tsx tools/vision-benchmark/label.ts\n')
    return []
  }

  const results: BenchResult[] = []
  for (const job of jobs) {
    const urls: string[] = []
    for (const id of job.imageIds) {
      const e = byId.get(id)!
      const abs = join(p.images, e.storedPath)
      const url = await uploadImage(opts.target, headers, abs, mimeOf(e.storedPath))
      await sleep(UPLOAD_GAP_MS)
      if (url) urls.push(url)
    }
    if (urls.length === 0) {
      results.push({
        jobId: job.jobId, jobType: job.jobType, category: job.category, imageIds: job.imageIds, split: job.split,
        ok: false, httpStatus: 0, latencyMs: 0, decision: null, degraded: null, analyzedOk: null,
        confidence: null, items: [], itemCount: 0, estimatedTruckLoads: null,
        lowUsd: null, highUsd: null, recommendedUsd: null, reviewReasons: [],
        structuredOutputValid: false, error: 'upload failed',
      })
      console.log(`  ✖ ${job.jobId} — upload failed`)
      continue
    }

    const started = Date.now()
    try {
      const res = await fetch(`${opts.target}/api/quote/analyze`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: urls, service: serviceFor(job.jobType, job.category) }),
      })
      const latencyMs = Date.now() - started
      const j = await res.json().catch(() => ({})) as {
        estimate?: Record<string, unknown>; analyzed?: { ok?: boolean; degraded?: string | null }
      }
      const e = j.estimate ?? {}
      const items = Array.isArray(e.items) ? e.items as BenchResult['items'] : []
      results.push({
        jobId: job.jobId, jobType: job.jobType, category: job.category, imageIds: job.imageIds, split: job.split,
        ok: res.ok, httpStatus: res.status, latencyMs,
        decision: (e.decision as string) ?? null,
        degraded: j.analyzed?.degraded ?? null,
        analyzedOk: j.analyzed?.ok ?? null,
        confidence: typeof e.confidence === 'number' ? e.confidence : null,
        items, itemCount: items.length,
        estimatedTruckLoads: typeof e.estimatedTruckLoads === 'number' ? e.estimatedTruckLoads : null,
        lowUsd: typeof e.lowUsd === 'number' ? e.lowUsd : null,
        highUsd: typeof e.highUsd === 'number' ? e.highUsd : null,
        recommendedUsd: typeof e.recommendedUsd === 'number' ? e.recommendedUsd : null,
        reviewReasons: Array.isArray(e.reviewReasons) ? e.reviewReasons as string[] : [],
        structuredOutputValid: typeof e.decision === 'string' && Array.isArray(e.items),
      })
      const r = results[results.length - 1]
      console.log(`  ${r.ok ? '✔' : '✖'} ${job.jobId.padEnd(38)} ${String(latencyMs).padStart(6)}ms · ${r.decision ?? 'n/a'} · ${r.itemCount} items${r.degraded ? ` · ${r.degraded}` : ''}`)
    } catch (err) {
      results.push({
        jobId: job.jobId, jobType: job.jobType, category: job.category, imageIds: job.imageIds, split: job.split,
        ok: false, httpStatus: 0, latencyMs: Date.now() - started, decision: null, degraded: null, analyzedOk: null,
        confidence: null, items: [], itemCount: 0, estimatedTruckLoads: null,
        lowUsd: null, highUsd: null, recommendedUsd: null, reviewReasons: [],
        structuredOutputValid: false, error: err instanceof Error ? err.message : 'request failed',
      })
      console.log(`  ✖ ${job.jobId} — ${results[results.length - 1].error}`)
    }
  }

  mkdirSync(p.results, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = join(p.results, `run-${stamp}.json`)
  writeFileSync(out, JSON.stringify({ target: opts.target, split: opts.split ?? 'all', at: stamp, results }, null, 2))
  console.log(`\n  results → ${out}\n`)
  return results
}

function main(): void {
  const argv = process.argv.slice(2)
  const target = process.env.BENCH_TARGET
  if (target) {
  void run({
    target,
    bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    split: (argv.find(a => a.startsWith('--split='))?.split('=')[1] as Split) || undefined,
    limit: Number(argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || undefined,
    dryRun: argv.includes('--dry-run'),
  }).catch(e => { console.error(`\n  ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1 })
  } else {
  console.log('\n  BENCH_TARGET is required (a Vercel Preview URL).')
  console.log('  e.g. BENCH_TARGET=https://jkissllc-xxxx.vercel.app \\')
  console.log('       VERCEL_AUTOMATION_BYPASS_SECRET=… npx tsx tools/vision-benchmark/run-benchmark.ts --split=development\n')
  }
}

if (require.main === module) main()
