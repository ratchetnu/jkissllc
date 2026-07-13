// ── Capability query interfaces ──────────────────────────────────────────────
//
// The read side: tenant enablement, role visibility, and AI-tool eligibility.
// All queries respect CAPABILITY_REGISTRY_ENABLED — when it is off, the registry
// reports nothing (a hard off-switch), so it can never leak into a live decision
// path unexpectedly.

import type { Role } from '../../rbac'
import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID } from '../tenancy/types'
import type { Tenant } from '../tenancy/types'
import type { Capability, CapabilityId } from './types'
import { allCapabilities, getCapability } from './registry'

export * from './types'
export { CAPABILITY_REGISTRY, allCapabilities, getCapability } from './registry'
export { validateCapabilityRegistry, assertValidCapabilityRegistry } from './validate'

function active(): boolean {
  return isEnabled('CAPABILITY_REGISTRY_ENABLED')
}

/** Capabilities a role may access (supportedRoles includes the role). */
export function capabilitiesForRole(role: Role): Capability[] {
  if (!active()) return []
  return allCapabilities().filter((c) => c.supportedRoles.includes(role))
}

/**
 * Whether a capability is enabled for a tenant. This sprint the only tenant is
 * `jkiss`, whose enablement is the registry's `enabledForJkiss` flag; other
 * tenants default to disabled until per-tenant config exists (a later phase).
 */
export function isCapabilityEnabledForTenant(id: CapabilityId, tenant: Pick<Tenant, 'id'>): boolean {
  if (!active()) return false
  const c = getCapability(id)
  if (tenant.id === DEFAULT_TENANT_ID) return c.enabledForJkiss
  return false
}

/** Capabilities that expose at least one AI action (for tool eligibility). */
export function aiEligibleCapabilities(): Capability[] {
  if (!active()) return []
  return allCapabilities().filter((c) => c.aiActions.length > 0)
}

/** The AI action ids a capability supports (empty when the registry is off). */
export function aiActionsForCapability(id: CapabilityId): { id: string; level: number }[] {
  if (!active()) return []
  return getCapability(id).aiActions.map((a) => ({ id: a.id, level: a.level }))
}
