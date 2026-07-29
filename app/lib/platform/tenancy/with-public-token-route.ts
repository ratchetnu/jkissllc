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
import { resolvePublicToken } from './public-token-scope'
import type { TokenResourceType } from './token-binding'

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

    // Delegates to the SHARED resolver (public-token-scope.ts) so the handler path and
    // the server-component path can never drift apart in what they accept.
    //
    // NOTE: resourceId is deliberately NOT asserted to equal the token here. Route
    // ASSIGNEE tokens bind resourceId to the ROUTE's token, not to themselves — that
    // indirection is the whole point of `rt:atok:` — so a blanket
    // `expectResourceId: token` would refuse every assignee link. Callers that know
    // their resource id pass it explicitly (see the booking page).
    const resolved = await resolvePublicToken(token, opts.expect)
    if (resolved.kind === 'refused') return notFound()

    const tenantId = resolved.kind === 'bound' ? resolved.binding.tenantId : resolved.tenantId
    return runWithTenant({ tenantId }, async () =>
      handler(req, { ...ctx, params: Promise.resolve(params) }),
    )
  }
}
