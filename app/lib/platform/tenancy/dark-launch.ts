// ── Dark-launch comparison ───────────────────────────────────────────────────
//
// Compares a legacy value against its tenant-scoped copy WITHOUT changing the
// live response (the caller returns the legacy value). Mismatches are classified
// and reported via redacted telemetry — values are never logged.

import { keyFamily } from './keys'
import { recordTenantEvent } from '../observability/tenant-telemetry'

export type MismatchType =
  | 'missing-tenant-copy'
  | 'stale-tenant-copy'
  | 'serialization-mismatch'
  | 'value-mismatch'

// Canonical (key-sorted) JSON so re-ordered keys compare equal.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** Classify a legacy↔tenant value pair. Returns null when they match. */
export function classifyMismatch(legacy: string | null, tenant: string | null): MismatchType | null {
  if (legacy === tenant) return null
  if (legacy !== null && tenant === null) return 'missing-tenant-copy'
  if (legacy === null && tenant !== null) return 'stale-tenant-copy'
  // Both present and differ — is it only serialization (equal canonical JSON)?
  try {
    if (stableStringify(JSON.parse(legacy as string)) === stableStringify(JSON.parse(tenant as string))) {
      return 'serialization-mismatch'
    }
  } catch {
    /* not JSON — fall through to value-mismatch */
  }
  return 'value-mismatch'
}

export type DarkLaunchSummary = { ok: number } & Record<MismatchType, number>

export function newSummary(): DarkLaunchSummary {
  return { ok: 0, 'missing-tenant-copy': 0, 'stale-tenant-copy': 0, 'serialization-mismatch': 0, 'value-mismatch': 0 }
}

/**
 * Record one comparison: classify, emit redacted telemetry on mismatch, and tally
 * into an optional summary. Returns the mismatch type (or null if equal).
 */
export function recordComparison(
  key: string,
  tenantId: string,
  legacy: string | null,
  tenant: string | null,
  opts?: { correlationId?: string; summary?: DarkLaunchSummary },
): MismatchType | null {
  const type = classifyMismatch(legacy, tenant)
  if (type) {
    recordTenantEvent('dark-launch-mismatch', {
      keyFamily: keyFamily(key), tenantId, correlationId: opts?.correlationId, mismatchType: type,
    })
    if (opts?.summary) opts.summary[type]++
  } else if (opts?.summary) {
    opts.summary.ok++
  }
  return type
}
