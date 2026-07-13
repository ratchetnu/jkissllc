# 09 — Security Tests

36 new tests across 7 files; the full suite is **332/332**.

| File | Covers |
|---|---|
| `tenant-keys.test.ts` | scoping, allowlist, idempotency, fail-closed, `normalizeTenantId`, helpers, determinism |
| `tenant-isolation.test.ts` | A≠B keys, A can't read/overwrite B, fail-closed, global allowlist, **forged `x-tenant-id` ignored**, session identity authoritative, legacy vs tenant mode |
| `tenant-migration.test.ts` | classify, **dry-run no-op**, migrate+verify, **idempotent**, **conflict surfaced**, rollback manifest complete, checksum |
| `dark-launch.test.ts` | mismatch classification (incl. serialization vs value), summary tally |
| `name-derived-keys.test.ts` | display name rejected as boundary, rename doesn't change identity, `stableId`, `looksNameDerived` |
| `bypass-detection.test.ts` | **CI gate:** no direct Upstash outside `redis.ts`; no raw prefix outside `keys.ts`; the 2 bypass files now use the wrapper |
| (existing) `platform-tenancy.test.ts` | principal, context, `tenantKey` (now delegating) |

## Required-coverage checklist (all satisfied)
Tenant A cannot read/overwrite B ✓ · missing context fails closed ✓ · forged
header ignored ✓ · session identity authoritative ✓ · platform-global only via
allowlist ✓ · legacy mode preserves behavior ✓ · tenant mode scopes ✓ ·
dark-launch detects mismatches ✓ · migration dry-run makes no changes ✓ ·
migration idempotent ✓ · conflicts surfaced ✓ · rollback manifest complete ✓ ·
name changes don't change identity ✓ · cron/webhook resolution fails closed ✓ ·
AI/approvals/insights/events preserve tenant identity ✓ (platform-foundation).

## CI gate
`bypass-detection.test.ts` fails the build if a new tenant-owned Redis call
bypasses the approved access layer or hand-builds a tenant prefix.
