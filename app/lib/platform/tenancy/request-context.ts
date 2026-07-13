// ── Establishing tenant context at entry points ──────────────────────────────
//
// Resolves the tenant from the AUTHORITATIVE source (the signed session, never a
// header) and runs the work inside a per-handler AsyncLocalStorage scope. Fails
// closed when tenancy is on and no tenant can be resolved — never a silent
// fallback to shared/global access.
//
// While TENANCY_ENABLED=false every resolver returns the reference tenant and the
// key chokepoint no-ops, so wrapping a handler changes NOTHING today.

import type { NextRequest } from 'next/server'
import { getPrincipal } from '../../../api/admin/_lib/session'
import { isEnabled } from '../flags'
import { runWithTenant } from './context'
import { buildTenantPrincipal } from './principal'
import { normalizeTenantId } from './keys'
import { DEFAULT_TENANT_ID } from './types'
import { recordTenantEvent } from '../observability/tenant-telemetry'

/** Run `fn` in the tenant context resolved from the request's signed session. */
export async function withTenantContextFromRequest<T>(req: NextRequest, fn: () => Promise<T>): Promise<T> {
  const who = await getPrincipal(req) // reads the signed cookie ONLY — ignores any x-tenant-id header
  const tid = who?.tenantId ?? null
  if (isEnabled('TENANCY_ENABLED') && !tid) {
    recordTenantEvent('missing-tenant-context', { detail: 'authenticated request without a resolvable tenant' })
    throw new Error('tenant context required')
  }
  const tenantId = tid ?? DEFAULT_TENANT_ID
  const principal = who
    ? buildTenantPrincipal({ sub: who.sub, role: who.role, staffId: who.staffId }, { tenantId })
    : undefined
  return runWithTenant({ tenantId, principal }, fn)
}

/**
 * Cron/background tenant resolution. Platform-triggered work has no session, so it
 * must NAME its tenant when tenancy is on (fail closed). While tenancy is off it
 * targets the reference tenant, so existing single-tenant crons are unchanged.
 */
export function resolveBackgroundTenant(kind: 'cron' | 'webhook', explicitTenantId?: string): string {
  if (!isEnabled('TENANCY_ENABLED')) return DEFAULT_TENANT_ID
  if (!explicitTenantId) {
    recordTenantEvent('background-tenant-resolution', { detail: `${kind} missing explicit tenant`, keyFamily: kind })
    throw new Error(`${kind} requires an explicit tenant when tenancy is enabled`)
  }
  return normalizeTenantId(explicitTenantId)
}

/** Run background work inside the resolved tenant context. */
export async function withBackgroundTenant<T>(
  kind: 'cron' | 'webhook',
  fn: () => Promise<T>,
  explicitTenantId?: string,
): Promise<T> {
  const tenantId = resolveBackgroundTenant(kind, explicitTenantId)
  return runWithTenant({ tenantId }, fn)
}
