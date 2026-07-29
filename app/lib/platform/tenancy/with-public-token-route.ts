// ── Route wrapper for SESSION-LESS public token routes (Wave 6C) ─────────────
//
// `withTenantRoute` resolves the tenant from the signed session, which is exactly
// wrong for a customer following a link from their email: they have no session, so
// with TENANCY_ENABLED=true it throws before the handler runs. This is its
// counterpart — same shape, different authority: the tenant comes from the token's
// platform-global binding.
//
// Order matters and is the security property:
//   1. read the binding (platform-global, no tenant context needed)
//   2. enter THAT tenant's context
//   3. only then run the handler, which reads tenant-owned records normally
//
// An unknown, malformed or revoked token never reaches step 2. The handler is not
// invoked and the response is a bare 404 — identical to the response for a token that
// belongs to another tenant, so a prober cannot tell "wrong tenant" from "no such
// token".
//
// Compatibility: while TENANCY_ENABLED=false the deployment is single-tenant, so a
// token with no binding yet (every token issued before this wave) runs in the
// reference tenant exactly as it does today. That fallback is deliberately NOT
// available when tenancy is on — there, a missing binding fails closed, because
// guessing the reference tenant for an unbound token would be the cross-tenant read
// this wrapper exists to prevent.

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { runWithTenant } from './context'
import { isEnabled } from '../flags'
import { DEFAULT_TENANT_ID } from './types'
import { resolveTokenBinding, isValidPublicToken, type TokenResourceType } from './token-binding'
import { recordTenantEvent } from '../observability/tenant-telemetry'

type Ctx<P> = { params: Promise<P> }
type Handler<P> = (req: NextRequest, ctx: Ctx<P>) => Response | Promise<Response>

/** Uniform 404 for every "cannot resolve this token" case. Never says why. */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}

export type PublicTokenRouteOpts = {
  /** Which param carries the token (default 'token'). */
  param?: string
  /** Refuse a token minted for a different surface, when the binding records one. */
  expect?: TokenResourceType
}

/**
 * Wrap a public token route so its body runs inside the tenant that owns the token.
 *
 * The handler keeps its own signature; this only establishes context around it.
 */
export function withPublicTokenRoute<P extends Record<string, string>>(
  handler: Handler<P>,
  opts: PublicTokenRouteOpts = {},
): Handler<P> {
  const paramName = opts.param ?? 'token'
  return async (req, ctx) => {
    const params = await ctx.params
    const token = params?.[paramName]

    if (!isValidPublicToken(token)) return notFound()

    const binding = await resolveTokenBinding(token)

    if (!binding) {
      if (isEnabled('TENANCY_ENABLED')) {
        // Fail closed. An unbound token under tenancy is unattributable, and the
        // reference tenant is a guess, not an answer.
        recordTenantEvent('missing-tenant-context', { detail: 'public token has no tenant binding', keyFamily: 'platform:token' })
        return notFound()
      }
      // Single-tenant: unchanged behaviour for tokens issued before this wave.
      return runWithTenant({ tenantId: DEFAULT_TENANT_ID }, async () => handler(req, { ...ctx, params: Promise.resolve(params) }))
    }

    if (opts.expect && binding.resourceType !== opts.expect) {
      // A booking token presented to the invoice route resolves to a real tenant but
      // the wrong surface. Refuse rather than let the handler look it up.
      recordTenantEvent('cross-tenant-denial', { detail: 'public token used on the wrong surface', keyFamily: 'platform:token' })
      return notFound()
    }

    return runWithTenant({ tenantId: binding.tenantId }, async () =>
      handler(req, { ...ctx, params: Promise.resolve(params) }),
    )
  }
}
