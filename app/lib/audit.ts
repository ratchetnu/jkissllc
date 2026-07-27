import { redis } from './redis'
import { currentTenantId } from './platform/tenancy/context'

// Central audit log (request §11). The platform historically recorded events on the
// record itself (route.audit[], applicant.events[]); this is the first *cross-cutting*
// attributed log — every reminder/comms action lands here with who did it, when, and
// against what. Append-only, newest-first, capacity-bounded so it can't grow forever.
//
// Attribution comes from the resolved Principal (sub/role) — never a client-supplied
// id — so the log is trustworthy for compliance review.

export type AuditAction =
  | 'reminder.created' | 'reminder.edited' | 'reminder.deleted'
  | 'reminder.paused' | 'reminder.resumed' | 'reminder.archived' | 'reminder.duplicated'
  | 'reminder.sent' | 'reminder.opened' | 'reminder.acknowledged'
  | 'reminder.completed' | 'reminder.escalated' | 'reminder.failed'
  | 'dispatch.sent' | 'bulk.sent'
  | 'comm.dispatched'
  | 'manager.override' | 'admin.override'
  // ── Administrative identity / security events (Wave D/E) ──
  | 'user.created' | 'user.updated' | 'user.role_changed'
  | 'user.suspended' | 'user.reactivated' | 'user.deleted'
  // ── Payroll (FIN-1) ──
  // Exactly one line per statement that was actually issued; blocked duplicates and
  // lock contention record nothing.
  | 'paystatement.issued'
  // One line per statement actually voided (FIN-2); a repeated void of an
  // already-void statement changes nothing and records nothing.
  | 'paystatement.voided'
  // ── Time corrections (append-only; the original punch is never rewritten) ──
  | 'time.correction.created' | 'time.correction.superseded'
  // ── Crew compensation (immutable per-assignment snapshots) ──
  | 'crew.compensation.set'

export type AuditOutcome = 'success' | 'denied' | 'failure'

export type AuditEntry = {
  id: string
  at: number
  tenantId?: string        // stamped from the ambient tenant context; ABSENT on legacy records
  actor: string            // Principal.sub — 'owner' for the legacy admin
  actorRole: string        // 'admin' | 'manager' | 'crew' | 'system'
  action: AuditAction
  entity: string           // target type: 'reminder' | 'user' | 'crew' | ...
  entityId?: string        // target id
  outcome?: AuditOutcome   // absent on legacy records → treated as 'success'
  correlationId?: string   // request / event id when available
  summary: string          // human-readable one-liner for the log view
  meta?: Record<string, unknown>
}

// The trusted caller identity for an administrative audit event. Structural so a
// resolved Principal ({ sub, role }) satisfies it without this lib importing the API.
export type AuditActor = { sub: string; role: string }

const KEY = (id: string) => `audit:${id}`
const INDEX = 'audit:log'
const MAX_KEEP = 5000     // trim the index beyond this so the log stays bounded

function genId(): string {
  return `au_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function recordAudit(e: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): Promise<AuditEntry> {
  // Stamp the ambient tenant when the caller didn't pass one. Best-effort: if there
  // is no tenant context the field is simply absent (legacy-compatible), never a throw.
  let tenantId = e.tenantId
  if (tenantId === undefined) { try { tenantId = currentTenantId() ?? undefined } catch { /* no context */ } }
  const entry: AuditEntry = { id: genId(), at: e.at ?? Date.now(), ...e, tenantId }
  try {
    await redis.set(KEY(entry.id), JSON.stringify(entry))
    await redis.zadd(INDEX, entry.at, entry.id)
    // Best-effort trim: drop the oldest ids once we exceed the cap. zcard is cheap.
    const n = await redis.zcard(INDEX)
    if (n > MAX_KEEP + 200) {
      const stale = await redis.zrange(INDEX, 0, n - MAX_KEEP - 1)
      await Promise.all(stale.map(id => Promise.all([redis.del(KEY(id)), redis.zrem(INDEX, id)])))
    }
  } catch (err) {
    console.error('[audit] record failed', err)
  }
  return entry
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as AuditEntry : null } catch { return null } })
    .filter((x): x is AuditEntry => x !== null)
}

// Filtered view for an entity (e.g. one reminder's history). Scans the recent log —
// fine for the log volumes we keep; there is no per-entity index by design.
export async function listAuditForEntity(entityId: string, limit = 100): Promise<AuditEntry[]> {
  const recent = await listAudit(1000)
  return recent.filter(e => e.entityId === entityId).slice(0, limit)
}

// ── Administrative audit helper ───────────────────────────────────────────────
// One chokepoint for identity/security events: fills actor + role from the resolved
// Principal (never client input) and tenantId from context (via recordAudit). Emitted
// POST-COMMIT and FAIL-OPEN by policy — recordAudit swallows its own errors, so a lost
// audit line can never turn a completed administrative mutation into a partial result.
// Callers only emit when something actually changed, which also dedupes idempotent retries.
export async function auditAdmin(
  actor: AuditActor,
  action: AuditAction,
  opts: { entity: string; entityId?: string; outcome?: AuditOutcome; summary: string; meta?: Record<string, unknown>; correlationId?: string },
): Promise<AuditEntry> {
  return recordAudit({
    actor: actor.sub, actorRole: actor.role, action,
    entity: opts.entity, entityId: opts.entityId,
    outcome: opts.outcome ?? 'success',
    correlationId: opts.correlationId,
    summary: opts.summary, meta: opts.meta,
  })
}

// ── Query / filter (viewer) ───────────────────────────────────────────────────
export type AuditFilter = { actor?: string; action?: string; entity?: string; outcome?: string; start?: number; end?: number; search?: string }

// PURE filter over an already-loaded page of entries — unit-tested without Redis.
// Legacy records (no outcome) are treated as 'success' so an outcome filter of
// 'success' still matches them; missing fields are simply non-matching, never guessed.
export function filterAuditEntries(entries: AuditEntry[], filter: AuditFilter, limit = 200): AuditEntry[] {
  const s = filter.search?.trim().toLowerCase()
  return entries.filter((e) => {
    if (filter.actor && e.actor !== filter.actor) return false
    if (filter.action && e.action !== filter.action) return false
    if (filter.entity && e.entity !== filter.entity) return false
    if (filter.outcome && (e.outcome ?? 'success') !== filter.outcome) return false
    if (filter.start != null && e.at < filter.start) return false
    if (filter.end != null && e.at > filter.end) return false
    if (s && !`${e.summary} ${e.entityId ?? ''} ${e.actor}`.toLowerCase().includes(s)) return false
    return true
  }).slice(0, limit)
}

// Tenant-scoped by construction: listAudit reads `audit:log`, which the redis
// chokepoint namespaces to the current tenant when TENANCY_ENABLED — so this only
// ever sees the caller's tenant's records. `scanMax` bounds the work.
export async function queryAudit(filter: AuditFilter, limit = 200, scanMax = 2000): Promise<AuditEntry[]> {
  const recent = await listAudit(scanMax)
  return filterAuditEntries(recent, filter, limit)
}
