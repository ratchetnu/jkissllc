# 05 — J KISS Migration Plan

**Tool:** `scripts/tenant-migration/` (`lib.ts` pure logic + `migrate.ts` CLI +
README) · **Tests:** `scripts/tenant-migration.test.ts`.

## Model
Copy-only: `legacy` → `t:jkiss:legacy`. **Legacy keys are never deleted.**

## Commands (safe by default)
| Command | Writes? | Behavior |
|---|---|---|
| `inventory` | no | SCAN + classify (tenant-owned / global / scoped / name-derived) |
| `dry-run` | no | Report would-copy count + conflicts |
| `migrate` | **yes (guarded)** | Idempotent, batched, conflict-safe copy |
| `verify` | no | Every tenant-owned key has a matching scoped copy |
| `rollback-plan` | no | Print scoped targets to delete (does not delete) |

## Guarantees (tested against an in-memory store)
- **Dry-run makes zero changes.**
- **Idempotent:** re-running skips equal existing targets (copied=0).
- **Conflict-safe:** a differing existing target is reported, **never overwritten**.
- **Resumable:** idempotency makes re-runs safe to resume.
- **Bounded batches** + `onProgress` structured logs.
- **Checksum** (SHA-256 prefix) comparison for verify + conflict detection.
- **Rollback manifest** lists every created target (legacy untouched).

## Production safety
`migrate` refuses unless `TENANT_MIGRATION_CONFIRM=1`, and refuses production
(`VERCEL_ENV=production`) unless `TENANT_MIGRATION_PROD_OVERRIDE=1` is **also** set.
**No backfill was run** in this sprint.

## Name-derived families
`biz/promo/ship` are copied in legacy form and flagged; the name→stable-id remap
is a **separate** step (doc 07).
