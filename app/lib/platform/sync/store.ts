// ── Operion Sync Status — persistence ────────────────────────────────────────
//
// Redis-backed store for the product registry, the latest reconciled snapshot per
// product, and the full reconciliation HISTORY (the operational audit trail). All keys
// live in the platform-global `platform:sync:*` family — never tenant-scoped (the key
// chokepoint's allowlist enforces this). No SQL, no migrations.

import { redis } from '../../redis'
import type { ReconciliationRecord, SyncProduct } from './types'

// ── Keys (all platform-global) ────────────────────────────────────────────────
const PRODUCT = (id: string) => `platform:sync:product:${id}`
const PRODUCT_INDEX = 'platform:sync:product:index'
const LATEST = (id: string) => `platform:sync:latest:${id}`
const HISTORY_INDEX = (id: string) => `platform:sync:history:${id}`
const HISTORY_REC = (recId: string) => `platform:sync:rec:${recId}`
const META = 'platform:sync:meta'

const HISTORY_LIMIT = 200

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ── Product registry ──────────────────────────────────────────────────────────
export async function getProduct(id: string): Promise<SyncProduct | null> {
  return safeParse<SyncProduct>(await redis.get(PRODUCT(id)))
}

export async function listProducts(): Promise<SyncProduct[]> {
  const ids = await redis.zrange(PRODUCT_INDEX, 0, -1)
  const out: SyncProduct[] = []
  for (const id of ids) {
    const p = await getProduct(id)
    if (p) out.push(p)
  }
  return out
}

export async function saveProduct(p: SyncProduct): Promise<SyncProduct> {
  await redis.set(PRODUCT(p.id), JSON.stringify(p))
  await redis.zadd(PRODUCT_INDEX, p.createdAt, p.id)
  return p
}

export async function deleteProduct(id: string): Promise<void> {
  // Registry entry only — the reconciliation history is retained as the audit trail.
  await redis.del(PRODUCT(id))
  await redis.zrem(PRODUCT_INDEX, id)
  await redis.del(LATEST(id))
}

// ── Reconciliation snapshots + history ────────────────────────────────────────
export async function saveReconciliation(rec: ReconciliationRecord): Promise<void> {
  await redis.set(LATEST(rec.productId), JSON.stringify(rec))
  await redis.set(HISTORY_REC(rec.id), JSON.stringify(rec))
  await redis.zadd(HISTORY_INDEX(rec.productId), rec.checkedAt, rec.id)
  // Trim the oldest history entries beyond the retention window.
  const all = await redis.zrange(HISTORY_INDEX(rec.productId), 0, -1)
  if (all.length > HISTORY_LIMIT) {
    for (const oldId of all.slice(0, all.length - HISTORY_LIMIT)) {
      await redis.zrem(HISTORY_INDEX(rec.productId), oldId)
      await redis.del(HISTORY_REC(oldId))
    }
  }
}

export async function getLatest(productId: string): Promise<ReconciliationRecord | null> {
  return safeParse<ReconciliationRecord>(await redis.get(LATEST(productId)))
}

export async function listHistory(productId: string, limit = 25): Promise<ReconciliationRecord[]> {
  const ids = await redis.zrevrange(HISTORY_INDEX(productId), 0, Math.max(0, limit - 1))
  const out: ReconciliationRecord[] = []
  for (const id of ids) {
    const rec = safeParse<ReconciliationRecord>(await redis.get(HISTORY_REC(id)))
    if (rec) out.push(rec)
  }
  return out
}

// ── Meta ────────────────────────────────────────────────────────────────────
export async function setLastGlobalSync(ts: number): Promise<void> {
  await redis.set(META, JSON.stringify({ lastGlobalSyncAt: ts }))
}

export async function getMeta(): Promise<{ lastGlobalSyncAt?: number }> {
  return safeParse<{ lastGlobalSyncAt?: number }>(await redis.get(META)) ?? {}
}
