// ─────────────────────────────────────────────────────────────────────────────
// One command: preflight → benchmark → report.
//
// Junk removal ONLY by default. The analyze route does not gate on service
// family, so a moving photo would be read by the junk-removal prompt and priced
// by the disposal engine — returning a confident junk-removal quote for a moving
// job. That failure is silent and would be tabulated under a "moving" heading as
// if it meant something. Moving needs its own analysis lane before it is
// benchmarked; pass --job-type=moving to override, deliberately.
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

async function main(): Promise<void> {
  const target = process.env.BENCH_TARGET
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (!target) {
    console.error('\n  BENCH_TARGET is required (a Vercel Preview URL).\n')
    process.exitCode = 2
    return
  }

  const argv = process.argv.slice(2)
  const jobType = (argv.find(a => a.startsWith('--job-type='))?.split('=')[1] as JobType) ?? 'junk_removal'
  const split = (argv.find(a => a.startsWith('--split='))?.split('=')[1] as Split) ?? 'development'
  const limit = Number(argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || undefined
  const headers: Record<string, string> = bypass ? { 'x-vercel-protection-bypass': bypass } : {}

  if (!argv.includes('--skip-preflight')) {
    const ready = await preflight(target, headers)
    if (!ready) { process.exitCode = 1; return }
  }

  console.log('── Benchmark ─────────────────────────────────────────────────')
  const results = await run({
    target, bypass, split, limit, jobType,
    dryRun: argv.includes('--dry-run'),
    resume: argv.includes('--resume'),
  })
  if (results.length === 0 && !argv.includes('--dry-run')) {
    console.log('  Nothing ran — no approved images for this filter.\n')
    return
  }
  if (argv.includes('--dry-run')) return

  console.log('── Report ────────────────────────────────────────────────────')
  // The report is a separate process on purpose: it must be re-runnable against a
  // saved run without repeating the benchmark, so it reads the results file
  // rather than the in-memory array.
  const r = spawnSync('npx', ['--yes', 'tsx@4', 'tools/vision-benchmark/report.ts'], {
    stdio: 'inherit', cwd: process.cwd(),
  })
  if (r.status !== 0) process.exitCode = r.status ?? 1
}

if (require.main === module) {
  void main().catch(e => {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`)
    process.exitCode = 1
  })
}
