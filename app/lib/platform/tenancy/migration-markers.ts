// ── Migration completion markers ─────────────────────────────────────────────
//
// A backfill that leaves no trace is indistinguishable from one that never ran.
// Both `runWave6Backfill` (user directory → per-tenant memberships) and
// `backfillTokenBindings` (public tokens → tenant bindings) return a report to
// whoever invoked them and then forget it — so the only way to answer "has the
// migration been done?" was to ask a human, and the honest answer to "is this
// deployment ready for multi-tenancy?" was therefore unavailable to any program.
//
// This records ONE small, platform-global fact per completed run so the GA
// readiness projection can report evidence instead of a guess.
//
// Rules:
//   • Written ONLY by a real (non-dry-run) execution. A dry run proves nothing.
//   • PLATFORM-GLOBAL (`platform:` is on the never-prefixed allowlist) because a
//     migration is a property of the deployment, not of a tenant's own data.
//   • Non-destructive: re-running a backfill overwrites its marker with the newer
//     run. The marker is evidence of the LAST completion, never a lock.
//   • Carries counts and an actor, never a record id, a token, or a credential.

import { redis } from '../../redis'
import { platformKey } from './keys'

export const MIGRATION_IDS = [
  'wave6-membership-backfill',
  'public-token-binding-backfill',
] as const
export type MigrationId = (typeof MIGRATION_IDS)[number]

export type MigrationMarker = {
  id: MigrationId
  /** Present for a per-tenant migration; absent for a deployment-wide one. */
  tenantId?: string
  completedAt: number
  actor: string
  /** Aggregate counts only — how much was scanned and changed. No record ids. */
  counts: Record<string, number>
  /** Anything the run could NOT complete, so a marker never overstates success. */
  unresolved?: string[]
}

function key(id: MigrationId, tenantId?: string): string {
  return platformKey(`platform:migration:${id}${tenantId ? `:${tenantId}` : ''}`)
}

/** Record a completed run. Fail-soft: a marker write must never fail the migration. */
export async function recordMigrationCompleted(marker: MigrationMarker): Promise<void> {
  try {
    await redis.set(key(marker.id, marker.tenantId), JSON.stringify(marker))
  } catch (err) {
    console.error('[migration-marker] could not record completion', marker.id, err)
  }
}

export async function getMigrationMarker(id: MigrationId, tenantId?: string): Promise<MigrationMarker | null> {
  try {
    const raw = await redis.get(key(id, tenantId))
    return raw ? (JSON.parse(raw as string) as MigrationMarker) : null
  } catch {
    // Unreadable is reported as ABSENT, never as complete. A readiness projection
    // that fails open is worse than one that under-claims.
    return null
  }
}

/** Every marker relevant to a tenant, including the deployment-wide ones. */
export async function listMigrationMarkers(tenantId?: string): Promise<MigrationMarker[]> {
  const out: MigrationMarker[] = []
  for (const id of MIGRATION_IDS) {
    const global = await getMigrationMarker(id)
    if (global) out.push(global)
    if (tenantId) {
      const scoped = await getMigrationMarker(id, tenantId)
      if (scoped) out.push(scoped)
    }
  }
  return out
}
