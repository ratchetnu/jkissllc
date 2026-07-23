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

---

# Stable-id payroll rekey

The **separate step** referred to above, for the one name-derived key a prefix
cannot reach: `Staff.payByBusiness` is keyed by the normalized business **name**,
inside a JSON value. A rename therefore silently drops every crew member's
per-business pay override for that business — they quietly fall back to their
default rate.

This assigns each business an opaque `stableId` and **adds** a matching override
keyed by that id. Same doctrine as `migrate.ts`: copy-only, idempotent,
conflict-detecting, never deletes.

```
npx tsx scripts/tenant-migration/payroll-rekey.ts <command> [--limit=500]
```

| Command | Writes? | What it does |
|---|---|---|
| `plan` | no | Report ids to mint, overrides to add, and every skip with its reason |
| `apply` | **yes (guarded)** | Mint ids + add stableId-keyed overrides; never deletes a legacy key |
| `verify` | no | Confirm every legacy override on a known business has an **equal** stableId twin |

Same two switches as `migrate.ts`: `TENANT_MIGRATION_CONFIRM=1`, plus
`TENANT_MIGRATION_PROD_OVERRIDE=1` against production.

## What it refuses to do

Three cases are reported as **skips** and left for a human, because each is money:

- `no_such_business` — an override naming a business with no record. Kept as-is.
- `value_conflict` — a stableId entry already exists with a **different** amount.
- `invalid_value` — not a non-negative number.

## Reading order after `apply`

`resolveCrewPay(staff, name, stableId?)` reads the id first and the name second.
Until a business is migrated, no pay map holds a stableId key and no caller passes
one — so the resolver takes the identical path it always did. Rollback is
"delete the new keys": the legacy entries were never touched.

Pure logic lives in `payroll-lib.ts`, unit-tested in
`scripts/stable-id-payroll.test.ts` — including a test that asserts the rename
defect itself, so it cannot be declared fixed without evidence.
