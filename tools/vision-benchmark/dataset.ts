// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — dataset store, quality controls and reports.
//
// Owns everything about the dataset that is NOT acquisition: where it lives on
// disk, exact and near-duplicate detection, the development/holdout/edge-case
// split, and the coverage/duplicate reports.
//
// The split rules exist to stop the benchmark lying to us:
//   • an image is assigned to a split ONCE and never moves — otherwise a bad
//     result can be "fixed" by quietly relocating the image;
//   • near-duplicates are forced into the SAME split, or a photo tuned against in
//     development reappears in the holdout wearing a different crop;
//   • the holdout is never used for prompt development. Tuning against it makes
//     it a development set with a misleading name.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ManifestEntry, JobGroup, RejectedSource, Split, JobType } from './schema'

/** The external store. Images NEVER live in the application repository. */
export function datasetRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISION_BENCHMARK_DIR || join(homedir(), 'jkiss-vision-benchmark')
}

export const paths = (root = datasetRoot()) => ({
  root,
  images: join(root, 'images'),
  manifest: join(root, 'manifest.json'),
  groups: join(root, 'job-groups.json'),
  rejected: join(root, 'rejected-sources.json'),
  reports: join(root, 'reports'),
  results: join(root, 'results'),
})

function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback } catch { return fallback }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

export const loadManifest = (root = datasetRoot()): ManifestEntry[] => readJson<ManifestEntry[]>(paths(root).manifest, [])
export const saveManifest = (entries: ManifestEntry[], root = datasetRoot()): void => writeJson(paths(root).manifest, entries)
export const loadGroups = (root = datasetRoot()): JobGroup[] => readJson<JobGroup[]>(paths(root).groups, [])
export const saveGroups = (groups: JobGroup[], root = datasetRoot()): void => writeJson(paths(root).groups, groups)
export const loadRejected = (root = datasetRoot()): RejectedSource[] => readJson<RejectedSource[]>(paths(root).rejected, [])
export const saveRejected = (rows: RejectedSource[], root = datasetRoot()): void => writeJson(paths(root).rejected, rows)

// ── Hashing ──────────────────────────────────────────────────────────────────

export const sha256 = (buf: Buffer | Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex')

/**
 * dHash: downscale to 9×8 greyscale, then emit one bit per horizontal
 * neighbour comparison. Robust to re-encoding, mild crops and rescaling — the
 * ways the same photo actually reappears across stock sites.
 * `gray` is a row-major 9×8 luminance array.
 */
export function dHashFromGray(gray: number[], w = 9, h = 8): string {
  const bits: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits.push(gray[y * w + x] < gray[y * w + x + 1] ? 1 : 0)
    }
  }
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16)
  }
  return hex
}

/** Hamming distance between two equal-length hex hashes. -1 when incomparable. */
export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return -1
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

/** Bits differing out of 64 below which two images are "the same photo again". */
export const NEAR_DUPLICATE_MAX_DISTANCE = 8

// ── Duplicate detection ──────────────────────────────────────────────────────

export type DuplicateReport = {
  exact: Array<{ sha256: string; ids: string[] }>
  near: Array<{ a: string; b: string; distance: number }>
  /** Ids that should be dropped, keeping the first of each duplicate cluster. */
  redundantIds: string[]
}

export function findDuplicates(entries: ManifestEntry[]): DuplicateReport {
  const bySha = new Map<string, string[]>()
  for (const e of entries) {
    if (!e.sha256) continue
    bySha.set(e.sha256, [...(bySha.get(e.sha256) ?? []), e.id])
  }
  const exact = [...bySha.entries()].filter(([, ids]) => ids.length > 1).map(([sha256, ids]) => ({ sha256, ids }))

  const near: DuplicateReport['near'] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].sha256 === entries[j].sha256) continue   // already exact
      const d = hammingHex(entries[i].phash, entries[j].phash)
      if (d >= 0 && d <= NEAR_DUPLICATE_MAX_DISTANCE) near.push({ a: entries[i].id, b: entries[j].id, distance: d })
    }
  }

  const redundant = new Set<string>()
  for (const { ids } of exact) ids.slice(1).forEach(id => redundant.add(id))
  return { exact, near, redundantIds: [...redundant] }
}

/**
 * Union-find over near-duplicate pairs: every cluster of visually-similar images
 * must land in ONE split. Returns id → cluster representative.
 */
export function nearDuplicateClusters(entries: ManifestEntry[], report: DuplicateReport): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    parent.set(x, parent.get(x) ?? x)
    let r = parent.get(x)!
    while (r !== parent.get(r)) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const e of entries) find(e.id)
  for (const { a, b } of report.near) union(a, b)
  for (const { ids } of report.exact) ids.slice(1).forEach(id => union(ids[0], id))
  const out = new Map<string, string>()
  for (const e of entries) out.set(e.id, find(e.id))
  return out
}

