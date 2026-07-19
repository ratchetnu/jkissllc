// ── Operion Release Center — publish executor (server-only) ──────────────────
//
// Increment 3B.4. Performs EXACTLY ONE production promotion for an approved release, then
// stops. It NEVER merges, rolls back, dispatches a workflow, or mutates a business/job — the
// only external effect is the injected `promote` (a Vercel deployment→production promotion),
// and even that runs ONLY in 'live' mode (Production runtime + flag). In every other context
// `promote` is a simulated no-op, so development/testing NEVER promote real production.
//
// Ordering guarantees safety + idempotency:
//   1. per-business publish LOCK (atomic) — concurrent clicks serialize; the loser is told
//      it is already in progress and never launches a second promotion.
//   2. per-approval idempotency POINTER — a repeat for an already-used approval returns the
//      existing publish record instead of promoting again.
//   3. the approval is CONSUMED (single-use) BEFORE the promotion — so a retry cannot reuse
//      it even if the promotion fails (retry is intentionally unavailable this phase).

import { consumeApproval } from './approval-store'
import { releaseBindingFingerprint, type ReleaseApproval, type ApprovalBinding } from './approval'
import {
  acquirePublishLock, releasePublishLock, startPublish, completePublish, failPublish, getPublishByApproval,
  type ReleasePublish,
} from './publish-store'
import { recordPlatformAudit } from '../updates/audit'

export type PromoteFn = (
  project: string,
  deploymentId: string,
) => Promise<{ ok: true; promotedDeploymentId?: string } | { ok: false; error: string; category?: string }>

export type ExecutePublishInput = {
  now: number
  actor: string
  business: { id: string; slug: string; project: string }
  approval: ReleaseApproval
  binding: ApprovalBinding
  mode: 'live' | 'simulated'
  promote: PromoteFn
}

export type ExecutePublishResult =
  | { ok: true; publish: ReleasePublish; idempotent: boolean }
  | { ok: false; code: 'IN_PROGRESS' | 'APPROVAL_NOT_CONSUMABLE' | 'PROMOTE_FAILED'; message: string; publish?: ReleasePublish }

export async function executePublish(i: ExecutePublishInput): Promise<ExecutePublishResult> {
  // Idempotency (pre-lock fast path): this approval already drove a publish → return it.
  const prior = await getPublishByApproval(i.approval.id)
  if (prior) return { ok: true, publish: prior, idempotent: true }

  const got = await acquirePublishLock(i.business.id, i.actor)
  if (!got) return { ok: false, code: 'IN_PROGRESS', message: 'a publish is already in progress for this business' }

  try {
    // Re-check idempotency inside the lock (a concurrent winner may have just bound it).
    const again = await getPublishByApproval(i.approval.id)
    if (again) return { ok: true, publish: again, idempotent: true }

    // Consume the approval atomically FIRST (single-use). Requires it still be active + bound.
    const fp = releaseBindingFingerprint(i.binding)
    const consumed = await consumeApproval(i.approval.id, { now: i.now, expectedFingerprint: fp })
    if (!consumed.ok) return { ok: false, code: 'APPROVAL_NOT_CONSUMABLE', message: 'the approval is no longer usable (expired, changed, or already used)' }

    await audit(i, 'approval.consumed', `Approval ${i.approval.id} consumed for publish`, { approvalId: i.approval.id })

    const publish = await startPublish({
      now: i.now, businessId: i.business.id, businessSlug: i.business.slug, approvalId: i.approval.id,
      releaseId: i.binding.releaseId, sourceDeploymentId: i.binding.sourceDeploymentId, mode: i.mode, startedBy: i.actor,
    })
    await audit(i, 'publish.started', `Publish ${publish.id} started (${i.mode}) for ${i.business.slug} → production`, { publishId: publish.id, mode: i.mode })

    // The ONE external effect. In simulated mode this performs no Vercel call.
    let res: Awaited<ReturnType<PromoteFn>>
    try { res = await i.promote(i.business.project, i.binding.sourceDeploymentId) }
    catch (e) { res = { ok: false, error: e instanceof Error ? e.message : 'promotion error' } }

    if (res.ok) {
      const done = await completePublish(publish.id, i.now, res.promotedDeploymentId ?? i.binding.sourceDeploymentId)
      await audit(i, 'deployment.promoted', `Deployment ${i.binding.sourceDeploymentId} promoted to production (${i.mode})`, { publishId: publish.id, deploymentId: i.binding.sourceDeploymentId, mode: i.mode })
      await audit(i, 'publish.completed', `Publish ${publish.id} completed (${i.mode})`, { publishId: publish.id, mode: i.mode })
      return { ok: true, publish: done ?? publish, idempotent: false }
    }
    const failed = await failPublish(publish.id, i.now, res.error)
    await audit(i, 'publish.failed', `Publish ${publish.id} failed: ${res.error}`, { publishId: publish.id, mode: i.mode })
    return { ok: false, code: 'PROMOTE_FAILED', message: 'the production promotion failed', publish: failed ?? publish }
  } finally {
    await releasePublishLock(i.business.id)
  }
}

async function audit(
  i: ExecutePublishInput,
  action: 'approval.consumed' | 'publish.started' | 'publish.completed' | 'publish.failed' | 'deployment.promoted',
  summary: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await recordPlatformAudit({
    actor: i.actor, actorType: 'owner', source: 'publish-executor', action,
    businessId: i.business.id, commit: i.binding.releaseId, deploymentId: i.binding.sourceDeploymentId,
    summary, meta,
  })
}
