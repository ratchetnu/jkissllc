# Tenant Phase-1 Provisioning

Deterministic, reversible backfill that records the reference tenant (J KISS LLC)
in the new Phase-1 stores. **Additive and reversible.** Legacy keys are never
touched; only `apply` and `rollback` write, and both are guarded.

```
npx tsx scripts/tenant-phase1/provision.ts <command>
```

| Command | Writes? | What it does |
|---|---|---|
| `plan` | no | Print the exact ordered writes an apply would make |
| `rollback-plan` | no | Print the exact deletes a rollback would make |
| `apply` | **yes (guarded)** | Idempotently write the seeds; conflict-safe (never overwrites a differing value) |
| `verify` | no | Confirm every seeded record exists and equals its seed |
| `rollback` | **yes (guarded)** | Delete only the seeded targets |

## What it seeds (reference tenant only)

1. Tenant registry record — `platform:tenant:jkiss` (+ `platform:tenant:index`)
2. Owner membership — `platform:membership:jkiss:owner` (+ `byuser`/`bytenant` indexes)
3. Tenant-scoped branding — `t:jkiss:settings:branding`

All three are seeded byte-for-byte from `JKISS_TENANT` / `COMPANY`, so provisioning
records today's production identity **without changing any behavior**. Pre-seeding
the *scoped* branding key means a later `TENANCY_ENABLED` flip is byte-identical for
J KISS.

## Safety

- `apply` / `rollback` refuse unless `TENANT_PHASE1_CONFIRM=1`.
- Against production (`VERCEL_ENV=production`) they **also** require
  `TENANT_PHASE1_PROD_OVERRIDE=1` — a separate, explicit override. **Do not run
  against production in this phase.**
- `apply` is **idempotent**: an equal target is skipped; a **different** existing
  value is a **conflict** and is never overwritten (exit code 1).
- `rollback` deletes **only** the seeded targets. Legacy keys are never modified.
- All access goes through the app Redis chokepoint (`app/lib/redis.ts`) — no direct
  Upstash access.

## Determinism

The plan is built from fixed seeds with no `Date.now()` and no random ids
(membership id is `mbr_jkiss_owner`), so `plan` shows exactly what `apply` will do
and re-running is a no-op. Pure logic in `lib.ts` is unit-tested against an
in-memory KV in `scripts/multitenant-phase1.test.ts`.
