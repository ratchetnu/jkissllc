// ── Operion Update Center — PURE policy ──────────────────────────────────────
// No I/O, no clock, no randomness (callers pass `now`). Everything here is unit-
// testable. The store/routes/UI reason THROUGH these functions.

import type {
  PlatformUpdate, UpdateStatus, PlatformBusiness, DeploymentRecord, CheckStatus,
  UpdateCompatibility, CompatStatus,
} from './types'
import { PENDING_STATUSES, TERMINAL_STATUSES } from './types'

// ── Semantic version parse + compare ─────────────────────────────────────────
export type SemVer = { major: number; minor: number; patch: number; pre?: string }
export function parseVersion(v: string | undefined | null): SemVer | null {
  if (!v) return null
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/.exec(v.trim())
  if (!m) return null
  return { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] }
}
/** -1 if a<b, 0 if equal (ignoring pre), 1 if a>b. Unparseable sorts lowest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const pa = parseVersion(a), pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return 0
}

// ── Status helpers + transitions ─────────────────────────────────────────────
export function isPending(status: UpdateStatus): boolean { return PENDING_STATUSES.includes(status) }
export function isTerminal(status: UpdateStatus): boolean { return TERMINAL_STATUSES.includes(status) }

// Archived is locked; everything else may move (approval/verification are guarded
// separately). A no-op transition is rejected.
export function canTransitionUpdate(from: UpdateStatus, to: UpdateStatus): boolean {
  if (from === to) return false
  if (from === 'archived') return false
  return true
}

// ── Aging ────────────────────────────────────────────────────────────────────
export type AgeBucket = 'today' | '1-3d' | '4-7d' | '8-14d' | '15-30d' | '30d+'
const DAY = 86_400_000
export function ageDays(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / DAY))
}
export function agingBucket(since: number, now: number): AgeBucket {
  const d = ageDays(since, now)
  if (d <= 0) return 'today'
  if (d <= 3) return '1-3d'
  if (d <= 7) return '4-7d'
  if (d <= 14) return '8-14d'
  if (d <= 30) return '15-30d'
  return '30d+'
}
/** Aging reference = last touch (updatedAt) for a still-pending update. */
export function updateAgeDays(u: Pick<PlatformUpdate, 'updatedAt' | 'status'>, now: number): number {
  return isPending(u.status) ? ageDays(u.updatedAt, now) : 0
}

// ── KPI rollup (the "never forget" dashboard) ────────────────────────────────
export type UpdateKpis = {
  total: number
  pending: number
  readyForReview: number
  readyToRelease: number
  approved: number
  blocked: number
  failed: number
  fullyDeployed: number
  olderThan14: number
  byAging: Record<AgeBucket, number>
}
const ZERO_AGE: Record<AgeBucket, number> = { today: 0, '1-3d': 0, '4-7d': 0, '8-14d': 0, '15-30d': 0, '30d+': 0 }

export function computeUpdateKpis(updates: PlatformUpdate[], now: number): UpdateKpis {
  const byAging = { ...ZERO_AGE }
  let pending = 0, readyForReview = 0, readyToRelease = 0, approved = 0, blocked = 0, failed = 0, fullyDeployed = 0, olderThan14 = 0
  for (const u of updates) {
    if (isPending(u.status)) {
      pending++
      byAging[agingBucket(u.updatedAt, now)]++
      if (ageDays(u.updatedAt, now) > 14) olderThan14++
    }
    if (u.status === 'ready_for_review') readyForReview++
    if (u.status === 'ready_to_release') readyToRelease++
    if (u.status === 'approved') approved++
    if (u.status === 'blocked') blocked++
    if (u.status === 'failed') failed++
    if (u.status === 'fully_deployed') fullyDeployed++
  }
  return { total: updates.length, pending, readyForReview, readyToRelease, approved, blocked, failed, fullyDeployed, olderThan14, byAging }
}

