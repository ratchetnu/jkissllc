# 07 — Migration Safety Checklist

There is **no SQL and no classic schema migration** in this app. "Migration" means a
change to the shape of a persisted record (Redis/KV JSON blob), a key prefix, or a
tenancy key scoping. These changes are risky precisely because there is no schema to
enforce correctness — old and new shapes coexist in the store.

## The storage model (recap)

- Records: `prefix:{id}` → JSON blob; index: zset `prefix:index`; ids from an `incr`
  counter (see `app/lib/platform/updates/store.ts`, `bookings.ts`).
- Each record carries a `recordVersion` number. That is the migration contract.

## Before changing a record shape

- [ ] Bump `recordVersion` and handle **both** old and new versions on read.
- [ ] New fields are **optional** (or defaulted) so existing blobs still parse.
- [ ] Never rename/remove a field that live data depends on in the same release —
      add-new + read-both, migrate readers first, retire later.
- [ ] Reads are defensive: a `parse()` failure returns `null` and is handled, never
      throws into the request path.

## Before changing a key prefix or scoping

- [ ] Confirm whether the prefix is on the never-tenant-scoped allowlist
      (`app/lib/platform/tenancy/keys.ts`) — `platform:*` is intentionally global.
- [ ] Dual-read (new + legacy) during transition; only cut over legacy reads after the
      new path is verified.
- [ ] Tenancy migrations run behind explicit guards: `TENANCY_DUAL_WRITE`,
      `TENANT_MIGRATION_CONFIRM`, `TENANT_MIGRATION_PROD_OVERRIDE`. Never run a tenancy
      migration against production without the deliberate override.

## Reversibility

- [ ] The change can be rolled back by code alone (doc 06) without stranding data.
- [ ] If a backfill writes new keys, it is idempotent and re-runnable.
- [ ] You can identify and (if needed) clean up records the migration wrote.

## Validation

- [ ] Unit test the reader against **both** old and new record fixtures.
- [ ] Dry-run any backfill against a Preview / non-production data set first.
- [ ] Count records before/after; verify the index (`zcard`) matches expectations.

## Out of scope for this sprint

The Update Center foundation sprint adds **no** migration. The only new data model
(`app/lib/release/*`) is read-only and static/derived — it persists nothing and
requires no backfill.
