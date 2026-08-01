import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID, type Tenant } from './types'
import { listTenants } from './tenant-registry'
import {
  TENANT_ROSTER_TTL_MS, tenantRosterCache, setTenantRosterCache,
} from './tenant-roster-cache'

/** Canonical US/provider phone identity. Twilio sends E.164; display formatting is never identity. */
export function canonicalPhoneChannel(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return ''
}
const email = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase()
const host = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase().split(':')[0]

async function uniqueActive(match: (tenant: Tenant) => boolean): Promise<string | null> {
  if (!isEnabled('TENANCY_ENABLED')) return DEFAULT_TENANT_ID
  const now = Date.now()
  if (!tenantRosterCache || tenantRosterCache.expiresAt <= now) {
    setTenantRosterCache({ tenants: await listTenants(), expiresAt: now + TENANT_ROSTER_TTL_MS })
  }
  const matches = tenantRosterCache!.tenants.filter((tenant) => tenant.status === 'active' && match(tenant))
  return matches.length === 1 ? matches[0].id : null
}

/** Resolve a signed provider callback by the tenant-owned sending/receiving number. */
export function resolveTenantFromPhoneChannel(
  input: string | null | undefined | { phone?: string | null; messagingServiceSid?: string | null },
): Promise<string | null> {
  const phone = typeof input === 'object' && input !== null ? input.phone : input
  const serviceSid = typeof input === 'object' && input !== null ? (input.messagingServiceSid ?? '').trim() : ''
  const wanted = canonicalPhoneChannel(phone)
  if (!wanted && !serviceSid) return Promise.resolve(isEnabled('TENANCY_ENABLED') ? null : DEFAULT_TENANT_ID)
  return uniqueActive((tenant) => {
    const numbers = [...(tenant.channels?.smsE164 ?? []), tenant.legal.phone]
    const numberMatch = !!wanted && numbers.some((candidate) => canonicalPhoneChannel(candidate) === wanted)
    const serviceMatch = !!serviceSid && (tenant.channels?.twilioMessagingServiceSids ?? []).includes(serviceSid)
    return numberMatch || serviceMatch
  })
}

/** Resolve a verified inbound-email callback by its tenant-owned recipient. */
export function resolveTenantFromEmailChannel(value: string | null | undefined): Promise<string | null> {
  const wanted = email(value).replace(/^.*<([^>]+)>.*$/, '$1')
  if (!wanted) return Promise.resolve(isEnabled('TENANCY_ENABLED') ? null : DEFAULT_TENANT_ID)
  return uniqueActive((tenant) => [
    ...(tenant.channels?.inboundEmails ?? []), tenant.legal.supportEmail, tenant.brand.emailFromAddress,
  ].some((candidate) => email(candidate) === wanted))
}

/** Resolve a session-less public request through the persisted tenant domain roster. */
export function resolveTenantFromHostChannel(value: string | null | undefined): Promise<string | null> {
  const wanted = host(value)
  if (!wanted) return Promise.resolve(isEnabled('TENANCY_ENABLED') ? null : DEFAULT_TENANT_ID)
  return uniqueActive((tenant) => (tenant.domains ?? []).some((candidate) => host(candidate) === wanted))
}
