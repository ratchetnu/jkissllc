# 07 — Name-Derived Key Migration

**Files:** `app/lib/platform/tenancy/stable-id.ts`, `keys.ts` `normalizeTenantId` ·
**Tests:** `scripts/name-derived-keys.test.ts`.

## The problem
Some keys are derived from mutable, user-facing strings: `biz:{name}` (business
name), `promo:{code}`, `ship:{bol}`, `msg:phone:{e164}`, and `Staff.payByBusiness`
maps keyed by `bizKey`. A rename or collision moves/merges records.

## The boundary is safe already
The **tenant** boundary is an opaque id, never a name — proven by
`normalizeTenantId`, which **rejects** display names (spaces/`@`/uppercase-with-
spaces/empty). Test: `normalizeTenantId(JKISS_TENANT.displayName)` throws while
`normalizeTenantId(JKISS_TENANT.id)` = `jkiss`; **renaming the tenant does not
change its identity.**

## Forward path for entity keys (this sprint: helpers + strategy, not a data run)
- `stableId(prefix)` → opaque `prefix_<32 hex>` for future entity ids;
  `isStableId` / `looksNameDerived` guard against accidental name use.
- **Mapping strategy:** introduce `biz:id:{stableId}` as the canonical record and a
  `biz:byname:{normalized}` → `stableId` lookup; rewrite `Staff.payByBusiness`
  from name-keyed to id-keyed during the data migration. Keep the legacy
  `biz:{name}` compatibility until cutover.

## Deferred
The actual data migration of `biz`/`payByBusiness`/`promo`/`ship` to stable ids is
a **separate, cautious** step (it rewrites embedded map keys, not just Redis keys)
— see doc 15 / the tenant-isolation follow-up. This sprint ships the safe boundary
+ helpers + tests.
