// ── Tenant-aware Blob path API ───────────────────────────────────────────────
//
// The ONE place tenant-owned Vercel Blob object paths are namespaced — the Blob
// analogue of keys.ts (Redis). Security rules mirror the key chokepoint:
//   • Tenant boundary is an OPAQUE, normalized id — never a display name.
//   • A tenant-owned path with no tenant context THROWS (fail closed) when
//     tenancy is enabled — never a silent write into the shared namespace.
//   • Compatibility: while TENANCY_ENABLED=false, paths are returned UNCHANGED
//     (byte-identical to today), so existing objects and URLs keep working.
//   • Path traversal / absolute paths / display-name segments are rejected.
//
// Reads & deletes operate on the ABSOLUTE object URL stored at write time, so
// legacy (un-prefixed) objects remain fully readable without a migration — only
// the write path gains a tenant segment when tenancy is on.

import { isEnabled } from '../flags'
import { currentTenantId } from './context'
import { normalizeTenantId } from './keys'

/** Objects written under this prefix are tenant-scoped. */
export const TENANT_BLOB_PREFIX = 'tenants/'
const TENANT_BLOB_PREFIX_RE = /^tenants\/[a-z0-9][a-z0-9-]{0,63}\//

/**
 * Sanitize a single path segment: strip any directory component (basename only),
 * reject traversal, and keep a filesystem/URL-safe charset. Preserves the file
 * extension. Never throws on empty — returns a safe placeholder — EXCEPT it does
 * reject explicit traversal so a caller can't smuggle `../`.
 */
export function sanitizeBlobSegment(name: string): string {
  if (typeof name !== 'string') throw new Error('blob segment must be a string')
  // basename only — drop any path the caller (or a filename) tried to include
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  if (base === '..' || base === '.' || base.includes('\0')) {
    throw new Error('unsafe blob filename')
  }
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned.length ? cleaned : 'file'
}

/**
 * Validate a caller-supplied LEGACY path (e.g. "quote-photos/<uuid>.jpg"). It is
 * the physical path used today; it must be relative, traversal-free, and made of
 * safe segments. Returns the normalized legacy path.
 */
export function assertLegacyBlobPath(legacyPath: string): string {
  if (typeof legacyPath !== 'string' || !legacyPath.length) throw new Error('blob path required')
  if (legacyPath.startsWith('/') || legacyPath.startsWith(TENANT_BLOB_PREFIX)) {
    throw new Error('blob path must be relative and not already tenant-scoped')
  }
  const parts = legacyPath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length || parts.some((p) => p === '..' || p === '.' || p.includes('\0'))) {
    throw new Error('unsafe blob path (traversal)')
  }
  return parts.join('/')
}

export type BlobScopeOpts = { enabled?: boolean; tenantId?: string }

/**
 * The core transform (mirrors scopeKey). Given the legacy physical path a call
 * site uses today, returns:
 *  - the path UNCHANGED when tenancy is off (byte-identical compat);
 *  - `tenants/{tenantId}/{legacyPath}` when tenancy is on and a tenant resolves;
 *  - THROWS when tenancy is on and no tenant context is available (fail closed).
 */
export function scopeBlobPath(legacyPath: string, opts?: BlobScopeOpts): string {
  const clean = assertLegacyBlobPath(legacyPath)
  const enabled = opts?.enabled ?? isEnabled('TENANCY_ENABLED')
  if (!enabled) return clean
  const tid = opts?.tenantId ?? currentTenantId()
  if (!tid) {
    throw new Error(`tenant context required for tenant-owned blob path "${clean.split('/')[0]}/*"`)
  }
  return `${TENANT_BLOB_PREFIX}${normalizeTenantId(tid)}/${clean}`
}

/** True when a path is already tenant-scoped (idempotency guard). */
export function isTenantScopedBlobPath(path: string): boolean {
  return TENANT_BLOB_PREFIX_RE.test(path)
}

/** The un-prefixed (legacy) form of a path — the physical path used today. */
export function legacyBlobPath(path: string): string {
  return isTenantScopedBlobPath(path) ? path.replace(TENANT_BLOB_PREFIX_RE, '') : path
}

/**
 * Dark-launch helper: the (legacy, tenant) path pair for a logical write, so a
 * shadow comparison can be recorded WITHOUT changing where the object is written
 * today. Returns null when no tenant is resolvable.
 */
export function compareLegacyAndTenantBlobPath(
  legacyPath: string,
  opts?: { tenantId?: string },
): { legacy: string; tenant: string } | null {
  const clean = assertLegacyBlobPath(legacyBlobPath(legacyPath))
  const tid = opts?.tenantId ?? currentTenantId()
  if (!tid) return null
  return { legacy: clean, tenant: `${TENANT_BLOB_PREFIX}${normalizeTenantId(tid)}/${clean}` }
}
