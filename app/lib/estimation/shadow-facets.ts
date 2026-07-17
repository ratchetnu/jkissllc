// ── Operion Shadow — facets + server-side filtering (PURE) ───────────────────
//
// The dashboard's model / deployment / business / date filters resolve HERE, at the route
// layer — never in the client (no aggregation is duplicated browser-side) and never in the
// analytics engine (which stays a pure aggregator over whatever jobs it's handed). This
// module only (a) enumerates the distinct filter values present in the data and (b) narrows
// the job list before the engine runs. No I/O, no clock, fully unit-tested.

import type { V2ShadowJob } from './shadow-types'

export type FacetOption = { value: string; label: string; count: number }
export type ShadowFacets = { models: FacetOption[]; deployments: FacetOption[]; businesses: FacetOption[] }

export type ShadowFilter = {
  model?: string
  deployment?: string       // stable key `${model}|${promptVersion}|${estimatorVersion}`
  business?: string
  from?: number             // completedAt/updatedAt lower bound (inclusive)
  to?: number               // upper bound (exclusive)
}

// ── field accessors (single source of truth for how a job maps to a facet) ───
export const jobModel = (j: V2ShadowJob): string => j.model ?? j.result?.model ?? 'unknown'

// A "deployment" is the exact model + prompt version + estimator version combo — the same
// identity modelScorecards() groups on, so a deployment filter lines up 1:1 with a scorecard row.
export const jobDeployment = (j: V2ShadowJob): string => `${jobModel(j)}|${j.promptVersion ?? ''}|${j.estimatorVersion ?? ''}`
export const deploymentLabel = (j: V2ShadowJob): string => {
  const m = (jobModel(j).split('/').pop() ?? jobModel(j))
  return `${m} · p${j.promptVersion ?? '?'} · est${j.estimatorVersion ?? '?'}`
}

// Business is defensive/future-proof: the shadow job carries no tenant field today (single-tenant
// J KISS, tenancy off), so this is empty now and lights up automatically once jobs are tenant-tagged.
export const jobBusiness = (j: V2ShadowJob): string | null => {
  const b = (j as unknown as { businessId?: unknown }).businessId
  return typeof b === 'string' && b ? b : null
}

const jobTime = (j: V2ShadowJob): number => j.completedAt ?? j.updatedAt

// ── facet enumeration — distinct values (with counts), sorted by frequency ───
function tally(pairs: Array<[string, string]>): FacetOption[] {
  const m = new Map<string, { label: string; count: number }>()
  for (const [value, label] of pairs) {
    const e = m.get(value)
    if (e) e.count++
    else m.set(value, { label, count: 1 })
  }
  return [...m.entries()].map(([value, { label, count }]) => ({ value, label, count })).sort((a, b) => b.count - a.count)
}

export function extractFacets(jobs: V2ShadowJob[]): ShadowFacets {
  return {
    models: tally(jobs.map((j) => [jobModel(j), jobModel(j).split('/').pop() ?? jobModel(j)])),
    deployments: tally(jobs.map((j) => [jobDeployment(j), deploymentLabel(j)])),
    businesses: tally(jobs.flatMap((j) => { const b = jobBusiness(j); return b ? [[b, b] as [string, string]] : [] })),
  }
}

// ── narrowing — apply the requested filter; unset dimensions are no-ops ───────
export function applyShadowFilter(jobs: V2ShadowJob[], f: ShadowFilter): V2ShadowJob[] {
  return jobs.filter((j) => {
    if (f.model && jobModel(j) !== f.model) return false
    if (f.deployment && jobDeployment(j) !== f.deployment) return false
    if (f.business && jobBusiness(j) !== f.business) return false
    const t = jobTime(j)
    if (typeof f.from === 'number' && t < f.from) return false
    if (typeof f.to === 'number' && t >= f.to) return false
    return true
  })
}

// ── query-string → typed filter (route + client share this contract) ────────
export function parseShadowFilter(sp: URLSearchParams): ShadowFilter {
  const num = (k: string): number | undefined => {
    const v = sp.get(k)
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const str = (k: string): string | undefined => {
    const v = sp.get(k)?.trim()
    return v ? v : undefined
  }
  return { model: str('model'), deployment: str('deployment'), business: str('business'), from: num('from'), to: num('to') }
}
