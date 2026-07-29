// ── Public-token tenant scope for SERVER COMPONENTS (Wave 6D-C) ──────────────
//
// `withPublicTokenRoute` wraps route HANDLERS. React Server Components are not
// handlers, so a public page cannot use it — and a page has no session either. That
// left `/booking/[token]/page.tsx` reading `bk:*` with no tenant context at all.
//
// The failure mode was quiet, which is what made it dangerous. The page already wraps
// its read in `try { … } catch { booking = null }`, so under TENANCY_ENABLED=true it
// did not error — it rendered "Booking not found" for EVERY valid customer link. A
// crash would at least have been obvious; this looked like a legitimate answer.
//
// This is the same resolution logic as the route wrapper, exposed as a plain async
// function so a server component can await it. Both now share `resolvePublicToken`
// so the two paths can never drift apart.

import { runWithTenant } from './context'
import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID } from './types'
import { resolveTokenBinding, isValidPublicToken, type TokenResourceType, type TokenBinding } from './token-binding'
import { recordTenantEvent } from '../observability/tenant-telemetry'

export type PublicTokenResolution =
  /** Bound: run inside `tenantId`. */
  | { kind: 'bound'; binding: TokenBinding }
  /** Single-tenant compatibility: unbound legacy token while tenancy is OFF. */
  | { kind: 'legacy'; tenantId: string }
  /** Refuse. Unknown, malformed, revoked, wrong-surface, or unbound-under-tenancy. */
  | { kind: 'refused' }

/**
 * The ONE decision both the route wrapper and server-component scope use.
 *
 * Takes a token and an expected resource type — and nothing else. There is no
 * parameter through which a header, query string, body field or caller-supplied
 * tenant id could influence the answer.
 */
export async function resolvePublicToken(
  token: string | undefined | null,
  expect?: TokenResourceType,
  opts?: { expectResourceId?: string },
): Promise<PublicTokenResolution> {
  if (!isValidPublicToken(token)) return { kind: 'refused' }

  const binding = await resolveTokenBinding(token)

  if (!binding) {
    if (isEnabled('TENANCY_ENABLED')) {
      // Fail closed: an unbound token is unattributable, and the reference tenant
      // would be a guess rather than an answer.
      recordTenantEvent('missing-tenant-context', { detail: 'public token has no tenant binding', keyFamily: 'platform:token' })
      return { kind: 'refused' }
    }
    return { kind: 'legacy', tenantId: DEFAULT_TENANT_ID }
  }

  // A booking token presented to the invoice surface resolves to a real tenant but the
  // wrong resource class. Refuse before the caller reads anything.
  if (expect && binding.resourceType !== expect) {
    recordTenantEvent('cross-tenant-denial', { detail: 'public token used on the wrong surface', keyFamily: 'platform:token' })
    return { kind: 'refused' }
  }

  // Exact resource identity. Today every family uses resourceId === token, so this is
  // usually a tautology — but it stops being one the moment a family binds a token
  // whose resourceId differs, and asserting it now means that change cannot silently
  // widen what a token reaches.
  if (opts?.expectResourceId && binding.resourceId !== opts.expectResourceId) {
    recordTenantEvent('cross-tenant-denial', { detail: 'public token resource id mismatch', keyFamily: 'platform:token' })
    return { kind: 'refused' }
  }

  return { kind: 'bound', binding }
}

/**
 * Run a server component's data loading inside the tenant that owns `token`.
 *
 * Returns `onRefused()` — NOT the loader's result — when the token cannot be trusted,
 * so a caller cannot accidentally fall through into an unscoped read. The loader is
 * never invoked in that case.
 */
export async function withPublicTokenScope<T>(
  token: string | undefined | null,
  expect: TokenResourceType,
  load: () => Promise<T>,
  onRefused: () => T,
): Promise<T> {
  const resolved = await resolvePublicToken(token, expect, { expectResourceId: token ?? undefined })
  if (resolved.kind === 'refused') return onRefused()
  const tenantId = resolved.kind === 'bound' ? resolved.binding.tenantId : resolved.tenantId
  return runWithTenant({ tenantId }, load)
}
