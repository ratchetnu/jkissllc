#!/usr/bin/env -S npx --yes tsx@4
// ── Operion rehearsal — runnable dry-run ─────────────────────────────────────
//
// Read-only. Prints the gate outcome, the manifest, the evidence PR #56 would persist,
// and a provider call log proving no write was attempted. Enables no flag, dispatches
// nothing, writes nothing.
//
//   npx tsx@4 tools/operion-rehearsal/cli.ts <sourceCommit> \
//     [--source <path>] [--target <path>] [--ref origin/main] [--update UPD-A-PRIME]
//
// Defaults assume the two sibling clones used in this project.

import { rehearseTransfer } from './rehearse'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const sourceCommit = process.argv[2]
if (!sourceCommit || sourceCommit.startsWith('--')) {
  console.error('usage: cli.ts <sourceCommit> [--source <path>] [--target <path>] [--ref <ref>] [--update <key>]')
  process.exit(2)
}

const input = {
  sourceRepoPath: arg('source', '/Users/nunubabymuzik/jkissllc'),
  targetRepoPath: arg('target', '/Users/nunubabymuzik/supercharged'),
  targetRef: arg('ref', 'origin/main'),
  sourceRepoName: 'ratchetnu/jkissllc',
  sourceCommit,
  updateKey: arg('update', 'UPD-REHEARSAL'),
  targetBusinessId: 'supercharged',
  targetRepoOwner: 'ratchetnu',
  targetRepoName: 'supercharged',
}

const rule = (t: string) => { console.log('\n' + '═'.repeat(76) + '\n' + t + '\n' + '═'.repeat(76)) }

// `.then()` rather than top-level await: this project transpiles .ts as CJS, where
// top-level await is unsupported (same reason the product-sync CLIs stay sync-shaped).
async function main(): Promise<void> {
  const r = await rehearseTransfer(input)

  rule('REHEARSAL — read-only, no dispatch, no write')
  console.log(`source ${input.sourceRepoName} @ ${sourceCommit}`)
  console.log(`target ${input.targetRepoOwner}/${input.targetRepoName} @ ${input.targetRef}`)

  if (!r.ok) {
    console.log(`\n❌ transfer would be REFUSED — ${r.reason}`)
    console.log(`\nmutating provider calls attempted: ${r.mutatingCallsAttempted}`)
    return
  }

  rule('GATES — all passed (manifest built)')
  console.log(`targetBaseCommit    ${r.targetBaseCommit}`)
  console.log(`manifest entries    ${r.manifest.manifest.entries.length}`)
  console.log(`excludedPaths       ${r.manifest.excludedPaths.length}`)
  console.log(`driftCheckedPaths   ${r.manifest.driftCheckedPaths.length}`)
  console.log(`closureCheckedPaths ${r.manifest.closureCheckedPaths.length}`)
  console.log(`symbolCheckedPaths  ${r.manifest.symbolCheckedPaths.length}`)
  console.log(`skippedModules      ${r.manifest.skippedModules.length}`)
  console.log(`provider reads      ${r.providerReads}`)

  rule('EVIDENCE — exactly what PR #56 would persist')
  console.log(JSON.stringify(r.evidence, null, 2))

  rule('SAFETY')
  console.log(`runner payload keys: ${JSON.stringify(r.runnerPayloadKeys)}`)
  console.log(`mutating provider calls attempted: ${r.mutatingCallsAttempted}`)
  console.log(`provider calls (${r.providerCalls.length}): reads only`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
