import { isEnabled } from '../flags'

type Env = Record<string, string | undefined>
export type TenancyOperatingProfile = 'single_tenant' | 'shadow_validation' | 'migration' | 'tenant_reads' | 'tenant_dual_write'

export type TenancyProfile = {
  profile: TenancyOperatingProfile
  valid: boolean
  detail: string
}

/** One truthful name for the three tenancy flags; invalid combinations are explicit. */
export function tenancyOperatingProfile(
  env: Env = process.env,
  context: { activeTenantCount?: number } = {},
): TenancyProfile {
  const enabled = isEnabled('TENANCY_ENABLED', env)
  const dark = isEnabled('TENANCY_DARK_LAUNCH', env)
  const dual = isEnabled('TENANCY_DUAL_WRITE', env)

  if (!enabled && !dark && !dual) return { profile: 'single_tenant', valid: true, detail: 'Single-tenant compatibility mode' }
  if (!enabled && dark && !dual) return { profile: 'shadow_validation', valid: true, detail: 'Legacy reads with tenant-copy comparison' }
  if (!enabled && dual) return { profile: 'migration', valid: dark, detail: dark ? 'Legacy reads with dual writes and copy comparison' : 'Dual writes require dark-launch comparison' }
  if (enabled && !dual) return { profile: 'tenant_reads', valid: !dark, detail: dark ? 'Dark launch is redundant after tenant reads are authoritative' : 'Tenant-scoped reads and writes are authoritative' }
  if (dark) return { profile: 'tenant_dual_write', valid: false, detail: 'Dark launch is redundant after tenant reads are authoritative' }
  if (context.activeTenantCount !== 1) {
    return {
      profile: 'tenant_dual_write', valid: false,
      detail: context.activeTenantCount === undefined
        ? 'Dual-write safety requires proof that exactly one tenant is active'
        : `Legacy dual writes are unsafe with ${context.activeTenantCount} active tenants`,
    }
  }
  return { profile: 'tenant_dual_write', valid: true, detail: 'Tenant reads authoritative; one-tenant legacy rollback copy retained' }
}
