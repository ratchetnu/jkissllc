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

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { datasetRoot, paths, loadManifest, loadGroups } from './dataset'
import type { ManifestEntry, JobType, Split } from './schema'
import { createPacer, parseRetryAfter, fallbackBackoffMs, ANALYZE_LIMIT } from './pacing'

const UPLOAD_GAP_MS = 400
const MAX_429_RETRIES = 4
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
  // ── Rate-limit accounting: kept strictly apart from inference latency ──
  rateLimitWaitMs: number
  rateLimitRetries: number
  // ── Joined from the Preview-only evaluation record (null when unavailable) ──
  truckUtilizationPct: number | null
  estimatedVolumeCubicYards: number | null
  confidenceInputs: Record<string, number> | null
  criticInvoked: boolean | null
  criticRecommend: string | null
  monitorForceReview: boolean | null
  inputTokens: number | null
  outputTokens: number | null
  estCostUsd: number | null
  providerAttempts: number | null
  providerRetried: boolean | null
  providerLatencyMs: number | null
}

/** Build the job list: explicit groups first, then every ungrouped approved image. */
export function buildJobs(
  entries: ManifestEntry[],
  groups: ReturnType<typeof loadGroups>,
  split?: Split,
  jobType?: JobType,
): BenchJob[] {
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
  const bySplit = split ? jobs.filter(j => j.split === split) : jobs
  // Moving is deliberately excludable: the analyze route does not gate on service
  // family, so a moving photo would be read by the junk-removal prompt and priced
  // by the disposal engine. That returns a confident JUNK-REMOVAL quote for a
  // moving job. Junk removal is validated first; moving needs its own lane.
  return jobType ? bySplit.filter(j => j.jobType === jobType) : bySplit
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

/** Fetch the Preview-only evaluation record and flatten what the report needs. */
async function fetchEvaluation(target: string, headers: Record<string, string>, analysisId: string) {
  try {
    const res = await fetch(`${target}/api/diagnostics/analysis/${encodeURIComponent(analysisId)}`, { headers })
    if (!res.ok) return null
    const j = await res.json() as {
      evaluation?: Record<string, unknown>; provider?: Record<string, unknown> | null
    }
    const e = j.evaluation, p = j.provider
    if (!e) return null
    return {
      truckUtilizationPct: typeof e.truckUtilizationPct === 'number' ? e.truckUtilizationPct : null,
      estimatedVolumeCubicYards: typeof e.estimatedVolumeCubicYards === 'number' ? e.estimatedVolumeCubicYards : null,
      confidenceInputs: (e.confidence ?? null) as Record<string, number> | null,
      criticInvoked: typeof e.criticInvoked === 'boolean' ? e.criticInvoked : null,
      criticRecommend: (e.criticRecommend as string) ?? null,
      monitorForceReview: typeof e.monitorForceReview === 'boolean' ? e.monitorForceReview : null,
      inputTokens: typeof p?.inputTokens === 'number' ? p.inputTokens : null,
      outputTokens: typeof p?.outputTokens === 'number' ? p.outputTokens : null,
      estCostUsd: typeof p?.estCostUsd === 'number' ? p.estCostUsd : null,
      providerAttempts: typeof p?.attempts === 'number' ? p.attempts : null,
      providerRetried: typeof p?.retried === 'boolean' ? p.retried : null,
      providerLatencyMs: typeof p?.latencyMs === 'number' ? p.latencyMs : null,
    }
  } catch { return null }
}

const EMPTY_EVAL = {
  truckUtilizationPct: null, estimatedVolumeCubicYards: null, confidenceInputs: null,
  criticInvoked: null, criticRecommend: null, monitorForceReview: null,
  inputTokens: null, outputTokens: null, estCostUsd: null,
  providerAttempts: null, providerRetried: null, providerLatencyMs: null,
}

/** Job ids already completed in a prior run — so a resumed run never re-spends. */
export function completedJobIds(resultsDir: string): Set<string> {
  const done = new Set<string>()
  if (!existsSync(resultsDir)) return done
  for (const f of readdirSync(resultsDir).filter(f => f.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(resultsDir, f), 'utf8')) as { results?: BenchResult[] }
      for (const r of j.results ?? []) {
        // Only a run that actually reached the model counts as done. A 429 or a
        // transport failure must be retried, not skipped as if it had a result.
        if (r.ok && r.httpStatus !== 429) done.add(r.jobId)
      }
    } catch { /* unreadable run file — ignore */ }
  }
  return done
}

