// ── Tenant-aware data-access contract ────────────────────────────────────────
//
// The forward-compatible key-namespacing contract. It CAN prefix keys with
// `t:{tenantId}:` but, crucially, this sprint does NOT wire it into the live
// redis client (app/lib/redis.ts is untouched). It exists so later phases can
// flip prefixing on at one chokepoint without re-plumbing call sites.
//
// Backward-compatibility invariant (tested): with tenancy DISABLED, tenantKey()
// returns the key UNCHANGED — byte-identical to today. With tenancy ENABLED, it
// throws on a missing tenant id rather than silently falling back to a shared
// namespace (no fail-open on the security boundary).

import { isEnabled } from '../flags'
import { requireTenantKey } from './keys'
import { DEFAULT_TENANT_ID } from './types'

export function assertTenant(tenantId: string | undefined | null): asserts tenantId is string {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenant-store: tenant id is required when tenancy is enabled')
  }
}

/**
 * Namespace a Redis key for a tenant.
 * - tenancy off → returns `key` unchanged (current single-tenant behavior).
 * - tenancy on  → returns `t:{tenantId}:{key}`, throwing if tenantId is absent.
 */
export function tenantKey(
  tenantId: string | undefined | null,
  key: string,
  opts?: { enabled?: boolean },
): string {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return key
  assertTenant(tenantId)
  // Delegate prefix construction to the key API — the single source of truth
  // (enforced by scripts/bypass-detection.test.ts).
  return requireTenantKey(tenantId, key)
}

/**
 * Resolve which tenant a security-sensitive operation belongs to.
 * - tenancy off → the reference tenant (single-tenant continuity).
 * - tenancy on  → the explicit tenant id; NEVER a default. Returns null when it
 *   cannot be determined so callers fail closed instead of touching shared data.
 */
export function resolveTenantId(
  explicit: string | undefined | null,
  opts?: { enabled?: boolean },
): string | null {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return DEFAULT_TENANT_ID
  return explicit && typeof explicit === 'string' ? explicit : null
}
