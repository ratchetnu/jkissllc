// ── Operion Update Center — platform audit log (platform:audit:* global family) ──
//
// The attributed, append-only record of what the platform control-plane did to
// release/deployment records — especially the AUTOMATIC reconciliation events that
// finalize a production promotion (merged → deployed → verified → records updated).
//
// This is deliberately SEPARATE from app/lib/audit.ts: that log is tenant-scoped
// operational history (reminders/dispatch); this one lives on the never-tenant-scoped
// `platform:` allowlist alongside the rest of the Update Center's system-of-record, so
// platform-owner events are global and independent of any tenant context.
//
// Fail-soft: recording an audit event must NEVER break a deployment reconciliation.

import { redis } from '../../redis'

export type PlatformAuditAction =
  | 'promotion.merged'
  | 'promotion.production_deployment_discovered'
  | 'promotion.production_ready'
  | 'promotion.health_passed'
  | 'promotion.smoke_passed'
  | 'promotion.deployment_verified'
  | 'promotion.business_commit_updated'
  | 'promotion.update_target_deployed'
  | 'promotion.update_fully_deployed'
  | 'promotion.update_partially_deployed'
  | 'promotion.release_completed'
  | 'promotion.release_partially_completed'
  | 'promotion.rollback_required'
  | 'promotion.rolled_back'
  | 'reconcile.records_finalized'
  | 'reconcile.status_repaired'
  | 'reconcile.external_deployment_matched'
  | 'reconcile.ambiguous_match'
  | 'status.manual_correction'
  // Owner pre-publish approval gate (Increment 3B.3). Records intent only — no publish.
  | 'approval.created'
  | 'approval.rejected'
  | 'approval.expired'
  | 'approval.invalidated'
  | 'approval.revoked'
  | 'approval.consumed'
  // Controlled Production publish (Increment 3B.4). Consumes an approval + promotes.
  | 'publish.started'
  | 'publish.completed'
  | 'publish.failed'
  | 'deployment.promoted'
  // Controlled owner rollback (Increment 3B.6). Restores the prior production deployment.
  | 'rollback.started'
  | 'rollback.completed'
  | 'rollback.failed'
  // Owner responses to AI shadow alerts. Every state change an owner makes to an alert is
  // attributed here — an alert that was silenced must be explainable months later.
  | 'shadow_alert.acknowledged'
  | 'shadow_alert.resolved'
  | 'shadow_alert.muted'
  | 'shadow_alert.unmuted'
  | 'shadow_alert.note_added'
  | 'shadow_alert.read'

export const SHADOW_ALERT_AUDIT_ACTIONS: readonly PlatformAuditAction[] = [
  'shadow_alert.acknowledged', 'shadow_alert.resolved', 'shadow_alert.muted',
  'shadow_alert.unmuted', 'shadow_alert.note_added', 'shadow_alert.read',
] as const

export const isShadowAlertAuditAction = (a: string): a is PlatformAuditAction =>
  (SHADOW_ALERT_AUDIT_ACTIONS as readonly string[]).includes(a)

export type PlatformAuditEvent = {
  id: string                       // PAUD-{n}
  at: number
  actor: string                    // Principal.sub, or 'system' for background reconciliation
  actorType: 'owner' | 'system'
  source: string                   // 'advancePromotion' | 'reconciler' | 'manual' | ...
  action: PlatformAuditAction
  businessId?: string
  updateKey?: string
  jobId?: string
  alertId?: string                 // SAL-{n} — a shadow alert this event acted on
  deploymentId?: string            // Vercel deployment id
  releaseVersion?: string
  commit?: string
  priorStatus?: string
  newStatus?: string
  summary: string
  traceId?: string
  meta?: Record<string, unknown>
}

const KEY = (id: string) => `platform:audit:${id}`
const INDEX = 'platform:audit:index'
const CTR = 'platform:audit:counter'
const MAX_KEEP = 5000

export async function recordPlatformAudit(
  e: Omit<PlatformAuditEvent, 'id' | 'at'> & { at?: number },
): Promise<PlatformAuditEvent | null> {
  try {
    const id = `PAUD-${1000 + (await redis.incr(CTR))}`
    const entry: PlatformAuditEvent = { id, at: e.at ?? Date.now(), ...e }
    await redis.set(KEY(id), JSON.stringify(entry))
    await redis.zadd(INDEX, entry.at, id)
    // Best-effort bounded trim so the log can't grow forever.
    const n = await redis.zcard(INDEX)
    if (n > MAX_KEEP + 200) {
      const stale = await redis.zrange(INDEX, 0, n - MAX_KEEP - 1)
      await Promise.all(stale.map((sid) => Promise.all([redis.del(KEY(sid)), redis.zrem(INDEX, sid)])))
    }
    return entry
  } catch (err) {
    console.warn('[platform-audit] record failed (soft):', err instanceof Error ? err.message : err)
    return null
  }
}

function parse(raw: string | null): PlatformAuditEvent | null {
  if (!raw) return null
  try { return JSON.parse(raw) as PlatformAuditEvent } catch { return null }
}

export async function listPlatformAudit(limit = 200): Promise<PlatformAuditEvent[]> {
  const ids = await redis.zrevrange(INDEX, 0, Math.max(0, limit - 1))
  if (!ids.length) return []
  const raws = await Promise.all(ids.map((id) => redis.get(KEY(id))))
  return raws.map(parse).filter((x): x is PlatformAuditEvent => x !== null)
}

/** History filtered to one job/update/business/alert — scans the recent log (no per-ref index). */
export async function listPlatformAuditForRef(
  ref: { jobId?: string; updateKey?: string; businessId?: string; alertId?: string },
  limit = 100,
): Promise<PlatformAuditEvent[]> {
  const recent = await listPlatformAudit(1000)
  return recent
    .filter((e) =>
      (ref.jobId ? e.jobId === ref.jobId : true) &&
      (ref.updateKey ? e.updateKey === ref.updateKey : true) &&
      (ref.businessId ? e.businessId === ref.businessId : true) &&
      (ref.alertId ? e.alertId === ref.alertId : true) &&
      // An empty ref must return nothing — never silently fall back to the whole log.
      (ref.jobId || ref.updateKey || ref.businessId || ref.alertId ? true : false))
    .slice(0, limit)
}
