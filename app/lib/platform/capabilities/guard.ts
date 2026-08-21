// ── Runtime capability enforcement ───────────────────────────────────────────
//
// The server-side half. Hiding a button is not a control: an optional capability
// that is only enforced in the UI is enforced nowhere, because the route is still
// reachable with curl. Every payment, SMS and email entry point resolves through
// here before it touches a provider.
//
// ── Rules ────────────────────────────────────────────────────────────────────
//
//  1. The tenant is resolved SERVER-SIDE, from the ambient tenant context
//     (established from the signed session or an explicit background tenant).
//     No caller may pass a tenant id in from a request body, so a forged client
//     claim that "payments are enabled for me" cannot reach a decision.
//  2. FAIL CLOSED. A store outage resolves to registry defaults, and any state
//     other than `ready` refuses. The refusal carries a stable, non-secret code
//     and never names a credential VALUE.
//  3. Refusals are typed, not booleans, so a caller cannot accidentally treat
//     "disabled" and "misconfigured" as the same thing — they need different
//     operator responses and different HTTP statuses.

import { currentTenantId } from '../tenancy/context'
import { DEFAULT_TENANT_ID } from '../tenancy/types'
import type { CapabilityId } from './types'
import { getCapability } from './registry'
import { CAPABILITY_STATE_CODES, type CapabilityState, type ResolvedCapability } from './tenant-profile'
import { resolveTenantCapabilities } from './tenant-profile-store'

/**
 * A capability was not available. `code` is stable and safe to return to a client;
 * `message` is safe to show an operator. Neither ever contains a secret value —
 * `missingVars` holds variable NAMES only.
 */
export class CapabilityUnavailableError extends Error {
  readonly capability: CapabilityId
  readonly state: CapabilityState
  readonly code: string
  readonly httpStatus: number
  readonly missingVars: string[]
  readonly blockedBy: CapabilityId[]

  constructor(resolved: Pick<ResolvedCapability, 'id' | 'state' | 'code' | 'missingVars' | 'blockedBy' | 'displayName'>) {
    super(explain(resolved))
    this.name = 'CapabilityUnavailableError'
    this.capability = resolved.id
    this.state = resolved.state
    this.code = resolved.code
    this.missingVars = resolved.missingVars
    this.blockedBy = resolved.blockedBy
    // 409 = "you asked for something this business does not do" (a configuration
    // answer the caller can act on). 503 = "it is meant to work and does not"
    // (an operator answer, and the one a provider may retry).
    this.httpStatus = resolved.state === 'degraded' || resolved.state === 'setup_required' ? 503 : 409
  }
}

function explain(r: Pick<ResolvedCapability, 'state' | 'missingVars' | 'blockedBy' | 'displayName'>): string {
  switch (r.state) {
    case 'disabled': return `${r.displayName} is turned off for this business.`
    case 'not_installed': return `${r.displayName} is not available in this build.`
    case 'not_in_pack': return `${r.displayName} is not part of this product.`
    case 'blocked': return `${r.displayName} needs ${r.blockedBy.join(', ')} to be turned on first.`
    case 'setup_required': return `${r.displayName} is turned on but not finished — still needs ${r.missingVars.join(', ')}.`
    case 'degraded': return `${r.displayName} is configured but its provider is currently failing.`
    default: return `${r.displayName} is unavailable.`
  }
}

/**
 * The tenant this request acts for. Server-resolved only. Falls back to the
 * reference tenant when tenancy is off, which is exactly today's single-tenant
 * behavior.
 */
export function guardTenantId(): string {
  return currentTenantId() ?? DEFAULT_TENANT_ID
}

export type CapabilityCheckOptions = {
  /** Explicit tenant for background work that already resolved one. NEVER from a request body. */
  tenantId?: string
  env?: Record<string, string | undefined>
  observedFailures?: Partial<Record<'stripe' | 'twilio' | 'resend', boolean>>
}

