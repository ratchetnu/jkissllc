# 06 — Dark-Launch Strategy

**Files:** `app/lib/platform/tenancy/dark-launch.ts`, `redis.ts` `get` ·
**Flag:** `TENANCY_DARK_LAUNCH` (off) · **Tests:** `scripts/dark-launch.test.ts`.

Validate the tenant copy against the legacy value in a non-production environment
**without changing live responses**.

## How it works
With the flag on and a tenant context established, `redis.get(key)`:
1. reads the legacy value **and** the tenant-scoped value,
2. classifies any mismatch,
3. records it via redacted telemetry (key **family**, tenant id, correlation id,
   mismatch type — **never the value**),
4. **returns the legacy value** (unchanged behavior).

## Mismatch types (`classifyMismatch`)
- `missing-tenant-copy` — legacy present, tenant absent (not yet migrated)
- `stale-tenant-copy` — tenant present, legacy absent
- `serialization-mismatch` — equal **canonical** (key-sorted) JSON, different bytes
- `value-mismatch` — genuinely different data

Plus the reporter also surfaces `unexpected-global-access` and
`tenant-context-missing` via `tenant-telemetry.ts`.

## Summary reporting
`newSummary()` + `recordComparison(...)` tally counts per type (and `ok`) for a
run-level report. Serialization-only differences are distinguished from real
drift so migration verification isn't derailed by key ordering.

## Safety
Read-only, off by default, non-production. Adds one extra read per `get` only
while enabled.
