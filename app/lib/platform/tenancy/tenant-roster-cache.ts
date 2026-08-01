import type { Tenant } from './types'

export const TENANT_ROSTER_TTL_MS = 5_000
export let tenantRosterCache: { expiresAt: number; tenants: Tenant[] } | null = null

export function setTenantRosterCache(value: { expiresAt: number; tenants: Tenant[] }): void {
  tenantRosterCache = value
}

export function invalidateTenantRosterCache(): void {
  tenantRosterCache = null
}
