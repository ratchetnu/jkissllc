// ── Membership store + server-side membership validation ─────────────────────
//
// The security core of Phase 1. A `Membership` (typed in types.ts) is a user's
// belonging to a tenant with a role. This module PERSISTS memberships and, more
// importantly, exposes the ONE authority that decides whether a caller may act as
// a given tenant: `assertMembership` / `resolveMembership`.
//
// TRUST RULE — a tenant id supplied by (or influenced by) the client is NEVER
// trusted on its own. It is only honored after this module confirms, server-side,
// that the authenticated user holds an ACTIVE membership in that tenant. There is
// no fail-open path.
//
// COMPATIBILITY — while TENANCY_ENABLED=false the deployment is single-tenant, so
// resolution returns a synthetic active membership for the REFERENCE tenant ONLY
// (byte-identical to today, no persisted state required) and DENIES any other
// requested tenant id. When enabled, a real persisted active membership is
// required; anything else fails closed.
//
// Storage — the PLATFORM-GLOBAL keyspace (never tenant-prefixed): memberships are
// platform roster data, asserted via platformKey(). No cross-tenant identifier is
// ever placed in an error message or telemetry value (only key families are logged).

import { redis } from '../../redis'
import { isEnabled } from '../flags'
import { isRole, type Role } from '../../rbac'
import { platformKey, normalizeTenantId } from './keys'
import { recordTenantEvent } from '../observability/tenant-telemetry'
import { DEFAULT_TENANT_ID, type Membership, type MembershipStatus } from './types'

/** Raised when a caller may not act as the requested tenant. Message is generic —
 *  it never embeds another tenant's id or a foreign user id (no leakage). */
export class TenantAccessDeniedError extends Error {
  readonly code = 'TENANT_ACCESS_DENIED'
  constructor(message = 'tenant access denied') {
    super(message)
    this.name = 'TenantAccessDeniedError'
  }
}

// ── Key builders (all platform-global) ───────────────────────────────────────
function recordKey(tenantId: string, userId: string): string {
  return platformKey(`platform:membership:${normalizeTenantId(tenantId)}:${normalizeUserId(userId)}`)
}
function byUserKey(userId: string): string {
  return platformKey(`platform:membership:byuser:${normalizeUserId(userId)}`)
}
function byTenantKey(tenantId: string): string {
  return platformKey(`platform:membership:bytenant:${normalizeTenantId(tenantId)}`)
}

/** A user id is an opaque handle; keep it to a safe, bounded key segment. */
function normalizeUserId(id: string): string {
  if (typeof id !== 'string') throw new Error('user id must be a string')
  const norm = id.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(norm)) {
    throw new Error('invalid user id')
  }
  return norm
}

/** Deterministic membership id for a (tenant, user) pair — so seeds are stable and
 *  re-provisioning is idempotent (no random component). */
export function membershipId(tenantId: string, userId: string): string {
  return `mbr_${normalizeTenantId(tenantId)}_${normalizeUserId(userId)}`
}

// ── Reads ────────────────────────────────────────────────────────────────────
export async function getMembership(userId: string, tenantId: string): Promise<Membership | null> {
  let key: string
  try {
    key = recordKey(tenantId, userId)
  } catch {
    return null
  }
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Membership
  } catch {
    return null
  }
}

export async function listTenantIdsForUser(userId: string): Promise<string[]> {
  try {
    return await redis.zrange(byUserKey(userId), 0, -1)
  } catch {
    return []
  }
}

