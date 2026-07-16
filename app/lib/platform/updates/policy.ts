// ── Operion Update Center — PURE policy ──────────────────────────────────────
// No I/O, no clock, no randomness (callers pass `now`). Everything here is unit-
// testable. The store/routes/UI reason THROUGH these functions.

import type {
  PlatformUpdate, UpdateStatus, PlatformBusiness, DeploymentRecord, CheckStatus,
  UpdateCompatibility,
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
