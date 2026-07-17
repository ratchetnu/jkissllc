// ── Pilot: tenant-safe branding / organization-profile settings ──────────────
//
// The FIRST domain converted to a tenant-safe repository boundary. Chosen because
// it is the SAFEST per the readiness audit: display-only identity metadata (name,
// tagline, brand color, logo, from-address, support contact) — no pricing, no
// payments, no PII, no crew/customer records. Converting it proves the end-to-end
// pattern without risking a critical surface.
//
// TENANT-SAFE BOUNDARY — this module is the ONLY place branding settings are read
// or written, and every access runs inside `runWithTenant({ tenantId })`, so the
// live Redis chokepoint (app/lib/redis.ts → scopeKey) namespaces the key:
//   • TENANCY_ENABLED=false → key stays `settings:branding` (byte-identical today);
//   • TENANCY_ENABLED=true  → key becomes `t:{tenantId}:settings:branding`.
// The tenant id is ALWAYS a server-resolved value; a write additionally passes
// through `assertMembership` (server-side membership validation) and an RBAC
// `settings:manage` check, so a client-supplied tenant id is never trusted and a
// cross-tenant read/write is denied.

import { redis } from '../../../redis'
import { runWithTenant } from '../context'
import { normalizeTenantId } from '../keys'
import { can, type Role } from '../../../rbac'
import { COMPANY } from '../../../company'
import { JKISS_TENANT } from '../jkiss'
import { getTenant } from '../tenant-registry'
import { assertMembership, TenantAccessDeniedError, type ResolveOpts } from '../membership'
import { DEFAULT_TENANT_ID, type Tenant } from '../types'

/** The tenant-owned Redis key (scoped by the chokepoint when tenancy is on). */
const BRANDING_KEY = 'settings:branding'

/** Non-critical, display-only branding/profile metadata. */
export type TenantBranding = {
  displayName: string
  tagline: string
  primaryColor: string // "#rrggbb"
  logoUrl: string // http(s) url or ''
  emailFromAddress: string
  supportEmail: string
  phone: string
}

/** The actor performing an operation — the minimal shape from the session principal. */
export type BrandingActor = { sub: string; role: Role }

const MAX_LEN = 200
const HEX = /^#[0-9a-fA-F]{6}$/

function clampStr(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  return t.length ? t.slice(0, MAX_LEN) : fallback
}

function clampColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback
}

function clampUrl(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  if (!t) return ''
  // Only accept whitespace-free absolute http(s) URLs; anything else keeps the fallback.
  return /^https?:\/\/\S+$/.test(t) ? t.slice(0, MAX_LEN) : fallback
}

/**
 * Deterministic default branding for a tenant, derived from its registry record
 * (or the JKISS seed for the reference tenant). For the reference tenant this
 * reproduces today's identity BYTE-FOR-BYTE — the single-tenant compatibility map.
 */
export function brandingDefaultsFor(tenant: Tenant): TenantBranding {
  const isReference = tenant.id === DEFAULT_TENANT_ID
  return {
    displayName: tenant.displayName || tenant.id,
    tagline: isReference ? COMPANY.tagline : '',
    primaryColor: clampColor(tenant.brand.primaryColor, '#000000'),
    logoUrl: clampUrl(tenant.brand.logoUrl, ''),
    emailFromAddress: clampStr(tenant.brand.emailFromAddress, ''),
    supportEmail: clampStr(tenant.legal.supportEmail, ''),
    phone: clampStr(tenant.legal.phone, ''),
  }
}

/** Resolve the seed tenant used for a given id's defaults (registry, then jkiss). */
async function defaultsForTenantId(tenantId: string): Promise<TenantBranding> {
  const record = await getTenant(tenantId)
  if (record) return brandingDefaultsFor(record)
  if (tenantId === DEFAULT_TENANT_ID) return brandingDefaultsFor(JKISS_TENANT)
  // Unknown tenant: minimal, non-leaking defaults keyed only by its own id.
  return brandingDefaultsFor({
    id: tenantId,
    slug: tenantId,
    displayName: tenantId,
    legal: {},
    brand: {},
    status: 'active',
    createdAt: 0,
  })
}

/** Merge a stored (possibly partial) branding blob onto the defaults, sanitized. */
function mergeBranding(defaults: TenantBranding, patch: Partial<TenantBranding> | null): TenantBranding {
  const p = patch ?? {}
  return {
    displayName: clampStr(p.displayName, defaults.displayName),
    tagline: typeof p.tagline === 'string' ? clampStr(p.tagline, defaults.tagline) : defaults.tagline,
    primaryColor: clampColor(p.primaryColor, defaults.primaryColor),
    logoUrl: p.logoUrl === '' ? '' : clampUrl(p.logoUrl, defaults.logoUrl),
    emailFromAddress: clampStr(p.emailFromAddress, defaults.emailFromAddress),
    supportEmail: clampStr(p.supportEmail, defaults.supportEmail),
    phone: clampStr(p.phone, defaults.phone),
  }
}

/**
 * Read a tenant's branding for a SERVER-RESOLVED tenant id (defaults merged with
 * any stored overrides), scoped through the chokepoint. This helper does not gate
 * on membership: callers pass a tenant id the server already owns (e.g. from the
 * resolved principal / host mapping). For a caller acting on behalf of a specific
 * user, use `readBrandingFor` which validates membership first.
 */
export async function getBranding(tenantId: string): Promise<TenantBranding> {
  const tid = normalizeTenantId(tenantId)
  const defaults = await defaultsForTenantId(tid)
  const raw = await runWithTenant({ tenantId: tid }, () => redis.get(BRANDING_KEY))
  let patch: Partial<TenantBranding> | null = null
  if (raw) {
    try {
      patch = JSON.parse(raw) as Partial<TenantBranding>
    } catch {
      patch = null
    }
  }
  return mergeBranding(defaults, patch)
}

/**
 * Read branding on behalf of `actor`, enforcing that the actor is an active member
 * of `tenantId` first (server-side validation). Denies a cross-tenant read.
 */
export async function readBrandingFor(
  actor: BrandingActor,
  tenantId: string,
  opts?: ResolveOpts,
): Promise<TenantBranding> {
  await assertMembership(actor.sub, tenantId, opts) // throws TenantAccessDeniedError on a foreign tenant
  return getBranding(tenantId)
}

/**
 * Write a tenant's branding. The tenant-safe boundary in full:
 *   1. `assertMembership` — the actor must be an active member of `tenantId`
 *      (a client-supplied tenant id is never trusted; a cross-tenant write throws).
 *   2. RBAC — the actor's role must hold `settings:manage`.
 *   3. The write is scoped through the chokepoint inside `runWithTenant`.
 * Returns the resulting (merged, sanitized) branding.
 */
export async function setBranding(
  actor: BrandingActor,
  tenantId: string,
  patch: Partial<TenantBranding>,
  opts?: ResolveOpts,
): Promise<TenantBranding> {
  await assertMembership(actor.sub, tenantId, opts)
  if (!can(actor.role, 'settings:manage')) {
    throw new TenantAccessDeniedError('permission denied: settings:manage required')
  }
  const tid = normalizeTenantId(tenantId)
  const current = await getBranding(tid)
  const next = mergeBranding(current, patch)
  await runWithTenant({ tenantId: tid }, () => redis.set(BRANDING_KEY, JSON.stringify(next)))
  return next
}
