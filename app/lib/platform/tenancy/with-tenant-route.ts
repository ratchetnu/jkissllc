// ── Route-handler tenant wrapper (S1: context wiring) ────────────────────────
//
// The ONE higher-order wrapper that establishes a per-request tenant context
// around a Next.js App Router handler, so every tenant-owned Redis / audit /
// analytics / notification op inside the handler runs within a tenant scope.
//
// It delegates resolution to the existing trusted mechanism
// (`withTenantContextFromRequest` — signed session only, never a header/body), so
// there is exactly one place that decides the tenant. Behavior:
//   • TENANCY_ENABLED=false → resolves to the reference tenant and the key
//     chokepoint no-ops; wrapping a handler is byte-identical to today.
//   • TENANCY_ENABLED=true, resolvable tenant → runs inside `t:{tenantId}:` scope.
//   • TENANCY_ENABLED=true, no resolvable tenant → THROWS (fail-closed). No global
//     fallback, never a silent substitution.
//
// Apply at the route export, preserving the handler's own signature (req + the
// optional route-context second arg for dynamic segments):
//   export const GET = withTenantRoute(async (req, { params }) => { ... })

import type { NextRequest } from 'next/server'
import { withTenantContextFromRequest } from './request-context'

// Route context is whatever Next passes as the 2nd arg (undefined for static
// routes, `{ params }` for dynamic ones). Kept generic so the wrapper is
// signature-preserving and never narrows a handler's params typing.
type RouteHandler<C> = (req: NextRequest, ctx: C) => Response | Promise<Response>

/**
 * Wrap a route handler so its entire async lifetime runs inside the request's
 * tenant context. Additive and reversible: unwrapping restores the exact prior
 * handler. No-op behavior while TENANCY_ENABLED=false.
 */
export function withTenantRoute<C>(handler: RouteHandler<C>): RouteHandler<C> {
  return (req, ctx) => withTenantContextFromRequest(req, async () => handler(req, ctx))
}
