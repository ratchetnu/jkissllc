import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID, type Tenant } from './types'
import { listTenants } from './tenant-registry'

const digits = (value: string | null | undefined): string => (value ?? '').replace(/\D/g, '')
const email = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase()
const host = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase().split(':')[0]

async function uniqueActive(match: (tenant: Tenant) => boolean): Promise<string | null> {
  if (!isEnabled('TENANCY_ENABLED')) return DEFAULT_TENANT_ID
  const matches = (await listTenants()).filter((tenant) => tenant.status === 'active' && match(tenant))
  return matches.length === 1 ? matches[0].id : null
}

/** Resolve a signed provider callback by the tenant-owned sending/receiving number. */
export function resolveTenantFromPhoneChannel(value: string | null | undefined): Promise<string | null> {
  const wanted = digits(value)
  if (!wanted) return Promise.resolve(isEnabled('TENANCY_ENABLED') ? null : DEFAULT_TENANT_ID)
  return uniqueActive((tenant) => digits(tenant.legal.phone) === wanted)
}

/** Resolve a verified inbound-email callback by its tenant-owned recipient. */
export function resolveTenantFromEmailChannel(value: string | null | undefined): Promise<string | null> {
  const wanted = email(value).replace(/^.*<([^>]+)>.*$/, '$1')
  if (!wanted) return Promise.resolve(isEnabled('TENANCY_ENABLED') ? null : DEFAULT_TENANT_ID)
  return uniqueActive((tenant) => [tenant.legal.supportEmail, tenant.brand.emailFromAddress].some((candidate) => email(candidate) === wanted))
}

/** Resolve a session-less public request through the persisted tenant domain roster. */
export function resolveTenantFromHostChannel(value: string | null | undefined): Promise<string | null> {
  const wanted = host(value)
  if (!wanted) return Promise.resolve(isEnabled('TENANCY_ENABLED') ? null : DEFAULT_TENANT_ID)
  return uniqueActive((tenant) => [tenant.slug, ...(tenant.domains ?? [])].some((candidate) => host(candidate) === wanted))
}
