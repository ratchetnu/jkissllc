// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT SYNCHRONIZATION PLATFORM — Drift model (Phases 2 & 10)
//
// The typed shape of a discovery run's output and the pure aggregation the drift
// report + dashboard consume. The .mjs discovery engine produces a DriftReport; this
// module defines it and the summariser. Pure + testable.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProductId, Status, Classification } from './manifest/schema'

export const DRIFT_KINDS = [
  'missing-commit', 'changed-file', 'moved-file', 'renamed-file',
  'dependency', 'migration', 'environment', 'feature-flag',
  'api', 'component', 'route', 'documentation',
] as const
export type DriftKind = (typeof DRIFT_KINDS)[number]

export type DriftItem = {
  kind: DriftKind
  ref: string              // file path, commit sha, dep name, flag name, …
  detail?: string          // e.g. 'present upstream, absent downstream'
  suggestedManifestId?: string
}

export type DriftReport = {
  generatedAt: string      // ISO (stamped by the engine)
  upstream: { product: ProductId; repo: string; head: string }
  downstream: { product: ProductId; repo: string; head: string }
  items: DriftItem[]
  // manifest-derived rollup (what the registry says about the same surface)
  manifestSummary?: ManifestRollup
}

export type ManifestRollup = {
  total: number
  byStatus: Partial<Record<Status, number>>
  byClassification: Partial<Record<Classification, number>>
}

export type DriftSummary = {
  total: number
  byKind: Partial<Record<DriftKind, number>>
  topFiles: { ref: string; kinds: DriftKind[] }[]
}

/** Aggregate raw drift items into counts + the most-affected refs. Pure. */
export function summarizeDrift(items: DriftItem[]): DriftSummary {
  const byKind: Partial<Record<DriftKind, number>> = {}
  const perRef = new Map<string, Set<DriftKind>>()
  for (const it of items) {
    byKind[it.kind] = (byKind[it.kind] ?? 0) + 1
    if (!perRef.has(it.ref)) perRef.set(it.ref, new Set())
    perRef.get(it.ref)!.add(it.kind)
  }
  const topFiles = [...perRef.entries()]
    .map(([ref, kinds]) => ({ ref, kinds: [...kinds] }))
    .sort((a, b) => b.kinds.length - a.kinds.length)
    .slice(0, 25)
  return { total: items.length, byKind, topFiles }
}

/** The four questions Phase 10 must answer, derived from a report + the manifest
 *  registry rollup. Pure — the engine renders the strings. */
export type DriftAnswers = {
  changedUpstream: number       // drift items = upstream work not reflected downstream
  notSynchronized: number       // manifests in a pre-merged state
  intentionallyDifferent: number // excluded/rejected
  blocked: number
  excluded: number
  partiallyAdapted: number
}

export function answerDriftQuestions(report: DriftReport, rollup: ManifestRollup): DriftAnswers {
  const s = rollup.byStatus
  const c = rollup.byClassification
  const preMerged: Status[] = ['discovered', 'planned', 'approved', 'adapting', 'implemented', 'verified', 'preview-ready']
  return {
    changedUpstream: report.items.length,
    notSynchronized: preMerged.reduce((n, st) => n + (s[st] ?? 0), 0),
    intentionallyDifferent: (c['excluded'] ?? 0) + (s['rejected'] ?? 0),
    blocked: s['blocked'] ?? 0,
    excluded: c['excluded'] ?? 0,
    partiallyAdapted: c['partially-present'] ?? 0,
  }
}