// ── Deployment verification gates (Phase 11 doctrine) ────────────────────────
const okOrNA = (s?: CheckStatus) => s === 'passed' || s === 'not_applicable' || s === 'skipped'
export function deploymentGatesPass(d: Pick<DeploymentRecord, 'buildStatus' | 'healthCheckStatus' | 'smokeTestStatus'>): boolean {
  return d.buildStatus === 'passed' && d.healthCheckStatus === 'passed' && okOrNA(d.smokeTestStatus)
}
/** A deployment may be marked verified ONLY if all gates pass, OR an owner waives with a reason. */
export function canMarkVerified(
  d: Pick<DeploymentRecord, 'buildStatus' | 'healthCheckStatus' | 'smokeTestStatus'>,
  waiveReason?: string,
): boolean {
  return deploymentGatesPass(d) || (!!waiveReason && waiveReason.trim().length > 0)
}

// ── Release eligibility ──────────────────────────────────────────────────────
export function updateReleaseEligible(u: PlatformUpdate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!['approved', 'ready_to_release', 'ready_for_review'].includes(u.status)) reasons.push('not approved/ready')
  if (u.validation.tests !== 'passed') reasons.push('tests not passed')
  if (u.validation.build !== 'passed') reasons.push('build not passed')
  if (u.breakingChange && u.validation.ownerVerification !== 'passed') reasons.push('breaking change needs owner verification')
  if (u.migrationRequired && !u.rollbackSupported) reasons.push('migration without rollback plan')
  return { eligible: reasons.length === 0, reasons }
}

// ── Compatibility rollup for one update across businesses ─────────────────────
export function compatRollup(compats: UpdateCompatibility[]): { compatible: number; withChanges: number; blocked: number; unknown: number; notApplicable: number } {
  let compatible = 0, withChanges = 0, blocked = 0, unknown = 0, notApplicable = 0
  for (const c of compats) {
    if (c.status === 'compatible' || c.status === 'already_present') compatible++
    else if (c.status === 'compatible_with_changes') withChanges++
    else if (c.status === 'incompatible' || c.status === 'blocked') blocked++
    else if (c.status === 'not_applicable') notApplicable++
    else unknown++
  }
  return { compatible, withChanges, blocked, unknown, notApplicable }
}

/** PATCH semantics for machine-enforced exclusions: omitted preserves; [] explicitly clears. */
export function resolvePathsToExclude(existing: string[] | undefined, submitted: string[] | undefined): string[] | undefined {
  return submitted === undefined ? existing : submitted
}

// ── Required updates (issue #48 Phase B) ─────────────────────────────────────
//
// UPD-1004 failed because its files needed two modules from an EARLIER update that
// Supercharged had never received. Phase A catches that at manifest-build time — by
// which point a job exists and a workflow run has been spent. This moves the same
// guarantee to where the owner actually is: `PlatformUpdate.dependencies`, the field
// that already existed and was never enforced, becomes a blocking preflight gate, so
// an update that needs an earlier one cannot start.
//
// ONE MODEL, NOT TWO. There is deliberately no new prerequisite type. The owner sees
// "Required updates"; the record is the existing `dependencies` array.

/** Anything wrong with a dependency list, in a form the API can turn into copy. */
export type DependencyProblem =
  | { kind: 'not_an_array' }
  | { kind: 'too_many'; max: number }
  | { kind: 'not_a_string'; index: number }
  | { kind: 'self_dependency'; key: string }
  | { kind: 'unknown_update'; keys: string[] }
  | { kind: 'cycle'; path: string[] }

export const MAX_DEPENDENCIES = 20

/** PATCH semantics, mirroring exclusions: omitted preserves; [] explicitly clears. */
export function resolveDependencies(existing: string[] | undefined, submitted: string[] | undefined): string[] | undefined {
  return submitted === undefined ? existing : submitted
}

/**
 * Validate a submitted dependency list for one update. Pure: the caller supplies the
 * set of keys that exist and a lookup for each update's own dependencies, so cycle
 * detection needs no store access.
 *
 * Fails closed on every malformed shape — an unparseable list must never be stored as
 * "no requirements", because the empty list is exactly what lets a transfer proceed.
 */
