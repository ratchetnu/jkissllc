import { redis } from './redis'

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

export type AuditEntry = {
  id: string
  at: number
  actor: string            // Principal.sub — 'owner' for the legacy admin
  actorRole: string        // 'admin' | 'manager' | 'crew' | 'system'
  action: AuditAction
  entity: string           // 'reminder' | 'reminder_instance' | 'crew' | ...
  entityId?: string
  summary: string          // human-readable one-liner for the log view
  meta?: Record<string, unknown>
}

const KEY = (id: string) => `audit:${id}`
const INDEX = 'audit:log'
const MAX_KEEP = 5000     // trim the index beyond this so the log stays bounded

function genId(): string {
  return `au_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function recordAudit(e: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): Promise<AuditEntry> {
  const entry: AuditEntry = { id: genId(), at: e.at ?? Date.now(), ...e }
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
