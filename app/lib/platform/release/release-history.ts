// ── Operion Release Center — Release History & Details (PURE projection) ─────
//
// Increment 3B.6. Projects the EXISTING release records (publish records from 3B.4, their
// approvals from 3B.3, rollback records from this increment, and the platform audit log)
// into a unified, filterable Release History + a per-release Details view. NO new source of
// truth — every field is derived from what already happened. No I/O here; the route assembles
// the records and calls these pure functions.

import type { ReleasePublish } from './publish-store'
import type { PublishRecordStatus } from './publish'
import type { ReleaseApproval } from './approval'
import type { PlatformAuditEvent } from '../updates/audit'

export type ReleaseKind = 'publish' | 'rollback'
export type ReleaseEnvironment = 'production'
export type ReleaseExecutionMode = 'live' | 'simulated'

/** Calm, external release status (distinct from the internal record status). */
export type ReleaseHistoryStatus =
  | 'publishing' | 'verifying' | 'published' | 'publish_failed'
  | 'rolling_back' | 'rolled_back' | 'rollback_failed'

/** A rollback record (persisted by the 3B.6 rollback store). Kept structurally close to a
 *  publish record so history can treat both uniformly. */
export type ReleaseRollback = {
  recordVersion: number
  id: string                       // RBK-{n}
  businessId: string
  businessSlug: string
  targetDeploymentId: string       // the prior-production deployment being restored
  targetCommit?: string
  fromDeploymentId?: string        // the deployment being rolled back FROM (the failed/current)
  rolledBackPublishId?: string     // the publish (release) this rollback reverses
  targetEnvironment: ReleaseEnvironment
  mode: ReleaseExecutionMode
  status: 'rolling_back' | 'completed' | 'failed'
  approvalId?: string
  approvedBy?: string
  approvedAt?: number
  failureReason?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  startedBy: string
}

export type ReleaseHistoryEntry = {
  id: string
  kind: ReleaseKind
  at: number                       // release timestamp (startedAt)
  businessId: string
  businessSlug: string
  commit?: string
  branch?: string
  environment: ReleaseEnvironment
  deploymentId?: string            // promoted (publish) or restored (rollback)
  sourceDeploymentId?: string
  status: ReleaseHistoryStatus
  mode: ReleaseExecutionMode
  approvalId?: string
  approvingOwner?: string
  approvalAt?: number
  publishAt?: number               // completedAt (terminal timestamp)
  failureReason?: string
  // Rollback relationship (both directions).
  rollbackOfPublishId?: string     // set on a rollback entry → the release it reverses
  rolledBackByRollbackId?: string  // set on a publish entry → the rollback that reversed it
  startedBy: string
}

const PUBLISH_STATUS: Record<PublishRecordStatus, ReleaseHistoryStatus> = {
  promoting: 'publishing', verifying: 'verifying', completed: 'published', failed: 'publish_failed',
}
const ROLLBACK_STATUS: Record<ReleaseRollback['status'], ReleaseHistoryStatus> = {
  rolling_back: 'rolling_back', completed: 'rolled_back', failed: 'rollback_failed',
}

export function publishToHistoryEntry(p: ReleasePublish, approval?: ReleaseApproval | null, rolledBackByRollbackId?: string): ReleaseHistoryEntry {
  return {
    id: p.id, kind: 'publish', at: p.startedAt,
    businessId: p.businessId, businessSlug: p.businessSlug, commit: p.releaseId,
    environment: p.targetEnvironment, deploymentId: p.promotedDeploymentId ?? p.sourceDeploymentId,
    sourceDeploymentId: p.sourceDeploymentId, status: PUBLISH_STATUS[p.status], mode: p.mode,
    approvalId: p.approvalId, approvingOwner: approval?.approvedBy, approvalAt: approval?.approvedAt,
    publishAt: p.completedAt, failureReason: p.failureReason, rolledBackByRollbackId, startedBy: p.startedBy,
  }
}

export function rollbackToHistoryEntry(r: ReleaseRollback): ReleaseHistoryEntry {
  return {
    id: r.id, kind: 'rollback', at: r.startedAt,
    businessId: r.businessId, businessSlug: r.businessSlug, commit: r.targetCommit,
    environment: r.targetEnvironment, deploymentId: r.targetDeploymentId, sourceDeploymentId: r.fromDeploymentId,
    status: ROLLBACK_STATUS[r.status], mode: r.mode,
    approvalId: r.approvalId, approvingOwner: r.approvedBy, approvalAt: r.approvedAt,
    publishAt: r.completedAt, failureReason: r.failureReason, rollbackOfPublishId: r.rolledBackPublishId, startedBy: r.startedBy,
  }
}

/**
 * Build the unified, newest-first release history from publish + rollback records. A publish
 * is annotated with the rollback (if any) that later reversed it (via rolledBackPublishId).
 */
export function buildReleaseHistory(input: {
  publishes: ReleasePublish[]
  approvalsById: Map<string, ReleaseApproval>
  rollbacks?: ReleaseRollback[]
}): ReleaseHistoryEntry[] {
  const rollbacks = input.rollbacks ?? []
  const rollbackByPublishId = new Map<string, string>()
  for (const r of rollbacks) if (r.status === 'completed' && r.rolledBackPublishId) rollbackByPublishId.set(r.rolledBackPublishId, r.id)

  const entries: ReleaseHistoryEntry[] = [
    ...input.publishes.map((p) => publishToHistoryEntry(p, p.approvalId ? input.approvalsById.get(p.approvalId) : null, rollbackByPublishId.get(p.id))),
    ...rollbacks.map(rollbackToHistoryEntry),
  ]
  return entries.sort((a, b) => b.at - a.at)
}

export type ReleaseHistoryFilter = {
  businessId?: string
  environment?: string
  status?: ReleaseHistoryStatus | string
  kind?: ReleaseKind
  from?: number                    // inclusive lower bound on `at`
  to?: number                      // inclusive upper bound on `at`
}

/** Apply the owner-selectable filters (business / environment / date / status). Pure. */
export function filterReleaseHistory(entries: ReleaseHistoryEntry[], f: ReleaseHistoryFilter): ReleaseHistoryEntry[] {
  return entries.filter((e) =>
    (f.businessId ? e.businessId === f.businessId : true) &&
    (f.environment ? e.environment === f.environment : true) &&
    (f.status ? e.status === f.status : true) &&
    (f.kind ? e.kind === f.kind : true) &&
    (f.from != null ? e.at >= f.from : true) &&
    (f.to != null ? e.at <= f.to : true),
  )
}

// ── Release Details (per-release, Phase 2) ────────────────────────────────────
export type ReleaseAuditLine = { id: string; at: number; action: string; summary: string; actor: string }

export type ReleaseDetails = {
  release: ReleaseHistoryEntry
  auditTrail: ReleaseAuditLine[]
}

/** Assemble the detail view for one release from its entry + the related audit events. */
export function buildReleaseDetails(entry: ReleaseHistoryEntry, auditEvents: PlatformAuditEvent[]): ReleaseDetails {
  const auditTrail = auditEvents
    .filter((e) => (entry.commit ? e.commit === entry.commit : true) && e.businessId === entry.businessId)
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ id: e.id, at: e.at, action: e.action, summary: e.summary, actor: e.actor }))
  return { release: entry, auditTrail }
}
