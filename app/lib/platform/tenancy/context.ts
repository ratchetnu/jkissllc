// ── Request-scoped tenant context ────────────────────────────────────────────
//
// Node `AsyncLocalStorage` so tenant identity flows through a request WITHOUT
// threading it through every function signature. Established PER-HANDLER via
// `runWithTenant(...)` seeded from the resolved principal.
//
// IMPORTANT (corrects the blueprint wording): this cannot be set in proxy.ts and
// read in a route handler — middleware and handlers are separate invocations that
// don't share a call stack (and proxy runs on the Edge runtime). Used only inside
// Node route handlers, NEVER from proxy.ts. See docs/opspilot-os/19-assessment-verification.md.
//
// node:async_hooks is loaded via `process.getBuiltinModule` — a RUNTIME accessor
// invisible to the bundler — NOT a static `import ... from 'node:async_hooks'`.
// The data layer (redis.ts → keys.ts → here) is transitively imported by some
// 'use client' pages; a static Node-builtin import would drag async_hooks into the
// browser bundle and break the client build. The accessor keeps it server-only;
// on the client the store is absent and the helpers no-op (correct — tenant
// scoping only ever happens server-side).

import type { AsyncLocalStorage as ALSType } from 'node:async_hooks' // type-only → erased, safe in any bundle
import type { TenantPrincipal } from './types'

export type TenantContext = {
  tenantId: string
  principal?: TenantPrincipal
  correlationId?: string
}

let resolved = false
let alsInstance: ALSType<TenantContext> | null = null

function als(): ALSType<TenantContext> | null {
  if (resolved) return alsInstance
  resolved = true
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }).process?.getBuiltinModule
  if (typeof window === 'undefined' && typeof getBuiltin === 'function') {
    try {
      const mod = getBuiltin('node:async_hooks') as { AsyncLocalStorage: new () => ALSType<TenantContext> }
      alsInstance = new mod.AsyncLocalStorage()
    } catch { /* runtime without async_hooks — helpers no-op */ }
  }
  return alsInstance
}

/** Run `fn` with the given tenant context active for its entire async lifetime. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  const store = als()
  return store ? store.run(ctx, fn) : fn()
}

/** The active tenant context, or undefined outside a runWithTenant scope. */
export function getTenantContext(): TenantContext | undefined {
  return als()?.getStore()
}

/** The active tenant id, or undefined if no context is established. */
export function currentTenantId(): string | undefined {
  return als()?.getStore()?.tenantId
}

/** The active principal, or undefined. */
export function currentPrincipal(): TenantPrincipal | undefined {
  return als()?.getStore()?.principal
}
