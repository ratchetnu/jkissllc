// ── Public-token → tenant binding (Wave 6C) ──────────────────────────────────
//
// The problem. Every public token route (/booking/[token], /invoice/[token],
// /route/[token], …) is wrapped in `withTenantRoute`, which resolves the tenant from
// the SIGNED SESSION. A customer following a link from their email has no session, so
// with TENANCY_ENABLED=true `withTenantContextFromRequest` throws BEFORE the handler
// runs. `resolveTenantFromResource` — the intended mechanism — is imported by some of
// those handlers but is unreachable, because reading the record to learn its tenant
// itself requires a tenant. That circularity is the whole problem.
//
// The fix is an index that lives OUTSIDE tenant space. `platform:token:{token}` is on
// the platform-global allowlist, so it is readable with no tenant context; it maps an
// unguessable token to the tenant that owns it. The request then enters THAT tenant's
// context and reads the record normally, through the unchanged chokepoint.
//
// SECURITY PROPERTIES
//   • The binding is the ONLY thing read before a tenant is known, and it holds no
//     business data — a tenant id, a resource type and a resource id. No customer
//     name, address, price or booking detail is ever stored globally.
//   • The token is the capability. It is unguessable and is minted server-side; a
//     caller cannot enumerate bindings or ask for one by tenant.
//   • A caller-supplied tenantId is never consulted — `resolve()` takes only a token.
//   • An unknown token and a token belonging to another tenant are indistinguishable:
//     both return null, so the route 404s either way and existence never leaks.
//   • Re-binding an existing token to a DIFFERENT tenant is refused, not overwritten.
//     A token that could be re-pointed would be a cross-tenant handoff primitive.
//   • Revocation deletes the binding, so a revoked token stops resolving even though
//     the underlying record still exists in its tenant.
//
// `bk:` and friends stay tenant-owned. Nothing about this makes booking data global.

import { redis } from '../../redis'
import { platformKey, normalizeTenantId } from './keys'
import { recordTenantEvent } from '../observability/tenant-telemetry'

/** What kind of resource a public token points at. Recorded for auditing and so a
 *  route can refuse a token minted for a different surface. */
export type TokenResourceType =
  | 'booking'
  | 'route'
  | 'route-invoice'
  | 'client-portal'
  | 'quote'
  | 'acknowledgement'
  | 'pay-statement'

export type TokenBinding = {
  tenantId: string
  resourceType: TokenResourceType
  resourceId: string
  createdAt: number
}

/** Platform-global by construction — `platformKey` throws if the prefix is not on
 *  the allowlist, so this cannot silently become tenant-owned. */
function bindingKey(token: string): string {
  return platformKey(`platform:token:${token}`)
}

/** Tokens are opaque, unguessable, server-minted handles. Anything with structure a
 *  caller could influence (a path segment, an email, a display name) is rejected so a
 *  crafted "token" cannot become a lookup key. */
export function isValidPublicToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(token)
}

export class TokenBindingConflictError extends Error {
  readonly code = 'TOKEN_BINDING_CONFLICT'
  constructor() {
    // Generic on purpose: never name the tenant that already holds the token.
    super('token is already bound to a different tenant')
    this.name = 'TokenBindingConflictError'
  }
}

/**
 * Resolve a public token to its owning tenant. The ONE lookup permitted before a
 * tenant context exists. Returns null for an unknown, malformed or revoked token —
 * the caller must treat all three identically (404) so existence cannot be probed.
 */
export async function resolveTokenBinding(token: string): Promise<TokenBinding | null> {
  if (!isValidPublicToken(token)) return null
  let raw: string | null
  try {
    raw = await redis.get(bindingKey(token))
  } catch {
    return null // a store failure must not fall through to an unscoped read
  }
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as TokenBinding
    if (!b?.tenantId) return null
    return { ...b, tenantId: normalizeTenantId(b.tenantId) }
  } catch {
    return null
  }
}

/**
 * Bind a token to a tenant at ISSUE time. Idempotent for the same (token, tenant,
 * resource): re-binding identically is a no-op and returns the existing record.
 *
 * Re-binding the same token to a DIFFERENT tenant throws rather than overwriting.
 * Silently re-pointing a live token is how a customer link would start resolving into
 * someone else's data.
 */
export async function bindToken(
  token: string,
  binding: Omit<TokenBinding, 'createdAt'> & { createdAt?: number },
): Promise<TokenBinding> {
  if (!isValidPublicToken(token)) throw new Error('invalid public token')
  const tenantId = normalizeTenantId(binding.tenantId)

  const existing = await resolveTokenBinding(token)
  if (existing) {
    if (existing.tenantId !== tenantId) {
      recordTenantEvent('cross-tenant-denial', { detail: 'token rebind to a different tenant refused', keyFamily: 'platform:token' })
      throw new TokenBindingConflictError()
    }
    return existing // same tenant → idempotent
  }

  const record: TokenBinding = {
    tenantId,
    resourceType: binding.resourceType,
    resourceId: binding.resourceId,
    createdAt: binding.createdAt ?? Date.now(),
  }
  await redis.set(bindingKey(token), JSON.stringify(record))
  return record
}

/** Remove a binding — revocation, or cleanup when the underlying record is deleted.
 *  Idempotent: revoking an unknown token is a no-op, not an error. */
export async function revokeTokenBinding(token: string): Promise<void> {
  if (!isValidPublicToken(token)) return
  try { await redis.del(bindingKey(token)) } catch { /* best-effort */ }
}

/**
 * Rotate a token: bind the new one and revoke the old, in that order. If the new
 * bind fails the old token keeps working, which is the safe direction — a customer
 * with a live link is better than a customer with two dead ones.
 */
export async function rotateTokenBinding(
  oldToken: string,
  newToken: string,
  binding: Omit<TokenBinding, 'createdAt'>,
): Promise<TokenBinding> {
  const created = await bindToken(newToken, binding)
  await revokeTokenBinding(oldToken)
  return created
}
