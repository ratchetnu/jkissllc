// ── Capability query interfaces ──────────────────────────────────────────────
//
// The read side: tenant enablement, role visibility, and AI-tool eligibility.
//
// ── What CAPABILITY_REGISTRY_ENABLED does, and what it must NOT do ───────────
//
// The flag gates the DESCRIPTIVE surfaces — role visibility and AI-tool
// eligibility — which are catalog queries with no safety role. It deliberately
// does NOT gate the enforcement path (`guard.ts`): a kill switch that turns a
// security check into a no-op is not a kill switch, it is a bypass. Enforcement
// resolves from the tenant profile directly and fails closed.

import type { Role } from '../../rbac'
import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID } from '../tenancy/types'
import type { Tenant } from '../tenancy/types'
import type { Capability, CapabilityId } from './types'
import { allCapabilities, getCapability } from './registry'
import { resolveSelection } from './tenant-profile'

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
 * The registry DEFAULT enablement for a tenant — synchronous, store-free, and the
 * same answer for every tenant. It is the seed the profile overrides, not the
 * authority: for the real answer (which reads the tenant's stored profile) use
 * `resolveTenantCapabilities` in tenant-profile-store.ts, and to ENFORCE it use
 * `requireCapability` in guard.ts.
 *
 * This used to special-case `jkiss` and return false for every other tenant, which
 * meant a second business could not be configured at all. The reference tenant's
 * answer is unchanged: it has no stored overrides, so it still resolves to exactly
 * these defaults.
 */
export function isCapabilityEnabledByDefault(
  id: CapabilityId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!active()) return false
  return resolveSelection(getCapability(id), undefined, env).selection === 'enabled'
}

/**
 * @deprecated Kept so existing callers keep compiling. Tenant-independent by
 * construction — it answers the registry default, not what a tenant chose.
 */
export function isCapabilityEnabledForTenant(id: CapabilityId, _tenant: Pick<Tenant, 'id'>): boolean {
  void _tenant
  return isCapabilityEnabledByDefault(id)
}

export { DEFAULT_TENANT_ID }

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
