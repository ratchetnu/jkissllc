// PRODUCT SYNC ENGINE — CLI covering the planner (5), verification (7), approval (9),
// and drift report (10). READ-ONLY except that it writes generated artifacts under
// out/. Run via tsx.
//
//   npx tsx tools/product-sync/engine/cli.ts plan <MANIFEST-ID>
//   npx tsx tools/product-sync/engine/cli.ts verify <MANIFEST-ID>
//   npx tsx tools/product-sync/engine/cli.ts approve <MANIFEST-ID> [approver]
//   npx tsx tools/product-sync/engine/cli.ts drift [downstreamId=supercharged]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadRegistry, loadProducts, writeOut, ROOT } from './lib'
import { buildAdaptationPlan, planIsImplementable } from '../plan'
import { answerDriftQuestions, type ManifestRollup, type DriftReport } from '../drift'
import type { UpdateManifest, Status, Classification } from '../manifest/schema'

const [cmd, arg1, arg2] = process.argv.slice(2)
const registry = loadRegistry()
const byId = (id: string): UpdateManifest | undefined => registry.find((r) => r.manifest.id === id)?.manifest

function rollup(): ManifestRollup {
  const byStatus: Partial<Record<Status, number>> = {}
  const byClassification: Partial<Record<Classification, number>> = {}
  for (const { manifest } of registry) {
    byStatus[manifest.status] = (byStatus[manifest.status] ?? 0) + 1
    byClassification[manifest.classification] = (byClassification[manifest.classification] ?? 0) + 1
  }
  return { total: registry.length, byStatus, byClassification }
}

function branchName(m: UpdateManifest): string { return `sync/${m.product.downstream}/${m.id}` }

