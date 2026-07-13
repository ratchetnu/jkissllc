# 04 — Tenancy Foundation

**Files:** `app/lib/platform/tenancy/{types,jkiss,context,principal,tenant-store}.ts`,
`app/lib/platform/flags.ts`, edits to `app/api/admin/_lib/session.ts`, `proxy.ts`,
`app/lib/rbac.ts` · **Tests:** `scripts/platform-tenancy.test.ts`,
`scripts/platform-flags.test.ts` · **Flag:** `TENANCY_ENABLED` (off).

## Models (`types.ts`)
`Tenant` (opaque `id`, slug, displayName, legal, brand, industryPackId, status),
`Membership` (User×Tenant×Role), `TenantPrincipal` (sub, tenantId, membershipId,
role, materialized permissions, authSource, staffId, sessionId).
`DEFAULT_TENANT_ID = 'jkiss'` — stable, **not** name-derived.

## Reference tenant (`jkiss.ts`)
`JKISS_TENANT` seeded byte-for-byte from `company.ts` (name, DOT/MC, address,
phone, brand color, email-from), so binding the app to `t:jkiss` reproduces
today's identity. `createdAt: 0` (deterministic, no `Date.now`).

## Principal + session (`principal.ts`, `session.ts`)
`buildTenantPrincipal` materializes the role's permission set (via new
`rbac.permissionsForRole`) and stamps provenance. `SessionPayload` gains optional
`tid`; `Principal` gains `tenantId` (defaults to `jkiss` for pre-tenancy tokens);
tokens carry `tid`; `slideSessionToken` preserves it. New `requireTenantSession`
returns a `TenantPrincipal` or 401 — it **never** falls back to an unauthenticated
or shared-tenant principal. Existing guards are untouched (additive).

## Context (`context.ts`)
`runWithTenant(ctx, fn)` / `getTenantContext()` / `currentTenantId()` — per-handler
`AsyncLocalStorage` (node:async_hooks), **not** imported from `proxy.ts` (Edge).
`proxy.ts` additionally strips any inbound `x-tenant-id` header (anti-spoofing).

## Data-access contract (`tenant-store.ts`)
`tenantKey(tenantId, key)` returns the key **unchanged** when tenancy is off
(byte-identical to today) and `t:{tenantId}:{key}` when on, **throwing** on a
missing tenant. `resolveTenantId` returns `null` (never a shared default) when
enabled and the tenant is unknown. **`redis.ts` is not modified** — this contract
is standalone, ready for the later prefixing phase.

## Backward-compatibility (tested)
Missing/incorrect context, role/membership resolution, flag-off continuity, and
cross-tenant denial via synthetic tenants all covered. With `TENANCY_ENABLED` off,
production is unchanged.