export function validateDependencies(input: {
  key: string
  submitted: unknown
  knownKeys: ReadonlySet<string>
  dependenciesOf: (key: string) => string[] | undefined
}): { ok: true; dependencies: string[] } | { ok: false; problems: DependencyProblem[] } {
  const { key, submitted, knownKeys, dependenciesOf } = input
  if (!Array.isArray(submitted)) return { ok: false, problems: [{ kind: 'not_an_array' }] }
  if (submitted.length > MAX_DEPENDENCIES) return { ok: false, problems: [{ kind: 'too_many', max: MAX_DEPENDENCIES }] }

  const problems: DependencyProblem[] = []
  const cleaned: string[] = []
  for (let i = 0; i < submitted.length; i++) {
    const raw = submitted[i]
    if (typeof raw !== 'string' || !raw.trim()) { problems.push({ kind: 'not_a_string', index: i }); continue }
    const value = raw.trim()
    if (!cleaned.includes(value)) cleaned.push(value)
  }
  if (problems.length) return { ok: false, problems }

  if (cleaned.includes(key)) problems.push({ kind: 'self_dependency', key })
  const unknown = cleaned.filter((k) => !knownKeys.has(k))
  if (unknown.length) problems.push({ kind: 'unknown_update', keys: [...unknown].sort() })
  if (problems.length) return { ok: false, problems }

  // Cycle detection over the graph the submitted list WOULD create. Depth-first with
  // an explicit stack so the report is the actual loop, not just a boolean.
  const stack: string[] = []
  const done = new Set<string>()
  const depsFor = (k: string): string[] => (k === key ? cleaned : dependenciesOf(k) ?? [])
  const walk = (k: string): string[] | null => {
    const at = stack.indexOf(k)
    if (at !== -1) return [...stack.slice(at), k]
    if (done.has(k)) return null
    stack.push(k)
    for (const next of depsFor(k)) {
      const cycle = walk(next)
      if (cycle) return cycle
    }
    stack.pop(); done.add(k)
    return null
  }
  const cycle = walk(key)
  if (cycle) problems.push({ kind: 'cycle', path: cycle })

  return problems.length ? { ok: false, problems } : { ok: true, dependencies: cleaned }
}

export function describeDependencyProblems(problems: DependencyProblem[]): string {
  return problems.map((p) => {
    switch (p.kind) {
      case 'not_an_array': return 'required updates must be a list'
      case 'too_many': return `an update cannot require more than ${p.max} others`
      case 'not_a_string': return `required update #${p.index + 1} is not a valid update key`
      case 'self_dependency': return `${p.key} cannot require itself`
      case 'unknown_update': return `unknown required update${p.keys.length === 1 ? '' : 's'}: ${p.keys.join(', ')}`
      case 'cycle': return `required updates form a loop: ${p.path.join(' → ')}`
    }
  }).join('; ')
}

/**
 * Is ONE prerequisite already on ONE target? Pure — the caller resolves the records.
 *
 * Two ways to be satisfied, both real evidence the target carries the code:
 *   • compatibility for that target is `already_present` — the owner assessed it as
 *     shipped, or
 *   • a deployment for that target lists the update, reached `deployed`, and its
 *     verification is `passed` or `waived`.
 *
 * A deployment that is merely `deployed` with `pending` verification is NOT enough —
 * unverified is precisely the state a half-finished rollout leaves behind.
 */
export function prerequisiteSatisfied(input: {
  updateKey: string
  compatStatus?: CompatStatus
  deployments: Pick<DeploymentRecord, 'updateKeys' | 'businessId' | 'status' | 'verificationStatus'>[]
  businessId: string
}): { satisfied: boolean; via?: 'already_present' | 'verified_deployment'; reason?: string } {
  if (input.compatStatus === 'already_present') return { satisfied: true, via: 'already_present' }
  const forTarget = input.deployments.filter((d) => d.businessId === input.businessId && d.updateKeys?.includes(input.updateKey))
  if (!forTarget.length) return { satisfied: false, reason: 'not installed on this business yet' }
  const deployed = forTarget.filter((d) => d.status === 'deployed')
  if (!deployed.length) return { satisfied: false, reason: 'started but never finished deploying' }
  const verified = deployed.filter((d) => d.verificationStatus === 'passed' || d.verificationStatus === 'waived')
  if (!verified.length) return { satisfied: false, reason: 'deployed but not verified yet' }
  return { satisfied: true, via: 'verified_deployment' }
}

