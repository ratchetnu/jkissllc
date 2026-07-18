// ── Platform baseline marker generator ───────────────────────────────────────
//
// Writes `operion-baseline.json` at the repo root, recording the source-platform
// baseline this repo currently represents. Run it as the FINAL step of an approved
// platform sync so the marker is committed as part of that update — it is machine-
// generated, never hand-edited. The Update Center reads this file from GitHub to
// compute how far each product is behind the source.
//
// Usage:
//   npx tsx scripts/operion-baseline/generate.ts [--version=<v>] [--commit=<sha>] [--check]
//
//   --version  baseline version to stamp (default: package.json version)
//   --commit   source commit to stamp   (default: current git HEAD)
//   --check    print what WOULD be written, do not write the file
//
// This is the ONE approved repository write in the whole Sync Status feature, and it
// touches only this marker file — never source, never a deployment.

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { generateBaselineMarker, serializeBaselineMarker } from '../../app/lib/platform/sync/baseline'

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : undefined
}

function pkgVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function headCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function main(): void {
  const baselineVersion = arg('version') ?? pkgVersion()
  const baselineCommit = arg('commit') ?? headCommit()
  const generatedAt = new Date().toISOString()
  const marker = generateBaselineMarker({ baselineVersion, baselineCommit, generatedAt })
  const text = serializeBaselineMarker(marker)
  const out = join(process.cwd(), 'operion-baseline.json')

  if (process.argv.includes('--check')) {
    console.log(`# would write ${out}\n${text}`)
    return
  }
  writeFileSync(out, text)
  console.log(`wrote ${out} — ${marker.platform} @ ${baselineVersion} (${baselineCommit.slice(0, 7)})`)
}

main()
