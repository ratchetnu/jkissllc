// ── Operion Release Center — controlled publish handoff (server-only) ────────
//
// The Release Center owns approval + idempotency. The automation job owns the ONE
// Production executor: merge the reviewed PR, wait for the resulting deployment, verify
// health, and reconcile every projection. This module joins those two responsibilities;
// it never promotes a Vercel Preview deployment directly.

import { consumeApproval } from './approval-store'
import { releaseBindingFingerprint, type ReleaseApproval, type ApprovalBinding } from './approval'
import {
  acquirePublishLock, releasePublishLock, startPublish, markVerifying, completePublish,
  failPublish, getPublishByApproval, type ReleasePublish,
} from './publish-store'
import { recordPlatformAudit } from '../updates/audit'

export type BeginPromotionFn = () => Promise<
  { ok: true } | { ok: false; error: string }
>

export type ExecutePublishInput = {
  now: number
  actor: string
  business: { id: string; slug: string }
  jobId: string
  approval: ReleaseApproval
  binding: ApprovalBinding
  mode: 'live' | 'simulated'
  /** Starts the authoritative automation merge/deploy state machine. Live mode only. */
  beginPromotion: BeginPromotionFn
}

export type ExecutePublishResult =
  | { ok: true; publish: ReleasePublish; idempotent: boolean }
  | { ok: false; code: 'IN_PROGRESS' | 'APPROVAL_NOT_CONSUMABLE' | 'PROMOTE_FAILED'; message: string; publish?: ReleasePublish }

export async function executePublish(i: ExecutePublishInput): Promise<ExecutePublishResult> {
  const prior = await getPublishByApproval(i.approval.id)
  if (prior) return { ok: true, publish: prior, idempotent: true }

  const lock = await acquirePublishLock(i.business.id, i.actor)
  if (!lock) return { ok: false, code: 'IN_PROGRESS', message: 'a publish is already in progress for this business' }

  try {
    const again = await getPublishByApproval(i.approval.id)
    if (again) return { ok: true, publish: again, idempotent: true }
    if (!(await lock.heldNow())) {
      return { ok: false, code: 'IN_PROGRESS', message: 'a publish is already in progress for this business' }
    }

    const fp = releaseBindingFingerprint(i.binding)
    const consumed = await consumeApproval(i.approval.id, { now: i.now, expectedFingerprint: fp })
    if (!consumed.ok) return { ok: false, code: 'APPROVAL_NOT_CONSUMABLE', message: 'the approval is no longer usable (expired, changed, or already used)' }

    await audit(i, 'approval.consumed', `Approval ${i.approval.id} consumed for publish`, { approvalId: i.approval.id })
    const publish = await startPublish({
      now: i.now, businessId: i.business.id, businessSlug: i.business.slug,
      approvalId: i.approval.id, jobId: i.jobId,
      releaseId: i.binding.releaseId, sourceDeploymentId: i.binding.sourceDeploymentId,
      mode: i.mode, startedBy: i.actor,
    })
    await audit(i, 'publish.started', `Publish ${publish.id} started (${i.mode}) for ${i.business.slug} → production`, { publishId: publish.id, jobId: i.jobId, mode: i.mode })

    // Preview/development is an honest simulation: consume + record the approval flow but
    // never mutate an automation job or provider.
    if (i.mode === 'simulated') {
      const done = await completePublish(publish.id, i.now)
      await audit(i, 'publish.completed', `Publish ${publish.id} simulation completed`, { publishId: publish.id, jobId: i.jobId, mode: i.mode })
      return { ok: true, publish: done ?? publish, idempotent: false }
    }

    let started: Awaited<ReturnType<BeginPromotionFn>>
    try { started = await i.beginPromotion() }
    catch (e) { started = { ok: false, error: e instanceof Error ? e.message : 'promotion start failed' } }
    if (!started.ok) {
      const failed = await failPublish(publish.id, i.now, started.error)
      await audit(i, 'publish.failed', `Publish ${publish.id} could not start: ${started.error}`, { publishId: publish.id, jobId: i.jobId, mode: i.mode })
      return { ok: false, code: 'PROMOTE_FAILED', message: 'the production promotion could not start', publish: failed ?? publish }
    }

    // The cron-driven automation job will mark this completed/failed after Production is
    // actually deployed and healthy. Never claim success on an accepted start.
    const verifying = await markVerifying(publish.id, i.now)
    await audit(i, 'promotion.started', `Automation job ${i.jobId} owns Production promotion`, { publishId: publish.id, jobId: i.jobId, mode: i.mode })
    return { ok: true, publish: verifying ?? publish, idempotent: false }
  } finally {
    await releasePublishLock(lock)
  }
}

async function audit(
  i: ExecutePublishInput,
  action: 'approval.consumed' | 'publish.started' | 'publish.completed' | 'publish.failed' | 'promotion.started',
  summary: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await recordPlatformAudit({
    actor: i.actor, actorType: 'owner', source: 'publish-executor', action,
    businessId: i.business.id, jobId: i.jobId, commit: i.binding.releaseId,
    deploymentId: i.binding.sourceDeploymentId, summary, meta,
  })
}
