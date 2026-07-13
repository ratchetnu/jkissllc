# Tenant Migration Utility

Copy-only, reversible migration of legacy J KISS Redis keys to their
tenant-scoped form. **Never deletes legacy keys.** Safe by default — only
`migrate` writes, and it is guarded.

```
npx tsx scripts/tenant-migration/migrate.ts <command> [--tenant=jkiss] [--match='*'] [--batch=100]
```

| Command | Writes? | What it does |
|---|---|---|
| `inventory` | no | Enumerate + classify keys (tenant-owned / platform-global / already-scoped / name-derived) |
| `dry-run` | no | Report what a copy WOULD do — would-copy count + conflicts |
| `migrate` | **yes (guarded)** | Copy `legacy` → `t:{tenant}:legacy`; idempotent, batched, conflict-safe |
| `verify` | no | Confirm every tenant-owned key has a matching scoped copy |
| `rollback-plan` | no | Print the rollback manifest (scoped targets to delete) — does NOT delete |

## Safety

- `migrate` refuses unless `TENANT_MIGRATION_CONFIRM=1`.
- Against production (`VERCEL_ENV=production`) it **also** requires
  `TENANT_MIGRATION_PROD_OVERRIDE=1` — a separate, explicit override.
- Copy is **idempotent**: an existing equal target is skipped; an existing
  **different** target is a **conflict** and is never overwritten.
- Legacy keys are never modified or deleted. Rollback = delete the scoped targets
  (a separate, approved change).

## Model

`legacy key` → `t:{tenantId}:{legacy key}`. Platform-global families
(`opspilot:`, `platform:`, `ai:`, `rl:`) are skipped. Name-derived families
(`biz:`, `promo:`, `ship:`) are copied in legacy form and flagged; the
name→stable-id remap is a **separate** step (see
`docs/opspilot-os/tenant-isolation/07-name-derived-key-migration.md`).

Pure logic lives in `lib.ts` and is fully unit-tested
(`scripts/tenant-migration.test.ts`) against an in-memory store — no live Redis
needed to validate correctness.
