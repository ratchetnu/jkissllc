// ── Tenant-aware Redis key API ───────────────────────────────────────────────
//
// The ONE place tenant-owned Redis keys are namespaced. No scattered string
// concatenation of `t:${id}:` anywhere else (enforced by
// scripts/bypass-detection.test.ts). Security rules:
//   • Tenant boundary is an OPAQUE, normalized id — never a display name.
//   • Platform-global keys are an explicit ALLOWLIST; everything else is
//     tenant-owned and is prefixed when tenancy is on.
//   • No silent fallback to global access: a tenant-owned key with no tenant
//     context throws (fail closed) when tenancy is enabled.
//   • Compatibility: while TENANCY_ENABLED=false, keys are returned UNCHANGED
//     (byte-identical to today).

import { isEnabled } from '../flags'
import { currentTenantId } from './context'

/** Platform-global key prefixes that must NEVER be tenant-prefixed. */
export const PLATFORM_GLOBAL_PREFIXES = [
  'opspilot:', // early-access waitlist (platform, not a tenant)
  'platform:', // tenant records + platform billing/analytics (future)
  'ai:',       // AI telemetry/cost/prompts — platform-managed; cost already embeds the tenant
  'rl:',       // rate limits — pre-auth, per-IP infrastructure
] as const

const TENANT_PREFIX_RE = /^t:[a-z0-9][a-z0-9-]{0,63}:/
const VALID_TENANT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Normalize + validate a tenant id into a safe key segment. Rejects anything
 * that isn't already an opaque id — so a display name ("J Kiss LLC", an email,
 * a route label) can never become a security boundary.
 */
export function normalizeTenantId(id: string | undefined | null): string {
  if (typeof id !== 'string') throw new Error('tenant id must be a string')
  const norm = id.trim().toLowerCase()
  if (!VALID_TENANT_ID.test(norm)) {
    throw new Error('invalid tenant id: must be an opaque slug [a-z0-9-], not a display name')
  }
  return norm
}

/** True when a key belongs to the platform-global allowlist (never prefixed). */
export function isPlatformGlobal(key: string): boolean {
  return PLATFORM_GLOBAL_PREFIXES.some((p) => key.startsWith(p))
}

/** True when a key is already tenant-scoped (idempotency guard). */
export function isTenantScoped(key: string): boolean {
  return TENANT_PREFIX_RE.test(key)
}

export type ScopeOpts = { enabled?: boolean; tenantId?: string }

/**
 * The core transform. Returns:
 *  - the key UNCHANGED when tenancy is off (compat) or the key is platform-global
 *    or already scoped;
 *  - `t:{tenantId}:{key}` when tenancy is on and a tenant is resolvable;
 *  - THROWS when tenancy is on, the key is tenant-owned, and no tenant context
 *    is available (fail closed — never a silent global write).
 */
export function scopeKey(key: string, opts?: ScopeOpts): string {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return key
  if (isPlatformGlobal(key) || isTenantScoped(key)) return key
  const tid = opts?.tenantId ?? currentTenantId()
  if (!tid) {
    throw new Error(`tenant context required for tenant-owned key family "${keyFamily(key)}:*"`)
  }
  return `t:${normalizeTenantId(tid)}:${key}`
}

/** Explicit tenant key builder (throws on missing tenant even when flag is off). */
export function requireTenantKey(tenantId: string, key: string): string {
  if (isPlatformGlobal(key)) throw new Error(`"${keyFamily(key)}" is a platform-global key, not tenant-owned`)
  if (isTenantScoped(key)) return key
  return `t:${normalizeTenantId(tenantId)}:${key}`
}

/** Build a platform-global key, asserting it is on the allowlist. */
export function platformKey(key: string): string {
  if (!isPlatformGlobal(key)) throw new Error(`"${keyFamily(key)}" is not a platform-global key`)
  return key
}

/** The un-prefixed (legacy) form of a key — the physical key used today. */
export function legacyKey(key: string): string {
  return isTenantScoped(key) ? key.replace(TENANT_PREFIX_RE, '') : key
}

/** The key family (first segment) — safe to log; never the full key or value. */
export function keyFamily(key: string): string {
  const scoped = key.replace(TENANT_PREFIX_RE, '')
  return scoped.split(':')[0] ?? scoped
}

/**
 * Dark-launch helper: the (legacy, tenant) key pair for a given logical key, so
 * a shadow read can compare them. Returns null for platform-global keys (no
 * tenant copy exists) and when no tenant is resolvable.
 */
export function compareLegacyAndTenantKey(
  key: string,
  opts?: { tenantId?: string },
): { legacy: string; tenant: string } | null {
  const base = legacyKey(key)
  if (isPlatformGlobal(base)) return null
  const tid = opts?.tenantId ?? currentTenantId()
  if (!tid) return null
  return { legacy: base, tenant: `t:${normalizeTenantId(tid)}:${base}` }
}
