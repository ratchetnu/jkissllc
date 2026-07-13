// ── Tenant migration — pure logic ────────────────────────────────────────────
//
// Copy-only, reversible migration of legacy J KISS Redis keys to their
// tenant-scoped form: `key` → `t:{tenantId}:key`. NEVER deletes legacy keys.
// Idempotent (re-running skips already-copied equal values), resumable, batched,
// conflict-detecting. All logic is pure over a KvClient so it is fully testable
// against an in-memory store (scripts/tenant-migration is the ONLY non-redis.ts
// place allowed to talk to Upstash directly — it needs SCAN).

import { createHash } from 'node:crypto'
import { isPlatformGlobal, isTenantScoped, requireTenantKey, keyFamily } from '../../app/lib/platform/tenancy/keys'

export interface KvClient {
  scan(cursor: string, match: string, count: number): Promise<{ cursor: string; keys: string[] }>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  exists(key: string): Promise<boolean>
  del(key: string): Promise<void> // used ONLY by an explicitly-approved rollback, never by copy
}

export type MigrationPair = { legacy: string; target: string }
export type MigrationConflict = { legacy: string; target: string; reason: 'target-exists-different' }

// Families derived from user-facing strings — migrated cautiously (the id-remap is
// a separate step; this copy preserves the legacy key form).
export const NAME_DERIVED_FAMILIES = ['biz', 'promo', 'ship'] as const

export type Classified = { tenantOwned: string[]; platformGlobal: string[]; alreadyScoped: string[] }

export function classifyKeys(keys: string[]): Classified {
  const out: Classified = { tenantOwned: [], platformGlobal: [], alreadyScoped: [] }
  for (const k of keys) {
    if (isTenantScoped(k)) out.alreadyScoped.push(k)
    else if (isPlatformGlobal(k)) out.platformGlobal.push(k)
    else out.tenantOwned.push(k)
  }
  return out
}

export function isNameDerived(key: string): boolean {
  return (NAME_DERIVED_FAMILIES as readonly string[]).includes(keyFamily(key))
}

export function checksum(value: string | null): string {
  return value === null ? 'null' : createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size))
  return out
}

/** Enumerate every key via SCAN (cursor-based), bounded by count per page. */
export async function inventory(kv: KvClient, match = '*', count = 200): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const page = await kv.scan(cursor, match, count)
    keys.push(...page.keys)
    cursor = page.cursor
  } while (cursor !== '0')
  return keys
}

export type CopyResult = {
  copied: number
  skippedExisting: number
  conflicts: MigrationConflict[]
  pairs: MigrationPair[]
  dryRun: boolean
}

/**
 * Copy tenant-owned keys to their scoped form. Idempotent + non-destructive:
 *  - target absent            → copy (unless dryRun)
 *  - target present & equal   → skip (already migrated)
 *  - target present & differ  → CONFLICT (never overwrite)
 * Platform-global and already-scoped keys are skipped.
 */
export async function copyKeys(
  kv: KvClient,
  keys: string[],
  tenantId: string,
  opts: { dryRun: boolean; batchSize?: number; onProgress?: (done: number, total: number) => void } = { dryRun: true },
): Promise<CopyResult> {
  const { tenantOwned } = classifyKeys(keys)
  const res: CopyResult = { copied: 0, skippedExisting: 0, conflicts: [], pairs: [], dryRun: opts.dryRun }
  let done = 0
  for (const batch of chunk(tenantOwned, opts.batchSize ?? 100)) {
    for (const legacy of batch) {
      const target = requireTenantKey(tenantId, legacy)
      res.pairs.push({ legacy, target })
      const [legacyVal, targetExists] = await Promise.all([kv.get(legacy), kv.exists(target)])
      if (targetExists) {
        const targetVal = await kv.get(target)
        if (checksum(targetVal) === checksum(legacyVal)) { res.skippedExisting++ }
        else res.conflicts.push({ legacy, target, reason: 'target-exists-different' })
      } else if (!opts.dryRun && legacyVal !== null) {
        await kv.set(target, legacyVal)
        res.copied++
      } else if (opts.dryRun) {
        res.copied++ // would-copy count in dry-run
      }
      done++
      opts.onProgress?.(done, tenantOwned.length)
    }
  }
  return res
}

export type VerifyResult = { ok: number; missing: string[]; mismatch: string[] }

/** Verify every tenant-owned key has a matching scoped copy. */
export async function verifyKeys(kv: KvClient, keys: string[], tenantId: string): Promise<VerifyResult> {
  const { tenantOwned } = classifyKeys(keys)
  const res: VerifyResult = { ok: 0, missing: [], mismatch: [] }
  for (const legacy of tenantOwned) {
    const target = requireTenantKey(tenantId, legacy)
    const [lv, tv] = await Promise.all([kv.get(legacy), kv.get(target)])
    if (tv === null) res.missing.push(legacy)
    else if (checksum(lv) !== checksum(tv)) res.mismatch.push(legacy)
    else res.ok++
  }
  return res
}

/**
 * Rollback manifest: since migration only COPIES, undoing it means deleting the
 * scoped targets (legacy keys were never touched). The manifest is complete —
 * every target created is listed for deletion under a separate approved change.
 */
export function rollbackManifest(pairs: MigrationPair[]): { deleteTargets: string[]; note: string } {
  return {
    deleteTargets: pairs.map((p) => p.target),
    note: 'Rollback deletes ONLY the scoped targets. Legacy keys were never modified or deleted.',
  }
}