/** Resolve one capability for the acting tenant. Fail-soft read; the CALLER decides. */
export async function checkCapability(
  id: CapabilityId,
  opts: CapabilityCheckOptions = {},
): Promise<ResolvedCapability> {
  const tenantId = opts.tenantId ?? guardTenantId()
  try {
    const resolved = await resolveTenantCapabilities(tenantId, { env: opts.env, observedFailures: opts.observedFailures })
    return resolved.capabilities[id]
  } catch {
    // Even the fail-soft resolver can throw on an invalid tenant id. Fail CLOSED:
    // report the capability as unavailable rather than assuming it is fine.
    const c = getCapability(id)
    return {
      id, displayName: c.displayName, kind: c.kind, provider: c.provider,
      codeInstalled: false, packAvailable: false, tenantEnabled: false, providerConfigured: null,
      operational: false, state: 'not_installed', code: CAPABILITY_STATE_CODES.not_installed,
      selectionSource: 'registry-default', blockedBy: [], missingVars: [],
    }
  }
}

/** True only when the capability is fully operational for the acting tenant. */
export async function capabilityAvailable(id: CapabilityId, opts: CapabilityCheckOptions = {}): Promise<boolean> {
  return (await checkCapability(id, opts)).state === 'ready'
}

/** Throw `CapabilityUnavailableError` unless the capability is ready. */
export async function requireCapability(
  id: CapabilityId,
  opts: CapabilityCheckOptions = {},
): Promise<ResolvedCapability> {
  const resolved = await checkCapability(id, opts)
  if (resolved.state !== 'ready') throw new CapabilityUnavailableError(resolved)
  return resolved
}

/** A JSON body for a route that refused. Stable code + a safe operator message. */
export function capabilityErrorBody(err: CapabilityUnavailableError): {
  error: string; code: string; capability: CapabilityId; missing?: string[]
} {
  return {
    error: err.message,
    code: err.code,
    capability: err.capability,
    // Variable NAMES only — a client that can see this already knows the app needs
    // Stripe; what it must never learn is any part of the key.
    missing: err.missingVars.length ? err.missingVars : undefined,
  }
}

// ── Webhook policy for an intentionally disabled capability ──────────────────
//
// A provider that receives a 5xx retries — for hours, with backoff. That is
// correct for "we are broken", and actively harmful for "we do not use you": the
// retry can never succeed, so it becomes an unbounded storm against a public
// endpoint of a business that already opted out.
//
// The rule, applied AFTER signature verification in every provider webhook:
//
//   cannot verify the signature (no secret)  → 503, fail closed. Nothing is
//                                              parsed, nothing is trusted.
//   signature invalid                        → 400. Not a retry candidate.
//   signature VALID + capability disabled    → 200 `{ ignored: true }`. The event
//                                              is authentic and deliberately not
//                                              processed; acknowledging it stops
//                                              the storm without ever acting on it.
//   signature VALID + setup_required/degraded→ 503. This one IS a real outage and
//                                              the retry is wanted.
//
// Acknowledging is safe only because it happens after verification: an unsigned or
// forged event still gets nothing.
export type WebhookDisposition =
  | { action: 'process' }
  | { action: 'acknowledge'; status: 200; code: string; reason: string }
  | { action: 'refuse'; status: 503; code: string; reason: string }

export function webhookDisposition(resolved: ResolvedCapability): WebhookDisposition {
  if (resolved.state === 'ready') return { action: 'process' }
  if (resolved.state === 'setup_required' || resolved.state === 'degraded') {
    return { action: 'refuse', status: 503, code: resolved.code, reason: `${resolved.displayName} is enabled but not operational` }
  }
  return {
    action: 'acknowledge',
    status: 200,
    code: resolved.code,
    reason: `${resolved.displayName} is not enabled for this business — the verified event was acknowledged and discarded`,
  }
}
