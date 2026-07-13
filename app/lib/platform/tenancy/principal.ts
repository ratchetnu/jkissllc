// ── Tenant principal builder ─────────────────────────────────────────────────
//
// Turns the existing session Principal (sub/role/staffId) into the richer
// TenantPrincipal (adds tenant, materialized permissions, provenance). Pure — no
// Redis, no async_hooks — so it is safe to import from the session layer (which
// runs on the Edge runtime) and from tests.

import { permissionsForRole } from '../../rbac'
import { DEFAULT_TENANT_ID, type TenantPrincipal, type AuthSource } from './types'

// Minimal shape we need from the session Principal. Kept structural (not a direct
// import) so this module has ZERO dependency on the session module and cannot
// create an import cycle.
export type BasePrincipal = {
  sub: string
  role: TenantPrincipal['role']
  staffId?: string
}

export function buildTenantPrincipal(
  base: BasePrincipal,
  opts?: { tenantId?: string; membershipId?: string; authSource?: AuthSource; sessionId?: string },
): TenantPrincipal {
  return {
    sub: base.sub,
    tenantId: opts?.tenantId ?? DEFAULT_TENANT_ID,
    membershipId: opts?.membershipId,
    role: base.role,
    permissions: permissionsForRole(base.role),
    authSource: opts?.authSource ?? (base.sub === 'owner' ? 'legacy-admin' : 'password'),
    staffId: base.staffId,
    sessionId: opts?.sessionId,
  }
}

/** Two principals are same-tenant. The building block of cross-tenant denial. */
export function isSameTenant(a: { tenantId: string }, b: { tenantId: string }): boolean {
  return !!a.tenantId && a.tenantId === b.tenantId
}
