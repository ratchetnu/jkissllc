// ── Tenancy domain types ─────────────────────────────────────────────────────
//
// The models that make OpsPilot multi-tenant. NONE of this is wired into a live
// data path in this sprint — it is the typed foundation the later phases build on
// (see docs/opspilot-os/platform-foundation/04-tenancy-foundation.md).
//
// Security rule: a tenant boundary is an OPAQUE id, never a display name. `jkiss`
// is the reference tenant's stable id; its human name lives in `displayName`.

import type { Permission, Role } from '../../rbac'

/** The reference tenant (J KISS LLC). Stable, opaque, non-name-derived. */
export const DEFAULT_TENANT_ID = 'jkiss'

export type TenantStatus = 'active' | 'suspended' | 'trialing'

export type Tenant = {
  id: string // opaque short id — the future Redis prefix `t:{id}:`
  slug: string // subdomain / vanity
  displayName: string
  legal: {
    dotNumber?: string
    mcNumber?: string
    addressOneLine?: string
    phone?: string
    supportEmail?: string
  }
  brand: {
    primaryColor?: string
    logoUrl?: string
    emailFromAddress?: string
  }
  industryPackId?: string
  status: TenantStatus
  createdAt: number
}

export type MembershipStatus = 'active' | 'invited' | 'suspended'

/** A User's belonging to a Tenant with a Role. The unit RBAC will scope on. */
export type Membership = {
  id: string
  tenantId: string
  userId: string
  role: Role
  status: MembershipStatus
  createdAt: number
}

/** How the caller authenticated — recorded for audit + future policy decisions. */
export type AuthSource = 'password' | 'legacy-admin' | 'system'

/**
 * The tenant-aware principal. Superset of the existing session Principal: it adds
 * the tenant boundary, the materialized permission set, and provenance. Every
 * future authorization decision resolves through THIS, never a bare role string.
 */
export type TenantPrincipal = {
  sub: string // user id ('owner' for the legacy shared-password admin)
  tenantId: string
  membershipId?: string
  role: Role
  permissions: Permission[]
  authSource: AuthSource
  staffId?: string // crew principals only
  sessionId?: string
}
