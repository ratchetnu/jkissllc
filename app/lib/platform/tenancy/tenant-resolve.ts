// ── Canonical tenant resolution for session-less contexts ────────────────────
//
// `request-context.ts` resolves the tenant from a signed SESSION. This module is
// the counterpart for contexts that have no session: public customer-token
// routes, verified webhooks, and host/domain mapping. It is the ONE place that
// logic lives, so no route hand-rolls its own tenant guess.
//
// TRUST MODEL (highest authority first) — a tenant is only ever resolved from a
// TRUSTED source; an arbitrary client-supplied id or query param is NEVER
// authority:
//   internal-context     server-set AsyncLocalStorage tenant (already trusted)
//   membership           authenticated org membership (the signed session)
//   webhook-metadata     metadata read AFTER signature verification
//   resource-binding     a signed customer token → a stored record's own tenantId
//   host-mapping         a verified custom-domain / host → tenant map
//   single-tenant-fallback  the reference tenant, ONLY while TENANCY_ENABLED=false
//
// Behavior: while TENANCY_ENABLED=false every resolver returns the reference
// tenant (J KISS continuity). When enabled, an unresolved/ambiguous tenant
// returns null so the caller FAILS CLOSED — never a silent shared-data access.

import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID } from './types'
import { normalizeTenantId } from './keys'
import { currentTenantId } from './context'
import { recordTenantEvent } from '../observability/tenant-telemetry'

export type ResolutionMethod =
  | 'internal-context'
  | 'membership'
  | 'webhook-metadata'
  | 'resource-binding'
  | 'host-mapping'
  | 'single-tenant-fallback'

export type Resolution = { tenantId: string; method: ResolutionMethod } | null

/**
 * Hosts that map to the reference tenant. A real multi-tenant registry replaces
 * this with a verified domain→tenant lookup; today it is the single J KISS domain
 * (+ its www and the platform vercel host).
 */
const REFERENCE_TENANT_HOSTS = new Set<string>([
  'jkissllc.com',
  'www.jkissllc.com',
  'jkissllc.vercel.app',
])

function fallback(): Resolution {
  return { tenantId: DEFAULT_TENANT_ID, method: 'single-tenant-fallback' }
}

/**
 * Resolve from a stored resource that carries its owner's tenantId — the trusted
 * mechanism for public customer-token routes (booking/invoice/quote). The token
 * itself is unguessable and looks up ONE record; that record's `tenantId` is the
 * authority, so a customer can never point a valid token at another tenant.
 */
export function resolveTenantFromResource(
  record: { tenantId?: string | null } | null | undefined,
  opts?: { enabled?: boolean; correlationId?: string; kind?: string },
): Resolution {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return fallback()
  const tid = record?.tenantId
  if (!tid) {
    recordTenantEvent('missing-tenant-context', {
      detail: `resource${opts?.kind ? ` (${opts.kind})` : ''} has no tenant binding`,
      correlationId: opts?.correlationId,
    })
    return null
  }
  return { tenantId: normalizeTenantId(tid), method: 'resource-binding' }
}

/**
 * Resolve from a request Host header via a verified domain map. An unknown host
 * (e.g. a bare Vercel preview URL) cannot be authoritatively attributed → returns
 * null so the caller fails closed when tenancy is on.
 */
export function resolveTenantFromHost(
  host: string | null | undefined,
  opts?: { enabled?: boolean },
): Resolution {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return fallback()
  const h = (host ?? '').toLowerCase().split(':')[0].trim()
  if (REFERENCE_TENANT_HOSTS.has(h)) return { tenantId: DEFAULT_TENANT_ID, method: 'host-mapping' }
  return null
}

/**
 * Resolve from Stripe metadata — call ONLY after `constructEvent` has verified the
 * webhook signature. The `tenantId` is the value stamped into session/paymentIntent
 * metadata at creation (see tenantIdForOutboundMetadata).
 */
export function resolveTenantFromStripe(
  meta: { tenantId?: string | null } | null | undefined,
  opts?: { enabled?: boolean; correlationId?: string },
): Resolution {
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return fallback()
  const tid = meta?.tenantId
  if (!tid) {
    recordTenantEvent('missing-tenant-context', {
      detail: 'stripe event without tenant metadata',
      correlationId: opts?.correlationId,
    })
    return null
  }
  return { tenantId: normalizeTenantId(tid), method: 'webhook-metadata' }
}

/**
 * The tenant id to stamp into OUTBOUND third-party metadata (Stripe session/intent)
 * at creation time, so the later webhook can resolve it. Reads the current server
 * context; falls back to the reference tenant while tenancy is off.
 */
export function tenantIdForOutboundMetadata(): string {
  return currentTenantId() ?? DEFAULT_TENANT_ID
}