if (cmd === 'plan') {
  const m = byId(arg1); if (!m) fail(`unknown manifest "${arg1}"`)
  const products = loadProducts()
  const rename = products.products[m!.product.downstream]?.rename ?? {}
  const plan = buildAdaptationPlan(m!, rename)
  const out = writeOut(`plan-${m!.id}.json`, { manifestId: m!.id, syncBranch: branchName(m!), plan })
  console.log(`Adaptation plan — ${m!.id} (${m!.title})`)
  console.log(`  branch:       ${branchName(m!)}`)
  console.log(`  risk:         ${plan.riskLevel}`)
  console.log(`  source files: ${plan.sourceFiles.length}`)
  console.log(`  reused:       ${plan.functionsReused.length}   adapted: ${plan.functionsAdapted.length}   excluded: ${plan.functionsExcluded.length}`)
  console.log(`  gates:        ${plan.gatesRequired.join(', ')}`)
  console.log(`  conflicts:    ${plan.expectedConflicts.length ? plan.expectedConflicts.join(' | ') : 'none expected'}`)
  console.log(`  blockers:     ${plan.blockers.length ? plan.blockers.join(' | ') : 'none'}`)
  console.log(`  implementable: ${planIsImplementable(plan) ? 'YES' : 'NO — resolve blockers first'}`)
  console.log(`  → ${path.relative(ROOT, out)}`)
} else if (cmd === 'verify') {
  const m = byId(arg1); if (!m) fail(`unknown manifest "${arg1}"`)
  // Runs the standard gauntlet on the UPSTREAM repo (the platform lives here). For a
  // real sync it runs on the sync branch. Records a VerificationRecord.
  const cwd = loadProducts().products[m!.product.upstream].path
  const record = runGauntlet(cwd)
  const out = writeOut(`verify-${m!.id}.json`, { manifestId: m!.id, verifiedAt: new Date().toISOString(), record })
  console.log(`Verification — ${m!.id}`)
  for (const [k, v] of Object.entries(record)) console.log(`  ${v === true ? 'PASS' : v === false ? 'FAIL' : '—   '} ${k}`)
  console.log(`  → ${path.relative(ROOT, out)}`)
} else if (cmd === 'approve') {
  const m = byId(arg1); if (!m) fail(`unknown manifest "${arg1}"`)
  const approver = arg2 || process.env.USER || 'unknown'
  const plan = buildAdaptationPlan(m!)
  const verifyPath = path.join(ROOT, 'out', `verify-${m!.id}.json`)
  const verification = existsSync(verifyPath) ? JSON.parse(readFileSync(verifyPath, 'utf8')) : null
  const pkg = {
    manifest: m,
    plan,
    verification,
    previewValidationRequired: m!.rollout.previewValidationRequired,
    knownDifferences: [
      ...(m!.classification === 'adaptation-required' ? ['Branding/config adapted for the downstream product.'] : []),
      ...m!.exclusions,
      ...(m!.approval?.knownDifferences ?? []),
    ],
    rollback: plan.rollback,
    approver,
    timestamp: new Date().toISOString(),
  }
  const out = writeOut(`approval-${m!.id}.json`, pkg)
  console.log(`Approval package — ${m!.id}`)
  console.log(`  approver:  ${approver}`)
  console.log(`  branch:    ${branchName(m!)}`)
  console.log(`  known differences: ${pkg.knownDifferences.length}`)
  console.log(`  preview required:  ${pkg.previewValidationRequired}`)
  console.log(`  → ${path.relative(ROOT, out)}  (NOT an approval to merge/deploy — a record for a human to sign)`)
} else if (cmd === 'drift') {
  const downstream = arg1 || 'supercharged'
  const driftFile = path.join(ROOT, 'out', `drift-operion-to-${downstream}.json`)
  if (!existsSync(driftFile)) fail(`no discovery report at ${path.relative(ROOT, driftFile)} — run discovery first`)
  const { report } = JSON.parse(readFileSync(driftFile, 'utf8')) as { report: DriftReport }
  const roll = rollup()
  const a = answerDriftQuestions(report, roll)
  const lines = [
    `# Drift Report — operion → ${downstream}`,
    ``,
    `Generated ${new Date().toISOString()} · upstream ${report.upstream.head} · downstream ${report.downstream.head}`,
    ``,
    `## What changed upstream (not reflected downstream)`,
    `- ${a.changedUpstream} content-drift items`,
    ``,
    `## What has NOT been synchronized`,
    `- ${a.notSynchronized} manifest(s) in a pre-merged state (discovered → preview-ready)`,
    ``,
    `## What is intentionally different`,
    `- ${a.intentionallyDifferent} excluded/rejected`,
    ``,
    `## What is blocked`,
    `- ${a.blocked} manifest(s)`,
    ``,
    `## What is excluded`,
    `- ${a.excluded}: ${registry.filter((r) => r.manifest.classification === 'excluded').map((r) => r.manifest.id).join(', ') || 'none'}`,
    ``,
    `## What is partially adapted`,
    `- ${a.partiallyAdapted}: ${registry.filter((r) => r.manifest.classification === 'partially-present').map((r) => r.manifest.id).join(', ') || 'none'}`,
    ``,
    `## Registry rollup`,
    `- by status: ${JSON.stringify(roll.byStatus)}`,
    `- by classification: ${JSON.stringify(roll.byClassification)}`,
  ]
  const out = writeOut(`drift-report-operion-to-${downstream}.md`, lines.join('\n'))
  console.log(lines.join('\n'))
  console.log(`\n  → ${path.relative(ROOT, out)}`)
} else {
  console.log('usage: cli.ts <plan|verify|approve|drift> [args]')
  process.exit(2)
}

function runGauntlet(cwd: string): Record<string, boolean | null> {
  const run = (cmd: string, args: string[]): boolean | null => {
    try { execFileSync(cmd, args, { cwd, stdio: 'ignore' }); return true } catch { return false }
  }
  return {
    typescript: run('npx', ['tsc', '--noEmit']),
    eslint: run('npx', ['eslint', '.']),
    unit: run('npm', ['run', 'test:ai']),
    regression: run('npm', ['run', 'test:ai:regression']),
    previewBuild: null,        // requires a Preview deployment — recorded by Phase 8
    featureOffVerified: null,  // asserted by the flag-off gate + regression
    rollbackVerified: null,    // asserted by the Preview rollback step
  }
}

function fail(msg: string): never { console.error(`✖ ${msg}`); process.exit(2) }
