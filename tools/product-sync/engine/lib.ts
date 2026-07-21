// PRODUCT SYNC ENGINE — shared helpers (registry, config, content hashing, git).
// Run via tsx so it can import the pure TypeScript schema directly. READ-ONLY: the
// engine never writes to any product repository; it only writes reports under out/.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { normalizeManifest, validateManifest, type UpdateManifest } from '../manifest/schema'

export const ROOT = path.resolve(process.cwd(), 'tools/product-sync')
export const OUT_DIR = path.join(ROOT, 'out')

export type ProductConfig = {
  id: string; role: string; repo: string; path: string; defaultBranch: string; rename?: Record<string, string>
}
export type ProductsFile = {
  products: Record<string, ProductConfig>
  relationships: { upstream: string; downstream: string; historyRelationship: string; compareMode: string }[]
  compare: { includeDirs: string[]; trackedRootFiles: string[]; ignore: string[]; flagsFile: string; brandingHints: string[] }
}

export function loadProducts(): ProductsFile {
  return JSON.parse(readFileSync(path.join(ROOT, 'products.json'), 'utf8'))
}

/** Load every registry manifest, normalized + validated. Throws on a manifest with
 *  validation ERRORS (a malformed registry must fail loudly). */
export function loadRegistry(): { manifest: UpdateManifest; file: string }[] {
  const dir = path.join(ROOT, 'registry')
  if (!existsSync(dir)) return []
  const out: { manifest: UpdateManifest; file: string }[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    const manifest = normalizeManifest(raw)
    const errors = validateManifest(manifest).filter((i) => i.severity === 'error')
    if (errors.length) throw new Error(`registry/${f} invalid: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`)
    out.push({ manifest, file: f })
  }
  return out
}

export function ensureOut(): string { mkdirSync(OUT_DIR, { recursive: true }); return OUT_DIR }
export function writeOut(name: string, data: unknown): string {
  ensureOut()
  const p = path.join(OUT_DIR, name)
  writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  return p
}

// ── Content-based file walk (downstream products have UNRELATED git histories, so we
//    compare CONTENT, never commit ancestry). Returns a map of relative-path → sha1.
export function hashTree(repoPath: string, includeDirs: string[], rootFiles: string[], ignore: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const ignored = (rel: string) => ignore.some((ig) => ig.startsWith('*') ? rel.endsWith(ig.slice(1)) : rel.split('/').includes(ig) || rel.startsWith(ig))
  const walk = (abs: string, rel: string) => {
    let st
    try { st = statSync(abs) } catch { return }
    if (ignored(rel)) return
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) walk(path.join(abs, name), rel ? `${rel}/${name}` : name)
    } else if (st.isFile()) {
      try { map.set(rel, createHash('sha1').update(readFileSync(abs)).digest('hex')) } catch { /* unreadable */ }
    }
  }
  for (const d of includeDirs) walk(path.join(repoPath, d), d)
  for (const f of rootFiles) { const abs = path.join(repoPath, f); if (existsSync(abs)) walk(abs, f) }
  return map
}

export function gitHead(repoPath: string): string {
  try { return execFileSync('git', ['-C', repoPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

/** Parse the exported feature-flag names from a flags.ts (both repos share this
 *  shape). Simple + resilient: reads the union-member string literals. */
export function readFlagNames(repoPath: string, flagsFile: string): Set<string> {
  const abs = path.join(repoPath, flagsFile)
  const out = new Set<string>()
  if (!existsSync(abs)) return out
  const src = readFileSync(abs, 'utf8')
  const union = src.split('export type FeatureFlag')[1]?.split('export const')[0] ?? ''
  for (const m of union.matchAll(/\|\s*'([A-Z0-9_]+)'/g)) out.add(m[1])
  return out
}

export function readDeps(repoPath: string): Record<string, string> {
  const abs = path.join(repoPath, 'package.json')
  if (!existsSync(abs)) return {}
  const pkg = JSON.parse(readFileSync(abs, 'utf8'))
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
}
