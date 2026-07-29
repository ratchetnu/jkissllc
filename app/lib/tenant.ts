import { currentTenantId } from './platform/tenancy/context'
import { normalizeTenantId } from './platform/tenancy/keys'
import { DEFAULT_TENANT_ID } from './platform/tenancy/types'

// ── The tenant identifier the AI layer stamps and budgets on ─────────────────
//
// WAVE 5 (tenant-isolation audit), defect TEN-1. This used to return the apex HOST
// ('jkissllc.com') when TENANT_ID was unset — a value in a DIFFERENT id space from
// the one the tenancy layer uses ('jkiss', DEFAULT_TENANT_ID), and one that
// `normalizeTenantId` rejects outright because a host is a display-derived string,
// not an opaque slug. That broke the boundary two ways:
//
//   • `scopeAiRecords()` filters `record.tenantId === currentTenantId()`. Records
//     were stamped 'jkissllc.com' while the context said 'jkiss', so with
//     TENANCY_ENABLED=true EVERY record was filtered out — the isolation control
//     "passed" only by disclosing nothing, and the AI dashboards went blank.
//   • the value violated the codebase's own rule (keys.ts): "Tenant boundary is an
//     OPAQUE, normalized id — never a display name."
//
// It now resolves in the SAME id space as the rest of tenancy, highest authority
// first: the server-set request context, then a normalized TENANT_ID override, then
// the reference tenant. While TENANCY_ENABLED=false there is no context and no
// override, so this is the reference tenant and `scopeAiRecords` stays inert —
// flag-off behaviour is unchanged apart from the stamped/keyed id itself.
export function tenantId(): string {
  const active = currentTenantId()
  if (active) return active // already normalized by the tenancy layer
  const explicit = process.env.TENANT_ID
  if (explicit && explicit.trim()) {
    // An unusable override must never silently become a boundary — fall back to the
    // reference tenant rather than keying data under a rejected id.
    try { return normalizeTenantId(explicit) } catch { return DEFAULT_TENANT_ID }
  }
  return DEFAULT_TENANT_ID
}
