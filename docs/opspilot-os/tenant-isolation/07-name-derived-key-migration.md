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

---

## Sprint addendum — AI/Redis scoping + name-derived collisions (2026-07-14)

Audit findings addressed: **H-AI-2** (AI audit-read has no tenant filter),
**H-KEY-1** (`bizKey` name-derived → collision + into `Staff.payByBusiness`),
**H-KEY-2** (global `learn:*` pricing calibration). All changes are additive and
**inert while `TENANCY_ENABLED=false`** (byte-identical to today). No live write key
changed; no model behavior changed. Tests: `scripts/ai-tenant-scope.test.ts`,
`scripts/name-derived-keys.test.ts`.

### The two-tier isolation model (why fixes differ by family)
The Redis chokepoint (`app/lib/redis.ts` → `scopeKey`) namespaces every
**tenant-owned** key to `t:{tid}:{key}` when tenancy is on. Two consequences:

- **`biz:*` and `learn:*` are tenant-owned** (not in `PLATFORM_GLOBAL_PREFIXES`) →
  the chokepoint **already** isolates their Redis keys per tenant when enabled. No
  key-derivation change is needed; proven in `name-derived-keys.test.ts`.
- **`ai:*` is platform-global** (`ai:log`, `ai:call:*` are one shared physical set;
  cost is isolated separately as `ai:cost:{tid}:{day}`). The chokepoint deliberately
  does **not** prefix it, so tenant isolation on the read path must be enforced in
  application code.

### AI telemetry read filter (H-AI-2) — FIXED (guarded, inert off)
`app/lib/ai/telemetry.ts` adds `scopeAiRecords(records)`, applied inside
`listAiCalls`. It filters on the `tenantId` already stamped on every record:
- `TENANCY_ENABLED=false` → returns **all** records unchanged (today's behavior).
- enabled → returns only `currentTenantId()`'s records.
- enabled + no tenant context → **fails closed** (returns none) — no cross-tenant
  AI-output disclosure.

`computeAiAnalytics` reads through `listAiCalls` by default, so the filter propagates
to the whole Control Center rollup (volume, cost, models, recent, A/B). Limit note:
callers fetch the top-N global ids then filter to the tenant, so a tenant may see
fewer than `limit` of its own rows — acceptable and conservative.

**AI family audit:** `ai:log`/`ai:call:*` (telemetry — the only read-path disclosure,
now filtered); `ai:cost:{tid}:{day}` (already tenant-isolated by construction — the
tid is in the key); `ai:prompt:{id}:*` (platform-managed prompt registry/versions/AB
— shared config, intentionally global); no separate `ai:lock`/`ai:retry` families
exist (retry counts live in the record). `getAiCall` is unchanged — its only caller
`setAiFeedback` already enforces `rec.tenantId === tenantId`.

**Dark-launch proposal (NOT wired):** `PROPOSED_TENANT_AI_KEYS` in telemetry.ts
sketches a per-tenant index (`ai:log:{tid}` / `ai:call:{tid}:{id}`) so a future
migration can make reads O(tenant) instead of scan-and-filter. Nothing writes/reads
it this sprint.

### businesses (H-KEY-1) — partial fix + migration-required residual
- **Redis-key collision:** handled by the chokepoint (`biz:` auto-scopes). Two
  tenants' "Rooms To Go" no longer overwrite each other's contract rates at rest.
- **Residual (migration-required):** `bizKey` = normalized **name** also keys the
  `Staff.payByBusiness` map, which lives **inside a JSON value** — a prefix cannot
  reach it, and a name is not a durable identity (a rename moves the override). Fix
  = the stable-id migration. Forward-path builders now materialized (unused):
  `newBizId()`, `bizIdKey(id)` = `biz:id:{stableId}`, `bizNameIndexKey(name)` =
  `biz:byname:{normalized}`, plus the `isNameDerivedBizKey` guard. Live
  getters/setters stay name-keyed for compatibility until the data run.

### job-learning (H-KEY-2) — isolated by chokepoint when enabled
`learn:jobs` / `learn:calibration` are static, tenant-owned keys → auto-scoped to
`t:{tid}:learn:*` when enabled, so one tenant's completed-job outcomes cannot train
another tenant's estimator. **Activation requirement:** `recordJobOutcome` /
`getCalibration` (incl. any background/cron fold-in) must run inside `runWithTenant`
once tenancy is on, or `scopeKey` fails closed and throws.