export type RequiredUpdateVerdict = {
  key: string
  satisfied: boolean
  via?: 'already_present' | 'verified_deployment'
  reason?: string
}

/**
 * Every required update for one update × target. An update with no dependencies
 * yields an empty list and a satisfied verdict — existing records keep working
 * unchanged, which is the backward-compatibility requirement.
 */
export function evaluateRequiredUpdates(input: {
  dependencies: string[] | undefined
  businessId: string
  compatStatusFor: (updateKey: string) => CompatStatus | undefined
  deployments: Pick<DeploymentRecord, 'updateKeys' | 'businessId' | 'status' | 'verificationStatus'>[]
}): { ok: boolean; verdicts: RequiredUpdateVerdict[]; missing: string[] } {
  const verdicts = (input.dependencies ?? []).map((key) => ({
    key,
    ...prerequisiteSatisfied({
      updateKey: key,
      compatStatus: input.compatStatusFor(key),
      deployments: input.deployments,
      businessId: input.businessId,
    }),
  }))
  const missing = verdicts.filter((v) => !v.satisfied).map((v) => v.key)
  return { ok: missing.length === 0, verdicts, missing }
}

export function describeRequiredUpdates(verdicts: RequiredUpdateVerdict[]): string {
  const missing = verdicts.filter((v) => !v.satisfied)
  return missing.map((v) => `${v.key} (${v.reason ?? 'not ready'})`).join(', ')
}

// ── Businesses behind (target businesses not on the source's version) ────────
export function businessesBehind(businesses: PlatformBusiness[], sourceVersion: string | undefined): PlatformBusiness[] {
  if (!sourceVersion) return []
  return businesses.filter((b) => (b.role === 'target' || b.role === 'source_and_target')
    && compareVersions(b.currentVersion, sourceVersion) < 0)
}

// ── Attention items (dashboard "Attention Required") ─────────────────────────
export type AttentionItem = { severity: 'high' | 'med' | 'info'; text: string; kind: string; ref?: string }
export function computeAttention(
  updates: PlatformUpdate[],
  deployments: DeploymentRecord[],
  now: number,
): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const u of updates) {
    if (u.status === 'blocked') out.push({ severity: 'high', text: `Blocked: ${u.title}`, kind: 'blocked', ref: u.key })
    if (u.status === 'failed') out.push({ severity: 'high', text: `Failed: ${u.title}`, kind: 'failed', ref: u.key })
    if (u.status === 'ready_for_review') out.push({ severity: 'med', text: `Awaiting your review: ${u.title}`, kind: 'review', ref: u.key })
    if (isPending(u.status) && ageDays(u.updatedAt, now) > 14) out.push({ severity: 'med', text: `Untouched ${ageDays(u.updatedAt, now)}d: ${u.title}`, kind: 'stale', ref: u.key })
    if (isPending(u.status) && !u.sourceCommit) out.push({ severity: 'info', text: `Missing source commit: ${u.title}`, kind: 'no_commit', ref: u.key })
    if (u.migrationRequired && !u.rollbackSupported) out.push({ severity: 'med', text: `Migration without rollback: ${u.title}`, kind: 'no_rollback', ref: u.key })
  }
  for (const d of deployments) {
    if (d.status === 'failed') out.push({ severity: 'high', text: `Failed deployment to ${d.businessId}`, kind: 'deploy_failed', ref: d.id })
    if (d.status === 'deployed' && d.verificationStatus === 'pending') out.push({ severity: 'med', text: `Deployment to ${d.businessId} awaiting verification`, kind: 'await_verify', ref: d.id })
  }
  return out
}
