// ── Operion Release Center — rollback executor (server-only) ─────────────────
//
// Increment 3B.6. Performs EXACTLY ONE production rollback (promote the prior known-good
// deployment back to production), then stops. It NEVER merges, dispatches a workflow, or mutates
// a business/job — the only external effect is the injected `promote`, and even that runs ONLY in
// 'live' mode (Production runtime + flag). Everywhere else it is a simulated no-op, so
// development/testing never touch real production.
//
// Safety + idempotency mirror the publish executor: a per-business rollback LOCK serializes
// concurrent clicks, and a per-target POINTER means a repeat returns the existing rollback record
// instead of promoting again.

import {
  acquireRollbackLock, releaseRollbackLock, startRollback, completeRollback, failRollback, getRollbackByTarget,
} from './rollback-store'
import type { ReleaseRollback } from './release-history'
import { recordPlatformAudit } from '../updates/audit'

export type RollbackPromoteFn = (
  project: string,
  deploymentId: string,
) => Promise<{ ok: true } | { ok: false; error: string; category?: string }>

export type ExecuteRollbackInput = {
  now: number
  actor: string
  business: { id: string; slug: string; project: string }
  targetDeploymentId: string
  targetCommit?: string
  fromDeploymentId?: string
  rolledBackPublishId?: string
  mode: 'live' | 'simulated'
  promote: RollbackPromoteFn
}

export type ExecuteRollbackResult =
  | { ok: true; rollback: ReleaseRollback; idempotent: boolean }
  | { ok: false; code: 'IN_PROGRESS' | 'PROMOTE_FAILED'; message: string; rollback?: ReleaseRollback }

export async function executeRollback(i: ExecuteRollbackInput): Promise<ExecuteRollbackResult> {
  // Idempotency (pre-lock fast path): this exact target already drove a rollback → return it.
  const prior = await getRollbackByTarget(i.business.id, i.targetDeploymentId)
  if (prior) return { ok: true, rollback: prior, idempotent: true }

  const got = await acquireRollbackLock(i.business.id, i.actor)
  if (!got) return { ok: false, code: 'IN_PROGRESS', message: 'a rollback is already in progress for this business' }

  try {
    const again = await getRollbackByTarget(i.business.id, i.targetDeploymentId)
    if (again) return { ok: true, rollback: again, idempotent: true }

    const rollback = await startRollback({
      now: i.now, businessId: i.business.id, businessSlug: i.business.slug,
      targetDeploymentId: i.targetDeploymentId, targetCommit: i.targetCommit, fromDeploymentId: i.fromDeploymentId,
      rolledBackPublishId: i.rolledBackPublishId, mode: i.mode, startedBy: i.actor,
    })
    await audit(i, 'rollback.started', `Rollback ${rollback.id} started (${i.mode}) → restore ${i.targetDeploymentId}`, { rollbackId: rollback.id, mode: i.mode })

    let res: Awaited<ReturnType<RollbackPromoteFn>>
    try { res = await i.promote(i.business.project, i.targetDeploymentId) }
    catch (e) { res = { ok: false, error: e instanceof Error ? e.message : 'rollback error' } }

    if (res.ok) {
      const done = await completeRollback(rollback.id, i.now)
      await audit(i, 'rollback.completed', `Rollback ${rollback.id} completed (${i.mode}) — production restored to ${i.targetDeploymentId}`, { rollbackId: rollback.id, deploymentId: i.targetDeploymentId, mode: i.mode })
      return { ok: true, rollback: done ?? rollback, idempotent: false }
    }
    const failed = await failRollback(rollback.id, i.now, res.error)
    await audit(i, 'rollback.failed', `Rollback ${rollback.id} failed: ${res.error}`, { rollbackId: rollback.id, mode: i.mode })
    return { ok: false, code: 'PROMOTE_FAILED', message: 'the production rollback failed', rollback: failed ?? rollback }
  } finally {
    await releaseRollbackLock(i.business.id)
  }
}

async function audit(
  i: ExecuteRollbackInput,
  action: 'rollback.started' | 'rollback.completed' | 'rollback.failed',
  summary: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await recordPlatformAudit({
    actor: i.actor, actorType: 'owner', source: 'rollback-executor', action,
    businessId: i.business.id, commit: i.targetCommit, deploymentId: i.targetDeploymentId, summary, meta,
  })
}