export async function run(opts: {
  target: string; bypass?: string; split?: Split; limit?: number; dryRun: boolean; resume?: boolean
  jobType?: JobType
}): Promise<BenchResult[]> {
  assertPreviewTarget(opts.target)
  const root = datasetRoot()
  const p = paths(root)
  const entries = loadManifest(root)
  const byId = new Map(entries.map(e => [e.id, e]))
  let jobs = buildJobs(entries, loadGroups(root), opts.split, opts.jobType)
  if (opts.limit) jobs = jobs.slice(0, opts.limit)

  const headers: Record<string, string> = {}
  if (opts.bypass) headers['x-vercel-protection-bypass'] = opts.bypass
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-')

  // Resume: skip jobs a previous run already completed against the model. A 429
  // or a transport failure is NOT completion, so those come round again.
  if (opts.resume) {
    const done = completedJobIds(p.results)
    const before = jobs.length
    jobs = jobs.filter(j => !done.has(j.jobId))
    if (before !== jobs.length) console.log(`  resume : skipping ${before - jobs.length} already-completed job(s)`)
  }

  const photoCount = jobs.reduce((n, j) => n + j.imageIds.length, 0)
  console.log(`\n  target : ${opts.target}`)
  console.log(`  jobs   : ${jobs.length} (${photoCount} photos)${opts.split ? ` · split=${opts.split}` : ''}${opts.jobType ? ` · ${opts.jobType} only` : ''}`)
  console.log(`  est.   : ~$${(jobs.length * 0.03).toFixed(2)} in live model calls`)
  console.log(`  pacing : ${ANALYZE_LIMIT.requests} req / ${ANALYZE_LIMIT.windowMs / 60000} min — waits are excluded from latency\n`)
  if (opts.dryRun) { jobs.forEach(j => console.log(`  [would run] ${j.jobId} (${j.imageIds.length} photo)`)); return [] }
  if (jobs.length === 0) {
    console.log('  Nothing to run — no APPROVED images. Label them first:')
    console.log('    npx tsx tools/vision-benchmark/label.ts\n')
    return []
  }

  const results: BenchResult[] = []
  const pacer = createPacer(ANALYZE_LIMIT)
  const base = (job: BenchJob) => ({
    jobId: job.jobId, jobType: job.jobType, category: job.category,
    imageIds: job.imageIds, split: job.split,
  })

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
        ...base(job), ok: false, httpStatus: 0, latencyMs: 0, decision: null, degraded: null,
        analyzedOk: null, confidence: null, items: [], itemCount: 0, estimatedTruckLoads: null,
        lowUsd: null, highUsd: null, recommendedUsd: null, reviewReasons: [],
        structuredOutputValid: false, error: 'upload failed',
        rateLimitWaitMs: 0, rateLimitRetries: 0, ...EMPTY_EVAL,
      })
      console.log(`  ✖ ${job.jobId} — upload failed`)
      continue
    }

    let waitMs = 0
    let retries = 0
    let done = false

    while (!done) {
      // 1) Respect the limit BEFORE sending. Waiting here is bookkeeping, not latency.
      let decision = pacer.next(Date.now())
      while (decision.action === 'wait') {
        const secs = Math.ceil(decision.ms / 1000)
        console.log(`  … waiting ${secs}s (${decision.reason}) — ${pacer.usedInWindow(Date.now())}/${ANALYZE_LIMIT.requests} used this window`)
        await sleep(decision.ms)
        waitMs += decision.ms
        pacer.addWait(decision.ms)
        decision = pacer.next(Date.now())
      }

      // 2) Send. Only THIS span is inference latency.
      const started = Date.now()
      pacer.record(started)
      try {
        const res = await fetch(`${opts.target}/api/quote/analyze`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ photos: urls, service: serviceFor(job.jobType, job.category) }),
        })
        const latencyMs = Date.now() - started

        // 3) A 429 is NOT a result and NOT a latency sample. Honour Retry-After,
        //    charge the time to wait, and try the same job again.
        if (res.status === 429) {
          retries++
          if (retries > MAX_429_RETRIES) {
            results.push({
              ...base(job), ok: false, httpStatus: 429, latencyMs: 0, decision: null, degraded: null,
              analyzedOk: null, confidence: null, items: [], itemCount: 0, estimatedTruckLoads: null,
              lowUsd: null, highUsd: null, recommendedUsd: null, reviewReasons: [],
              structuredOutputValid: false, error: `rate limited after ${MAX_429_RETRIES} retries`,
              rateLimitWaitMs: waitMs, rateLimitRetries: retries, ...EMPTY_EVAL,
            })
            console.log(`  ✖ ${job.jobId} — still rate limited after ${MAX_429_RETRIES} retries`)
            break
          }
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), Date.now())
            ?? fallbackBackoffMs(retries)
          pacer.penalize(Date.now() + retryAfter)
          console.log(`  ⏳ ${job.jobId} — 429, retrying in ${Math.ceil(retryAfter / 1000)}s (attempt ${retries})`)
          continue
        }

        const j = await res.json().catch(() => ({})) as {
          estimate?: Record<string, unknown>; analyzed?: { ok?: boolean; degraded?: string | null }
        }
        const e = j.estimate ?? {}
        const items = Array.isArray(e.items) ? e.items as BenchResult['items'] : []
        const analysisId = typeof e.analysisId === 'string' ? e.analysisId : null

        // 4) Join the Preview-only evaluation record for the internals the
        //    customer response omits (fraction, tokens, cost, critic).
        const evalData = analysisId ? await fetchEvaluation(opts.target, headers, analysisId) : null

        results.push({
          ...base(job), ok: res.ok, httpStatus: res.status, latencyMs,
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
          rateLimitWaitMs: waitMs, rateLimitRetries: retries,
          ...(evalData ?? EMPTY_EVAL),
        })
        const r = results[results.length - 1]
        const tok = r.outputTokens != null ? ` · ${r.outputTokens}out` : ''
        const util = r.truckUtilizationPct != null ? ` · ${r.truckUtilizationPct}% truck` : ''
        console.log(`  ${r.ok ? '✔' : '✖'} ${job.jobId.padEnd(38)} ${String(latencyMs).padStart(6)}ms · ${r.decision ?? 'n/a'} · ${r.itemCount} items${util}${tok}${r.degraded ? ` · ${r.degraded}` : ''}`)
        done = true
      } catch (err) {
        results.push({
          ...base(job), ok: false, httpStatus: 0, latencyMs: 0, decision: null, degraded: null,
          analyzedOk: null, confidence: null, items: [], itemCount: 0, estimatedTruckLoads: null,
          lowUsd: null, highUsd: null, recommendedUsd: null, reviewReasons: [],
          structuredOutputValid: false, error: err instanceof Error ? err.message : 'request failed',
          rateLimitWaitMs: waitMs, rateLimitRetries: retries, ...EMPTY_EVAL,
        })
        console.log(`  ✖ ${job.jobId} — ${results[results.length - 1].error}`)
        done = true
      }
    }

    // Checkpoint after every job so an interrupted run resumes without re-spending.
    mkdirSync(p.results, { recursive: true })
    writeFileSync(join(p.results, `run-${runStamp}.json`),
      JSON.stringify({ target: opts.target, split: opts.split ?? 'all', at: runStamp, results }, null, 2))
  }

  const out = join(p.results, `run-${runStamp}.json`)
  console.log(`\n  rate-limit wait total: ${Math.round(pacer.waitedMs() / 1000)}s (excluded from latency)`)
  console.log(`  results → ${out}\n`)
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
    resume: argv.includes('--resume'),
    jobType: (argv.find(a => a.startsWith('--job-type='))?.split('=')[1] as JobType) || undefined,
  }).catch(e => { console.error(`\n  ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1 })
  } else {
  console.log('\n  BENCH_TARGET is required (a Vercel Preview URL).')
  console.log('  e.g. BENCH_TARGET=https://jkissllc-xxxx.vercel.app \\')
  console.log('       VERCEL_AUTOMATION_BYPASS_SECRET=… npx tsx tools/vision-benchmark/run-benchmark.ts --split=development\n')
  }
}

if (require.main === module) main()
