// ── Request-scoped tenant context ────────────────────────────────────────────
//
// Node `AsyncLocalStorage` so tenant identity flows through a request WITHOUT
// threading it through every function signature. Established PER-HANDLER via
// `runWithTenant(...)` seeded from the resolved principal.
//
// IMPORTANT (corrects the blueprint wording): this cannot be set in proxy.ts and
// read in a route handler — middleware and handlers are separate invocations that
// don't share a call stack (and proxy runs on the Edge runtime). So this module
// imports node:async_hooks and is used only inside Node route handlers, NEVER from
// proxy.ts. See docs/opspilot-os/19-assessment-verification.md.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { TenantPrincipal } from './types'

export type TenantContext = {
  tenantId: string
  principal?: TenantPrincipal
  correlationId?: string
}

const als = new AsyncLocalStorage<TenantContext>()

/** Run `fn` with the given tenant context active for its entire async lifetime. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return als.run(ctx, fn)
}

/** The active tenant context, or undefined outside a runWithTenant scope. */
export function getTenantContext(): TenantContext | undefined {
  return als.getStore()
}

/** The active tenant id, or undefined if no context is established. */
export function currentTenantId(): string | undefined {
  return als.getStore()?.tenantId
}

/** The active principal, or undefined. */
export function currentPrincipal(): TenantPrincipal | undefined {
  return als.getStore()?.principal
}
