// ─────────────────────────────────────────────────────────────────────────────
// One command per lane: preflight → benchmark → report.
//
//   npm run bench:junk     --job-type=junk_removal   (default)
//   npm run bench:moving   --job-type=moving
//   npm run bench:all      both, sequentially, with SEPARATE reports
//
// The lanes stay apart end to end. Moving was previously refused outright here,
// because the analyze route did not gate on service family and a moving photo
// would be read by the junk-removal prompt and priced by the disposal engine —
// a confident junk quote for a move, silently tabulated as "moving". The moving
// application lane (PR #157) removes that hazard; this file keeps the datasets,
// the runs and the reports separate so no pooled number can be read out of them.
//
// Only VERIFIED images run. Rejected, pending, draft and unlabelled entries enter
// neither lane: a job that cannot be scored still costs money and still lands in
// the latency percentiles, where it is indistinguishable from one that scored badly.
//
// THE PREFLIGHT IS A SPEND GATE. It runs the provider diagnostic first and
// STOPS if inference cannot actually run. The last attempt burned ten model
// calls and forty minutes of wall-clock discovering the gateway had no credit
// balance; that costs two seconds now.
//
// Run: BENCH_TARGET=https://<preview>.vercel.app \
//      VERCEL_AUTOMATION_BYPASS_SECRET=… \
//      npx tsx tools/vision-benchmark/bench.ts
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { run } from './run-benchmark'
import type { JobType } from './schema'
import type { Split } from './schema'

type Verdict = { healthy?: boolean; category?: string; fixOwner?: string; action?: string }

async function preflight(target: string, headers: Record<string, string>): Promise<boolean> {
  console.log('\n── Preflight: can inference actually run? ─────────────────────')
  let res: Response
  try {
    res = await fetch(`${target}/api/diagnostics/ai-provider`, { headers })
  } catch (e) {
    console.error(`  ✖ diagnostic unreachable: ${e instanceof Error ? e.message : e}`)
    return false
  }

  if (res.status === 404) {
    console.error('  ✖ diagnostic returned 404.')
    console.error('    Set AI_PROVIDER_DIAGNOSTIC_ENABLED=1 in Preview (never Production).')
    return false
  }
  if (!res.ok) { console.error(`  ✖ diagnostic returned HTTP ${res.status}`); return false }

  const j = await res.json().catch(() => ({})) as {
    providerSelected?: string; modelSelected?: string; credentialsConfigured?: boolean
    credentialSource?: string; gatewayReachable?: boolean
    textProbe?: Record<string, unknown>; imageInputProbe?: Record<string, unknown>
    verdict?: Verdict
  }

  console.log(`  provider    : ${j.providerSelected} · ${j.modelSelected}`)
  console.log(`  credentials : ${j.credentialsConfigured ? 'configured' : 'MISSING'} (${j.credentialSource})`)
  console.log(`  gateway     : ${j.gatewayReachable ? 'reachable' : 'UNREACHABLE'}`)
  console.log(`  text probe  : ${j.textProbe?.ok ? `ok (${j.textProbe.latencyMs}ms)` : `FAILED — ${j.textProbe?.category ?? 'unknown'}`}`)
  console.log(`  image probe : ${j.imageInputProbe?.ok ? `ok (${j.imageInputProbe.latencyMs}ms)` : (j.imageInputProbe?.skipped ?? `FAILED — ${j.imageInputProbe?.category ?? 'unknown'}`)}`)

  if (!j.verdict?.healthy) {
    console.error(`\n  ✖ STOPPING — inference cannot run.`)
    console.error(`    category  : ${j.verdict?.category ?? 'unknown'}`)
    console.error(`    fix owner : ${j.verdict?.fixOwner ?? 'unknown'}`)
    console.error(`    action    : ${j.verdict?.action ?? 'see the diagnostic response'}`)
    console.error(`\n    No model calls were made and nothing was spent.\n`)
    return false
  }
  console.log('  ✔ provider is answering — proceeding.\n')
  return true
}

/**
 * One lane, end to end: benchmark then report, with the report scoped to that job
 * type so the two never share a table. Returns a process exit code.
 */
async function runLane(jobType: JobType, argv: string[]): Promise<number> {
  const target = process.env.BENCH_TARGET!
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  const split = (argv.find(a => a.startsWith('--split='))?.split('=')[1] as Split) ?? 'development'
  const limit = Number(argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || undefined

  console.log('── Benchmark ─────────────────────────────────────────────────')
  const results = await run({
    target, bypass, split, limit, jobType,
    dryRun: argv.includes('--dry-run'),
    resume: argv.includes('--resume'),
  })
  if (results.length === 0 && !argv.includes('--dry-run')) {
    console.log(`  Nothing ran — no VERIFIED ${jobType} images for this filter.\n`)
    return 0
  }
  if (argv.includes('--dry-run')) return 0

  console.log('── Report ────────────────────────────────────────────────────')
  const r = spawnSync('npx', ['--yes', 'tsx@4', 'tools/vision-benchmark/report.ts', `--job-type=${jobType}`], {
    stdio: 'inherit', cwd: process.cwd(),
  })
  return r.status ?? 1
}

async function main(): Promise<void> {
  const target = process.env.BENCH_TARGET
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (!target) {
    console.error('\n  BENCH_TARGET is required (a Vercel Preview URL).\n')
    process.exitCode = 2
    return
  }

  const argv = process.argv.slice(2)
  const jobTypeArg = argv.find(a => a.startsWith('--job-type='))?.split('=')[1] ?? 'junk_removal'
  const headers: Record<string, string> = bypass ? { 'x-vercel-protection-bypass': bypass } : {}

  // The spend gate runs ONCE, before any lane. `all` must not slip past it — two
  // lanes' worth of model calls is exactly the run you least want to discover a
  // dead gateway halfway through.
  if (!argv.includes('--skip-preflight')) {
    const ready = await preflight(target, headers)
    if (!ready) { process.exitCode = 1; return }
  }

  // `--job-type=all` runs the lanes one after another, each with its own report.
  // Sequential, never merged: two lanes sharing one run would share a rate-limit
  // budget and a results file, and the first thing anyone would do with a single
  // combined report is read a pooled average out of it.
  if (jobTypeArg === 'all') {
    for (const jt of ['junk_removal', 'moving'] as JobType[]) {
      console.log(`\n══ ${jt} ══════════════════════════════════════════════════════`)
      const code = await runLane(jt, argv)
      // A failed lane stops the sequence: the second would otherwise spend money
      // to produce a report nobody trusts because the first one broke.
      if (code !== 0) { process.exitCode = code; return }
    }
    return
  }

  // The report runs as a separate process on purpose: it must be re-runnable
  // against a saved run without repeating the benchmark, so it reads the results
  // file rather than an in-memory array.
  const code = await runLane(jobTypeArg as JobType, argv)
  if (code !== 0) process.exitCode = code
}

if (require.main === module) {
  void main().catch(e => {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`)
    process.exitCode = 1
  })
}
