# 15 — Next Sprint Recommendation

The isolation **mechanism** is complete and enforced. The next sprint makes it
**usable end-to-end** so J KISS can actually run under `TENANCY_ENABLED` in
preview, then production.

## Recommended: "Tenant Cutover Enablement"
1. **Per-request context** — apply `withTenantContextFromRequest` to admin +
   portal handlers (a wrapper or a small `proxy.ts`-set trusted header consumed by
   a handler helper). Enable it under the flag in preview.
2. **Public-token → tenant resolution** — a platform-scoped `token → tenantId`
   index so `booking/route/invoice/client [token]` routes resolve their tenant
   before the scoped read. Backfill it during migration.
3. **Name-derived entity migration** — `biz:{name}` → `biz:{id}` (+ `byname`
   lookup) and rewrite `Staff.payByBusiness` maps to id-keys, with dual-read.
4. **Preview cutover** — run Stages 1–3 (dry-run → copy → dark-launch) on a
   preview dataset; drive the app with `TENANCY_ENABLED=true`; run the isolation
   suite live.
5. **Blob path prefixing** — `t/{tid}/…` for uploads (Stage 8 prep).

## Exact next prompt
> "Approved. Begin the OpsPilot **Tenant Cutover Enablement** sprint on branch
> `opspilot/tenant-cutover` (from `opspilot/tenant-isolation`), jkissllc only.
> Wire `withTenantContextFromRequest` into admin+portal handlers behind
> `TENANCY_ENABLED`; add a platform-scoped `token→tenant` index for public routes;
> implement the `biz`/`payByBusiness` name→id migration with dual-read; run the
> migration dry-run + dark-launch against an isolated preview dataset; drive the
> app with `TENANCY_ENABLED=true` in preview and run the isolation suite live. Do
> NOT enable in production, do NOT run the prod backfill, do NOT delete legacy
> keys. Show me the diff and the preview validation results first."
