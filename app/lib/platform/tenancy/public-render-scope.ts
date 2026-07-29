// ── Reference-tenant scope for PUBLIC page rendering (Wave 6B) ───────────────
//
// The gap this closes. `withTenantRoute` wraps API route HANDLERS; nothing wraps
// React Server Components. A page therefore renders with NO tenant context — during
// static prerender (no request exists at all), during build-time metadata, and during
// on-demand server rendering. With TENANCY_ENABLED=true the key chokepoint correctly
// fails closed, so `next build` died on the homepage:
//
//   Error: tenant context required for tenant-owned key family "rv:*"
//
// The chokepoint is right and is NOT relaxed here. What was missing is an explicit,
// auditable statement of intent for the one case where a tenant IS knowable without a
// request: the public jkissllc.com marketing surface, which deliberately publishes the
// reference tenant's own content to everyone.
//
// WHY A NAMED HELPER RATHER THAN INLINE `runWithTenant`:
//   • it takes NO tenant parameter, so no caller — and no public input — can ever
//     steer it at another tenant. Inline `runWithTenant(...)` at each call site would
//     make the tenant an argument, which is exactly the mistake this prevents;
//   • every use is greppable, so "which public surfaces publish reference-tenant
//     data?" has one answer instead of an archaeology exercise;
//   • it is scoped to ONE tenant by construction, so it can never become a general
//     "escape the tenancy check" utility.
//
// WHAT IT IS NOT FOR — see the tests in scripts/build-tenant-scope.test.ts:
//   • authenticated pages or dashboards (tenant comes from the signed session);
//   • customer-token pages such as /booking/[token] (tenant is the RECORD's own
//     tenantId — see resolveTenantFromResource);
//   • API route handlers (already covered by withTenantRoute);
//   • cron/webhook work (covered by withBackgroundTenant, which names its tenant).
//
// Behaviour is unchanged while TENANCY_ENABLED=false: the chokepoint no-ops, so
// wrapping a read is byte-identical to today.

import { runWithTenant } from './context'
import { DEFAULT_TENANT_ID } from './types'

/**
 * Run a public-surface data read inside the REFERENCE tenant's context.
 *
 * Takes no tenant argument on purpose. The reference tenant is the only tenant whose
 * content is published to anonymous visitors, so it is the only tenant this helper
 * will ever resolve — a caller cannot widen that.
 *
 * Nesting is safe: an inner `runWithTenant` (or an authenticated request that already
 * established a context) still wins for its own scope, and the previous context is
 * restored when this callback returns OR throws, because AsyncLocalStorage.run
 * unwinds on both paths.
 */
export function withReferenceTenantScope<T>(fn: () => T): T {
  return runWithTenant({ tenantId: DEFAULT_TENANT_ID }, fn)
}

/** The tenant this helper publishes. Exported so tests can assert it, never to
 *  let a caller substitute a different one. */
export const PUBLIC_RENDER_TENANT_ID = DEFAULT_TENANT_ID
