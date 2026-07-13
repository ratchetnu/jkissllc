# 02 — Tenant-Aware Key API

**File:** `app/lib/platform/tenancy/keys.ts` · **Tests:** `scripts/tenant-keys.test.ts`.

The **single** place tenant keys are constructed (enforced by the bypass gate).
No scattered `t:${...}` anywhere else — `tenant-store.ts` now delegates here too.

## API
- `scopeKey(key, {enabled?, tenantId?})` — the core transform:
  - tenancy **off** → key **unchanged** (byte-identical to today);
  - platform-global or already-scoped → unchanged (idempotent);
  - tenancy **on** + resolvable tenant → `t:{tenantId}:{key}`;
  - tenancy **on** + tenant-owned + **no tenant** → **throws** (fail closed).
  Tenant resolves from `opts.tenantId` else the `AsyncLocalStorage` context.
- `requireTenantKey(tenantId, key)` — explicit builder; throws on a platform-global key.
- `platformKey(key)` — asserts the key is on the global allowlist.
- `legacyKey(key)` — the un-prefixed physical form.
- `compareLegacyAndTenantKey(key, {tenantId?})` — the `(legacy, tenant)` pair for dark-launch (null for global / no tenant).
- `normalizeTenantId(id)` — lowercases + validates `^[a-z0-9][a-z0-9-]{0,63}$`; **rejects display names** (spaces, `@`, empty).
- `isPlatformGlobal` / `isTenantScoped` / `keyFamily` — helpers (`keyFamily` is the only key-derived value safe to log).

## Allowlist
`PLATFORM_GLOBAL_PREFIXES = ['opspilot:', 'platform:', 'ai:', 'rl:']`.

## Security properties (tested)
Opaque-id-only boundaries · fail-closed on missing context · idempotent · no
name-derived boundary · deterministic output · global allowlist honored.
