// ─────────────────────────────────────────────────────────────────────────────
// Pilot driver. Selects candidates locally, posts each to the Preview curation
// route (where Gateway auth works), and records the outcome.
//
// Serial by design: a curation run is not latency-sensitive, and one-at-a-time
// makes a partial run resumable and its cost attributable. Every candidate is
// checkpointed on completion, so a killed run never re-spends.
//
// Run:
//   CURATE_TARGET=https://<preview> VERCEL_AUTOMATION_BYPASS_SECRET=… \
//   npx tsx tools/vision-benchmark/curation/pilot.ts --lane=junk_removal --limit=10 --execute
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'

import { datasetRoot, loadManifest, paths } from '../dataset'
import { selectCandidates, USD_PER_CALL, DEFAULT_CEILING_USD } from './cli'
import { fileCheckpoint } from './runtime'
import { modelForRole } from './roles'
import type { JobType } from '../schema'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
}

const arg = (a: string[], n: string) => a.find(x => x.startsWith(`--${n}=`))?.split('=').slice(1).join('=')

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const lane = (arg(argv, 'lane') ?? 'junk_removal') as JobType
  const limit = Number(arg(argv, 'limit') ?? 10)
  const execute = argv.includes('--execute')
  const target = process.env.CURATE_TARGET
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET

  if (!target) { console.error('\n  CURATE_TARGET is required (a Preview URL).\n'); process.exitCode = 2; return }
  if (/jkissllc\.com/.test(target)) { console.error('\n  refusing to run against Production.\n'); process.exitCode = 2; return }

  const root = datasetRoot()
  const entries = loadManifest(root)
  const selected = selectCandidates(entries, lane, limit)
  const perCandidate = (USD_PER_CALL[modelForRole('classifier')] ?? 0)
    + (USD_PER_CALL[modelForRole('labeler')] ?? 0) + (USD_PER_CALL[modelForRole('verifier')] ?? 0)
  const estimated = selected.length * perCandidate

  console.log(`\n=== curation pilot — ${lane} ${execute ? '' : '(DRY RUN)'} ===\n`)
  console.log(`  target      : ${target.slice(0, 46)}…`)
  console.log(`  selected    : ${selected.length}`)
  for (const e of selected) console.log(`    ${e.id.padEnd(44)} ${e.category}`)
  console.log(`  est. spend  : $${estimated.toFixed(3)} (ceiling $${DEFAULT_CEILING_USD})`)
  if (!execute) { console.log('\n  Dry run only. Re-run with --execute.\n'); return }
  if (estimated > DEFAULT_CEILING_USD && !argv.includes('--confirm')) {
    console.error(`\n  estimate exceeds ceiling — re-run with --confirm\n`); process.exitCode = 1; return
  }

  const checkpoint = fileCheckpoint(paths(root).root)
  const outDir = join(paths(root).root, 'curation')
  mkdirSync(outDir, { recursive: true })
  const results: unknown[] = []
  let spent = 0

  for (const e of selected) {
    if (checkpoint.done(e.id)) { console.log(`  ⏭  ${e.id} (checkpointed)`); continue }
    const imgPath = join(paths(root).images, e.storedPath)
    const dataUrl = `data:${MIME[extname(imgPath).toLowerCase()] ?? 'image/jpeg'};base64,${readFileSync(imgPath).toString('base64')}`
    const started = Date.now()
    try {
      const res = await fetch(`${target}/api/diagnostics/curate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) },
        body: JSON.stringify({ entry: e, imageDataUrl: dataUrl }),
      })
      const j = await res.json() as Record<string, unknown>
      const wall = Date.now() - started
      results.push({ ...j, wallClientMs: wall })
      spent += Number(j.usd ?? 0)
      checkpoint.record(e.id, String(j.state ?? 'error'))
      console.log(`  ${res.ok ? '✔' : '✖'} ${e.id.padEnd(42)} ${String(j.state ?? j.error).padEnd(22)} ${String(wall).padStart(6)}ms  $${Number(j.usd ?? 0).toFixed(4)}`)
      // Provider health failure stops the run rather than repeating it.
      const kind = (j.failure as { kind?: string } | null)?.kind
      if (kind === 'credit_exhausted' || kind === 'auth') { console.error(`\n  STOPPING — provider health: ${kind}\n`); break }
    } catch (err) {
      console.log(`  ✖ ${e.id} transport: ${err instanceof Error ? err.message.slice(0, 60) : err}`)
      break
    }
  }

  const file = join(outDir, `pilot-${lane}.json`)
  writeFileSync(file, JSON.stringify({ lane, at: new Date().toISOString(), spentUsd: spent, results }, null, 2))
  console.log(`\n  spent  : $${spent.toFixed(4)}\n  results → ${file}\n`)
}

if (require.main === module) void main()
