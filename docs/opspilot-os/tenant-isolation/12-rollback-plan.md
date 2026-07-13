# 12 — Rollback Plan

Every stage is reversible; the destructive step (legacy deletion) is last and
separately approved.

## Code
All changes are additive or flag-gated. Rollback = revert the branch (or turn the
flag off). No deploy occurred.

## Flags (instant rollback)
- `TENANCY_ENABLED=false` → keys revert to legacy form; reads/writes hit the
  original keys. Since legacy keys were never deleted, data is intact.
- `TENANCY_DARK_LAUNCH=false` → stops shadow reads.
- `TENANCY_DUAL_WRITE=false` → stops mirroring.

## Data (migration)
- Copy is **non-destructive** — legacy keys are never modified or deleted.
- To undo a copy: run `rollback-plan` to get the manifest of scoped targets, then
  delete **only** those targets under a separate approved change. Legacy keys
  remain the source of truth throughout.
- Conflicts are never overwritten, so a rollback never loses pre-existing tenant
  data.

## Point of no return
Only **Stage 10** (legacy key deletion) is irreversible without a backup, and it is
gated behind a separate change with `TENANT_MIGRATION_PROD_OVERRIDE`. Do not reach
it until Stage 9 has proven no legacy dependency over a stability window.

## Verification before any rollback-forward
`verify` must show `missing=0, mismatch=0` before enabling tenant reads (Stage 7);
if not, stop and stay on legacy.