// ── Splits ───────────────────────────────────────────────────────────────────

/** Deterministic 0..1 from a string — a stable split without a random seed. */
export function stableFraction(key: string): number {
  const h = createHash('sha256').update(key).digest()
  return ((h[0] << 16) | (h[1] << 8) | h[2]) / 0xffffff
}

export type SplitPlan = { development: string[]; holdout: string[]; edge_case: string[] }

/**
 * Assign splits. Already-assigned entries KEEP their split (assignments are
 * permanent). Clusters of near-duplicates are assigned together. Anything a human
 * marked as an edge case (notes contain `#edge`) goes to the edge-case set and is
 * never counted toward the holdout.
 */
export function planSplits(
  entries: ManifestEntry[],
  holdoutShare = 0.3,
): SplitPlan {
  const dupes = findDuplicates(entries)
  const cluster = nearDuplicateClusters(entries, dupes)
  const byId = new Map(entries.map(e => [e.id, e]))

  // A cluster inherits any split already assigned to one of its members.
  const clusterSplit = new Map<string, Split>()
  for (const e of entries) {
    const c = cluster.get(e.id)!
    if (e.split && e.split !== 'unassigned') clusterSplit.set(c, e.split)
  }
  for (const e of entries) {
    const c = cluster.get(e.id)!
    if (clusterSplit.has(c)) continue
    if (/#edge\b/.test(e.notes ?? '')) { clusterSplit.set(c, 'edge_case'); continue }
    clusterSplit.set(c, stableFraction(c) < holdoutShare ? 'holdout' : 'development')
  }

  const plan: SplitPlan = { development: [], holdout: [], edge_case: [] }
  for (const e of entries) {
    const split = clusterSplit.get(cluster.get(e.id)!)!
    if (split === 'holdout') plan.holdout.push(e.id)
    else if (split === 'edge_case') plan.edge_case.push(e.id)
    else plan.development.push(e.id)
  }
  void byId
  return plan
}

/** Leakage check: no near-duplicate pair may straddle development and holdout. */
export function splitLeakage(entries: ManifestEntry[]): Array<{ a: string; b: string; distance: number }> {
  const split = new Map(entries.map(e => [e.id, e.split]))
  return findDuplicates(entries).near.filter(({ a, b }) => {
    const sa = split.get(a), sb = split.get(b)
    return sa && sb && sa !== sb
  })
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export type CoverageRow = {
  category: string
  jobType: JobType
  total: number
  approved: number
  pending: number
  labelled: number
  development: number
  holdout: number
  edge_case: number
}

export function coverage(entries: ManifestEntry[], allCategories: Array<{ category: string; jobType: JobType }>): CoverageRow[] {
  const rows = new Map<string, CoverageRow>()
  for (const c of allCategories) {
    rows.set(c.category, {
      category: c.category, jobType: c.jobType,
      total: 0, approved: 0, pending: 0, labelled: 0, development: 0, holdout: 0, edge_case: 0,
    })
  }
  for (const e of entries) {
    const row = rows.get(e.category) ?? {
      category: e.category, jobType: e.jobType,
      total: 0, approved: 0, pending: 0, labelled: 0, development: 0, holdout: 0, edge_case: 0,
    }
    row.total++
    if (e.reviewStatus === 'approved') row.approved++
    if (e.reviewStatus === 'pending') row.pending++
    if (e.expectedObjects?.length) row.labelled++
    if (e.split === 'development') row.development++
    else if (e.split === 'holdout') row.holdout++
    else if (e.split === 'edge_case') row.edge_case++
    rows.set(e.category, row)
  }
  return [...rows.values()].sort((a, b) => a.jobType.localeCompare(b.jobType) || a.category.localeCompare(b.category))
}

export type DistributionReport = {
  lighting: Record<string, number>
  clutter: Record<string, number>
  imageQuality: Record<string, number>
  domains: Record<string, number>
  licenses: Record<string, number>
  /** Share held by the single most common source domain — concentration risk. */
  topDomainShare: number
}

export function distributions(entries: ManifestEntry[]): DistributionReport {
  const bump = (m: Record<string, number>, k: string | null | undefined) => {
    const key = k ?? 'unlabelled'; m[key] = (m[key] ?? 0) + 1
  }
  const lighting: Record<string, number> = {}, clutter: Record<string, number> = {}
  const imageQuality: Record<string, number> = {}, domains: Record<string, number> = {}
  const licenses: Record<string, number> = {}
  for (const e of entries) {
    bump(lighting, e.lighting); bump(clutter, e.clutter); bump(imageQuality, e.imageQuality)
    bump(domains, e.sourceDomain); bump(licenses, e.license)
  }
  const counts = Object.values(domains)
  const topDomainShare = entries.length ? Math.max(0, ...counts) / entries.length : 0
  return { lighting, clutter, imageQuality, domains, licenses, topDomainShare }
}
