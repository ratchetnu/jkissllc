// ── Tenancy telemetry ────────────────────────────────────────────────────────
//
// Structured, redacted signals for the isolation migration. Emits ONLY safe
// metadata — key family (first segment), tenant id, correlation id, event type —
// NEVER Redis values, tokens, PII, or message content (the logger redacts, and we
// never pass sensitive values in).

import { logger } from './logger'

export type TenantEvent =
  | 'key-gen-failure'
  | 'missing-tenant-context'
  | 'cross-tenant-denial'
  | 'legacy-fallback'
  | 'dark-launch-mismatch'
  | 'migration-progress'
  | 'migration-conflict'
  | 'background-tenant-resolution'
  | 'unauthorized-global-access'

export type TenantEventCtx = {
  tenantId?: string
  keyFamily?: string
  correlationId?: string
  mismatchType?: string
  detail?: string
}

export function recordTenantEvent(event: TenantEvent, ctx: TenantEventCtx = {}): void {
  const level = event === 'cross-tenant-denial' || event === 'key-gen-failure' || event === 'unauthorized-global-access' ? 'error' : 'warn'
  logger[level](`tenancy:${event}`, { event, ...ctx })
}