export async function listUserIdsForTenant(tenantId: string): Promise<string[]> {
  try {
    return await redis.zrange(byTenantKey(tenantId), 0, -1)
  } catch {
    return []
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────
export type MembershipInput = {
  tenantId: string
  userId: string
  role: Role
  status?: MembershipStatus
  createdAt?: number
}

/**
 * Create or update a membership. Ids are validated as opaque slugs. Writes the
 * record plus both indexes (by-user, by-tenant). Idempotent for a fixed input.
 */
export async function upsertMembership(input: MembershipInput): Promise<Membership> {
  const tenantId = normalizeTenantId(input.tenantId)
  const userId = normalizeUserId(input.userId)
  if (!isRole(input.role)) throw new Error('invalid role')
  const membership: Membership = {
    id: membershipId(tenantId, userId),
    tenantId,
    userId,
    role: input.role,
    status: input.status ?? 'active',
    createdAt: input.createdAt ?? 0,
  }
  await redis.set(recordKey(tenantId, userId), JSON.stringify(membership))
  await redis.zadd(byUserKey(userId), membership.createdAt, tenantId)
  await redis.zadd(byTenantKey(tenantId), membership.createdAt, userId)
  return membership
}

/** Remove a membership and both index entries. Used by rollback tooling. */
export async function removeMembership(userId: string, tenantId: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  const uid = normalizeUserId(userId)
  await redis.del(recordKey(tid, uid))
  await redis.zrem(byUserKey(uid), tid)
  await redis.zrem(byTenantKey(tid), uid)
}

/**
 * Idempotently seed the reference membership: the legacy shared-password admin
 * (`owner`, role `admin`) as an ACTIVE member of the reference tenant. Returns the
 * existing record unchanged if present. This is what lets an authenticated legacy
 * admin resolve to J KISS once tenancy is enabled — the single-tenant compat map.
 */
export async function ensureReferenceMembership(): Promise<Membership> {
  const existing = await getMembership('owner', DEFAULT_TENANT_ID)
  if (existing) return existing
  return upsertMembership({ tenantId: DEFAULT_TENANT_ID, userId: 'owner', role: 'admin', status: 'active', createdAt: 0 })
}

// ── The authority: server-side membership validation ─────────────────────────
export type ResolveOpts = { enabled?: boolean; correlationId?: string }

/**
 * Decide whether `userId` may act as `requestedTenantId`, returning the active
 * membership or null. NEVER trusts the requested id on its own:
 *   • tenancy OFF  → single-tenant. The reference tenant (or an absent request →
 *                    reference) resolves to a synthetic active admin membership;
 *                    ANY other requested id is denied (a client cannot conjure a
 *                    second tenant). No persisted state needed → byte-identical.
 *   • tenancy ON   → a persisted, ACTIVE membership is required. No match, a
 *                    non-active status, or a malformed id → null (fail closed).
 */
export async function resolveMembership(
  userId: string,
  requestedTenantId: string | undefined | null,
  opts?: ResolveOpts,
): Promise<Membership | null> {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')

  let uid: string
  let requested: string | null
  try {
    uid = normalizeUserId(userId)
    requested = requestedTenantId == null || requestedTenantId === '' ? null : normalizeTenantId(requestedTenantId)
  } catch {
    // A malformed user id or a name-derived tenant id is never authoritative.
    recordTenantEvent('missing-tenant-context', { detail: 'membership resolution: malformed id', correlationId: opts?.correlationId })
    return null
  }

  if (!enabled) {
    // Single-tenant continuity: only the reference tenant exists.
    const target = requested ?? DEFAULT_TENANT_ID
    if (target !== DEFAULT_TENANT_ID) {
      recordTenantEvent('cross-tenant-denial', { detail: 'foreign tenant requested while single-tenant', correlationId: opts?.correlationId })
      return null
    }
    return {
      id: membershipId(DEFAULT_TENANT_ID, uid),
      tenantId: DEFAULT_TENANT_ID,
      userId: uid,
      role: 'admin',
      status: 'active',
      createdAt: 0,
    }
  }

  // Tenancy ON — a real, active membership is mandatory.
  if (!requested) {
    recordTenantEvent('missing-tenant-context', { detail: 'membership resolution without a requested tenant', correlationId: opts?.correlationId })
    return null
  }
  const membership = await getMembership(uid, requested)
  if (!membership || membership.status !== 'active') {
    recordTenantEvent('cross-tenant-denial', { detail: 'no active membership for requested tenant', correlationId: opts?.correlationId })
    return null
  }
  return membership
}

/**
 * Like resolveMembership but THROWS `TenantAccessDeniedError` on denial — the guard
 * a tenant-safe repository calls before honoring a tenant id. The error message is
 * intentionally generic so no cross-tenant identifier is exposed to the caller.
 */
export async function assertMembership(
  userId: string,
  requestedTenantId: string | undefined | null,
  opts?: ResolveOpts,
): Promise<Membership> {
  const membership = await resolveMembership(userId, requestedTenantId, opts)
  if (!membership) throw new TenantAccessDeniedError()
  return membership
}
