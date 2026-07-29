// ── What a successful password check should produce (Wave 6) ─────────────────
//
// Kept PURE and separate from the login route so the decision — which is the entire
// security surface of multi-tenant login — is unit-testable without HTTP, Redis, or
// a password hash. The route does I/O; this decides.
//
// The rule the whole wave rests on: a session's tenant comes from a VALIDATED
// MEMBERSHIP, never from the request. There is no parameter here that carries a
// caller-supplied tenant id, which is why a forged one cannot be honoured — it is
// not merely rejected, it is never consulted.

import { DEFAULT_TENANT_ID, type Membership } from './types'
import { membershipId } from './membership'
import type { Role } from '../../rbac'

export type LoginResolution =
  /** Exactly one active membership — issue a full session for it, no prompt. */
  | { kind: 'single'; membership: Membership }
  /** More than one — the user must choose. Never pick for them. */
  | { kind: 'select'; choices: Membership[] }
  /** Authenticated, but belongs to nothing. A controlled state, not a crash. */
  | { kind: 'no-membership' }

/** The account being logged in, for the single-tenant compatibility path. */
export type LoginUser = { id: string; role: Role; staffId?: string }

export type ResolveLoginOpts = {
  /** Live TENANCY_ENABLED. Governs whether the compatibility path may be taken. */
  tenancyEnabled: boolean
}

/**
 * Decide from the user's ACTIVE memberships.
 *
 * Deliberately NOT auto-selecting when there are several: picking "the first" would
 * make the tenant a function of insertion order, and a user who is admin in one
 * tenant and crew in another would silently land in whichever the store happened to
 * return first. Ambiguity must surface, not resolve itself.
 *
 * SINGLE-TENANT COMPATIBILITY — the reason this takes `user` and a flag. Every
 * account that exists today predates memberships and has none persisted. Requiring
 * one unconditionally would lock every existing user (including the only Production
 * administrator) out the moment this deploys. So while TENANCY_ENABLED=false, a user
 * with no memberships resolves to a synthetic ACTIVE membership in the reference
 * tenant carrying THEIR OWN role and staffId — byte-identical to today's behaviour.
 *
 * The synthesized role is the user's, never a hardcoded 'admin': inventing an admin
 * membership for a crew account would be a privilege escalation dressed as a
 * compatibility shim.
 *
 * When tenancy IS enabled the shim is gone and a real persisted membership is
 * mandatory — no membership means no session (fail closed).
 */
export function resolveLogin(
  activeMemberships: Membership[],
  user: LoginUser,
  opts: ResolveLoginOpts,
): LoginResolution {
  const active = activeMemberships.filter((m) => m.status === 'active')

  if (active.length === 0) {
    if (opts.tenancyEnabled) return { kind: 'no-membership' }
    return { kind: 'single', membership: syntheticReferenceMembership(user) }
  }
  if (active.length === 1) return { kind: 'single', membership: active[0] }
  return { kind: 'select', choices: active }
}

/** The compatibility membership: reference tenant, the user's own role/staff link. */
export function syntheticReferenceMembership(user: LoginUser): Membership {
  return {
    id: membershipId(DEFAULT_TENANT_ID, user.id),
    tenantId: DEFAULT_TENANT_ID,
    userId: user.id,
    role: user.role,
    status: 'active',
    staffId: user.staffId,
    createdAt: 0,
  }
}

/**
 * The tenant list safe to hand a client during selection. Only the user's OWN
 * memberships, and only the fields the picker needs — no membership id, no user id,
 * nothing about tenants they don't belong to. A tenant the user is not a member of
 * cannot appear here because the input IS their own membership set.
 */
export type TenantChoice = { tenantId: string; role: Role }

export function toTenantChoices(memberships: Membership[]): TenantChoice[] {
  return memberships
    .filter((m) => m.status === 'active')
    .map((m) => ({ tenantId: m.tenantId, role: m.role }))
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
}
