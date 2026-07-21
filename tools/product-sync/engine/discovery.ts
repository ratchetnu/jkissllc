// PRODUCT SYNC ENGINE — Discovery (Phase 2). READ-ONLY content-based comparison of an
// upstream product against a downstream product. Never modifies any repository; writes
// a DriftReport JSON under out/. Because downstream products are branded copies with
// UNRELATED git histories, drift is computed by CONTENT (path + sha1), not `git log`.
//
// Usage: npx tsx tools/product-sync/engine/discovery.mts [downstreamId=supercharged]
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  loadProducts, loadRegistry, hashTree, gitHead, readFlagNames, readDeps, writeOut, ROOT,
} from './lib'
import type { DriftItem, DriftReport } from '../drift'
import { summarizeDrift } from '../drift'

const downstreamId = process.argv[2] || 'supercharged'
const cfg = loadProducts()
const rel = cfg.relationships.find((r) => r.downstream === downstreamId)
if (!rel) { console.error(`no relationship for downstream "${downstreamId}"`); process.exit(2) }
const up = cfg.products[rel.upstream]
const down = cfg.products[downstreamId]
if (!existsSync(up.path)) { console.error(`upstream repo not found at ${up.path}`); process.exit(2) }

const readOnly = !existsSync(down.path)  // downstream may be absent in some environments
const items: DriftItem[] = []
const c = cfg.compare

// ── Content drift (path + hash) ──────────────────────────────────────────────
const upTree = hashTree(up.path, c.includeDirs, c.trackedRootFiles, c.ignore)
const downTree = readOnly ? new Map<string, string>() : hashTree(down.path, c.includeDirs, c.trackedRootFiles, c.ignore)

for (const [rel2, upHash] of upTree) {
  const downHash = downTree.get(rel2)
  if (downHash === undefined) {
    items.push({ kind: kindForPath(rel2), ref: rel2, detail: 'present upstream, absent downstream' })
  } else if (downHash !== upHash) {
    items.push({ kind: 'changed-file', ref: rel2, detail: 'content differs upstream vs downstream' })
  }
}
// Moved/renamed heuristic: an absent-downstream file whose basename exists downstream
// under a different path is likely a move/rename rather than a true gap.
const downByBase = new Map<string, string[]>()
for (const p of downTree.keys()) { const b = path.basename(p); (downByBase.get(b) ?? downByBase.set(b, []).get(b)!).push(p) }
for (const it of items) {
  if (it.detail === 'present upstream, absent downstream') {
    const elsewhere = downByBase.get(path.basename(it.ref))?.filter((p) => p !== it.ref) ?? []
    if (elsewhere.length) { it.kind = 'moved-file'; it.detail = `likely moved/renamed downstream → ${elsewhere[0]}` }
  }
}

// ── Dependency drift ─────────────────────────────────────────────────────────
if (!readOnly) {
  const upDeps = readDeps(up.path), downDeps = readDeps(down.path)
  for (const [name, ver] of Object.entries(upDeps)) {
    if (!(name in downDeps)) items.push({ kind: 'dependency', ref: name, detail: `upstream has ${name}@${ver}; downstream lacks it` })
    else if (downDeps[name] !== ver) items.push({ kind: 'dependency', ref: name, detail: `version drift: upstream ${ver} vs downstream ${downDeps[name]}` })
  }
}

// ── Feature-flag drift ───────────────────────────────────────────────────────
if (!readOnly) {
  const upFlags = readFlagNames(up.path, c.flagsFile), downFlags = readFlagNames(down.path, c.flagsFile)
  for (const f of upFlags) if (!downFlags.has(f)) items.push({ kind: 'feature-flag', ref: f, detail: 'flag defined upstream, absent downstream' })
}

// ── Migration / environment / api / component / route / documentation drift ──
// These are content-drift items re-tagged by path so the report + dashboard can slice
// them. (A single file can only carry one kind; kindForPath assigns the dominant one.)

// ── "Un-registered upstream work" (missing-commit within upstream's OWN history) ──
// Unrelated histories make cross-repo commit diffing meaningless, so instead we flag
// recent upstream commits whose subject no manifest references — candidate new updates.
try {
  const log = execFileSync('git', ['-C', up.path, 'log', '--oneline', '-40'], { encoding: 'utf8' }).trim().split('\n')
  const registry = loadRegistry()
  const known = registry.map((r) => `${r.manifest.title} ${r.manifest.source.sourceCommit ?? ''} ${r.manifest.source.sourcePR ?? ''}`.toLowerCase())
  for (const line of log) {
    const sha = line.split(' ')[0]
    const subject = line.slice(sha.length + 1)
    if (/^merge |^docs|^chore|^test\(/i.test(subject)) continue
    const referenced = known.some((k) => k.includes(sha) || subject.toLowerCase().split(/\W+/).some((w) => w.length > 5 && k.includes(w)))
    if (!referenced) items.push({ kind: 'missing-commit', ref: sha, detail: subject, suggestedManifestId: 'NEW' })
  }
} catch { /* upstream may be a shallow/odd checkout */ }

const report: DriftReport = {
  generatedAt: new Date().toISOString(),
  upstream: { product: up.id, repo: up.repo, head: gitHead(up.path) },
  downstream: { product: down.id, repo: down.repo, head: readOnly ? 'absent' : gitHead(down.path) },
  items,
}
const summary = summarizeDrift(items)
const outPath = writeOut(`drift-${up.id}-to-${down.id}.json`, { report, summary })

console.log(`Discovery (read-only): ${up.id} → ${down.id}${readOnly ? ' [downstream repo absent — content drift skipped]' : ''}`)
console.log(`  upstream ${report.upstream.head}  downstream ${report.downstream.head}`)
console.log(`  drift items: ${summary.total}`)
for (const [kind, n] of Object.entries(summary.byKind).sort((a, b) => (b[1] as number) - (a[1] as number))) console.log(`    ${String(kind).padEnd(16)} ${n}`)
console.log(`  → ${path.relative(ROOT, outPath)}`)

function kindForPath(p: string): DriftItem['kind'] {
  if (/(^|\/)migrations?\//i.test(p) || /migration/i.test(p)) return 'migration'
  if (/^app\/api\//.test(p)) return 'api'
  if (/\.(tsx)$/.test(p) && /components?\//i.test(p)) return 'component'
  if (/^app\/[^/]+\/(page|layout)\.tsx$/.test(p) || /\/route\.ts$/.test(p) === false && /^app\//.test(p) && /page\.tsx$/.test(p)) return 'route'
  if (/^docs\//.test(p) || /\.md$/.test(p)) return 'documentation'
  if (/\.env|environment/i.test(p)) return 'environment'
  return 'changed-file'
}
