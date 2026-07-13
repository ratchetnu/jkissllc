# 03 — Redis Access Chokepoint

**File:** `app/lib/redis.ts` · **Tests:** `scripts/redis` behavior covered via
`tenant-isolation.test.ts` + full existing suite (unchanged when flag off).

Every method now routes its key(s) through `scopeKey()`:
`get/set/del/zadd/zrevrange/zrem/incr/pexpire/expire/zcard/zrange/setNxPx` scope
the key; `eval` scopes each lock KEY; `pfcount` scopes all keys. Added commands
(`hincrby/hgetall/pfadd/pfcount/expire`) so the analytics surface stays
on-chokepoint.

## Modes (all off by default)
- **Compatibility (`TENANCY_ENABLED=false`)** — `scopeKey` no-ops → byte-identical
  to today. Verified: full existing suite green, unmodified.
- **Tenant (`TENANCY_ENABLED=true`)** — keys scope to the request/background
  tenant; missing tenant on a tenant-owned key throws (fail closed).
- **Dark-launch (`TENANCY_DARK_LAUNCH`)** — `get` reads legacy **and** tenant
  keys, reports mismatches via redacted telemetry, and **returns the legacy
  value** (no response change).
- **Dual-write (`TENANCY_DUAL_WRITE`)** — mirrors **idempotent** `set`/`del` to
  both legacy + tenant keys for migration validation. Deliberately NOT applied to
  non-idempotent ops (`incr/zadd/pfadd/hincrby`) — those would double-count; the
  migration copy + dark-launch compare cover them instead.

## Why the wrapper, not a new layer
The wrapper is the pre-existing single chokepoint (38 importers). Enforcing here
covers them all with one change and no call-site churn — the highest-leverage,
lowest-risk boundary.
