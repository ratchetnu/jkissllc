// ── Phase-1 provisioning: pure planning logic ────────────────────────────────
//
// Deterministic, auditable backfill for Multi-Tenant Phase 1. It seeds three
// things for the reference tenant (J KISS LLC) and NOTHING else:
//   1. the tenant registry record        platform:tenant:jkiss (+ index)
//   2. the owner membership              platform:membership:jkiss:owner (+ 2 indexes)
//   3. the tenant-scoped branding record t:jkiss:settings:branding
//
// Everything here is PURE: `buildProvisionPlan()` computes the exact ordered set of
// writes and the reverse rollback set from fixed seeds — no Date.now(), no random
// ids, no Redis. Two calls produce byte-identical plans, so a dry-run shows exactly
// what an apply will do. `applyPlan`/`verifyPlan`/`rollbackPlan` operate over an
// injected minimal KV, so the whole thing is unit-testable in memory (the CLI wires
// the real Upstash client).
//
// SAFETY: additive + reversible. `apply` is idempotent and conflict-safe (an
// existing DIFFERENT value is a conflict and is never overwritten). Legacy keys are
// never touched. Rollback deletes ONLY the seeded targets.

import { JKISS_TENANT } from '../../app/lib/platform/tenancy/jkiss'
import { membershipId } from '../../app/lib/platform/tenancy/membership'
import { requireTenantKey, normalizeTenantId } from '../../app/lib/platform/tenancy/keys'
import { brandingDefaultsFor, type TenantBranding } from '../../app/lib/platform/tenancy/tenant-settings/branding-store'
import { DEFAULT_TENANT_ID, type Membership, type Tenant } from '../../app/lib/platform/tenancy/types'

// ── Minimal KV the planner/executor needs (a subset of the real client) ──────
export type PhaseKv = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  zadd(key: string, score: number, member: string): Promise<void>
  zrem(key: string, member: string): Promise<void>
}

export type SetOp = { op: 'set'; key: string; value: string }
export type ZAddOp = { op: 'zadd'; key: string; score: number; member: string }
export type WriteOp = SetOp | ZAddOp

export type DelOp = { op: 'del'; key: string }
export type ZRemOp = { op: 'zrem'; key: string; member: string }
export type UndoOp = DelOp | ZRemOp

export type ProvisionPlan = {
  tenantId: string
  writes: WriteOp[]
  rollback: UndoOp[]
}

// ── Deterministic seeds ──────────────────────────────────────────────────────
export function referenceTenantSeed(): Tenant {
  return JKISS_TENANT
}

export function referenceMembershipSeed(): Membership {
  return {
    id: membershipId(DEFAULT_TENANT_ID, 'owner'),
    tenantId: DEFAULT_TENANT_ID,
    userId: 'owner',
    role: 'admin',
    status: 'active',
    createdAt: 0,
  }
}

export function referenceBrandingSeed(): TenantBranding {
  return brandingDefaultsFor(JKISS_TENANT)
}

// ── Stable JSON so a re-run produces byte-identical values (idempotency) ──────
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/**
 * Build the full, deterministic provisioning plan for the reference tenant. The
 * write order is dependency-safe (records before indexes); the rollback is the
 * exact reverse so an apply is perfectly undoable.
 */
export function buildProvisionPlan(): ProvisionPlan {
  const tenantId = normalizeTenantId(DEFAULT_TENANT_ID)
  const tenant = referenceTenantSeed()
  const membership = referenceMembershipSeed()
  const branding = referenceBrandingSeed()

  const tenantRec = `platform:tenant:${tenantId}`
  const tenantIndex = 'platform:tenant:index'
  const mbrRec = `platform:membership:${tenantId}:owner`
  const mbrByUser = 'platform:membership:byuser:owner'
  const mbrByTenant = `platform:membership:bytenant:${tenantId}`
  // The tenant-SCOPED branding key — pre-seeded so a flag flip is byte-identical.
  const brandingScoped = requireTenantKey(tenantId, 'settings:branding')

  const writes: WriteOp[] = [
    { op: 'set', key: tenantRec, value: stableStringify(tenant) },
    { op: 'zadd', key: tenantIndex, score: tenant.createdAt, member: tenantId },
    { op: 'set', key: mbrRec, value: stableStringify(membership) },
    { op: 'zadd', key: mbrByUser, score: membership.createdAt, member: tenantId },
    { op: 'zadd', key: mbrByTenant, score: membership.createdAt, member: 'owner' },
    { op: 'set', key: brandingScoped, value: stableStringify(branding) },
  ]

  const rollback: UndoOp[] = [
    { op: 'del', key: brandingScoped },
    { op: 'zrem', key: mbrByTenant, member: 'owner' },
    { op: 'zrem', key: mbrByUser, member: tenantId },
    { op: 'del', key: mbrRec },
    { op: 'zrem', key: tenantIndex, member: tenantId },
    { op: 'del', key: tenantRec },
  ]

  return { tenantId, writes, rollback }
}

export type ApplyResult = {
  applied: number // ops written
  skipped: number // already-present, equal
  conflicts: { key: string }[] // present but DIFFERENT — never overwritten
}

/**
 * Apply a plan idempotently and conflict-safely:
 *   • SET where the target is absent → write (applied);
 *   • SET where the target equals the seed → skip;
 *   • SET where the target DIFFERS → conflict (never overwritten);
 *   • ZADD → idempotent add (a set membership).
 */
export async function applyPlan(kv: PhaseKv, plan: ProvisionPlan): Promise<ApplyResult> {
  const res: ApplyResult = { applied: 0, skipped: 0, conflicts: [] }
  for (const w of plan.writes) {
    if (w.op === 'set') {
      const existing = await kv.get(w.key)
      if (existing === null) {
        await kv.set(w.key, w.value)
        res.applied++
      } else if (existing === w.value) {
        res.skipped++
      } else {
        res.conflicts.push({ key: w.key })
      }
    } else {
      await kv.zadd(w.key, w.score, w.member)
      res.applied++
    }
  }
  return res
}

export type VerifyResult = { ok: boolean; missing: string[]; mismatched: string[] }

/** Confirm every SET target exists and equals its seed value. */
export async function verifyPlan(kv: PhaseKv, plan: ProvisionPlan): Promise<VerifyResult> {
  const missing: string[] = []
  const mismatched: string[] = []
  for (const w of plan.writes) {
    if (w.op !== 'set') continue
    const v = await kv.get(w.key)
    if (v === null) missing.push(w.key)
    else if (v !== w.value) mismatched.push(w.key)
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}

/** Execute the rollback (delete/zrem the seeded targets). Never touches legacy keys. */
export async function executeRollback(kv: PhaseKv, plan: ProvisionPlan): Promise<number> {
  let n = 0
  for (const u of plan.rollback) {
    if (u.op === 'del') await kv.del(u.key)
    else await kv.zrem(u.key, u.member)
    n++
  }
  return n
}
