# 09 — Dark-Launch Validation (2026-07-15)

Preview: `feat/operion-tenant-safe-boundaries` @ `ff469d5`, deployment
`dpl_7uXNaT3gGRig1hQukptBvm3U6Nua` (isolated `OperionPreview` KV + `operion-preview-blob`,
`TENANCY_ENABLED=false`, `TENANCY_DARK_LAUNCH=true`). Production untouched.

## How dark-launch telemetry is inspected (no Redis counter — it's in the logs)

`recordTenantEvent()` (`app/lib/platform/observability/tenant-telemetry.ts`) emits a
**structured log line** `tenancy:<event>` with safe metadata (event, `keyFamily`,
`tenantId`, `correlationId`, `mismatchType`) — never values/PII. The `redis.ts` shadow-read
fires `tenancy:dark-launch-mismatch` whenever, under `TENANCY_DARK_LAUNCH`, a tenant-owned
key's legacy value differs from its (proposed) tenant-scoped copy.

**Inspection method (works headless, after traffic exists):** read Vercel **runtime logs**
filtered to `query:"dark-launch-mismatch"` / `environment:preview` (via the Vercel runtime-logs
API/MCP). No browser is needed to *read* the telemetry — only to *generate* it. So the
division of labor is: **owner (or a Playwright run) exercises the Preview workflows; then the
telemetry is read + analyzed from the logs.**

## Correct-build sweep — COMPLETE (2026-07-15)

Owner click-through on the tenant-boundaries Preview **`dpl_7U8amgqh2zTkNgopK3TnvwEZZt5r`**
(commit `fcf0736`, branch alias `jkissllc-git-feat-operion-tenant-…`). Telemetry read from
that deployment's Vercel runtime logs only.

| Metric | Value |
|---|---|
| Traffic on the exact deployment | **95 requests** (`/quote` 30, `/` 13, box-truck landing pages, `/track` + `/api/track`, `/reviews`, `/api/intake/config`) |
| HTTP status profile | 200 (67), 304 (42), 204 (3), + benign 3xx redirect — **zero 4xx, zero 5xx** |
| `tenancy:*` events (dark-launch-mismatch, fail-closed, cross-tenant-denial, missing-tenant-context, key-gen-failure, legacy-fallback) | **0** |
| warnings / errors / fatal | **0** |
| **Dangerous mismatches** (value / serialization / stale / cross-tenant / unsafe-fallback / resolution-failure) | **0 — none** |
| Preview using Production resources | none (isolated `OperionPreview` KV + `operion-preview-blob`) |
| Verdict | ✅ **CLEAN — no blockers; byte-identical behavior confirmed on live traffic** |

**Coverage note (honest scope):** the live sweep exercised the customer read paths + the
`/quote` wizard load. The write/admin/payment boundaries (Book Now submit, photo upload, admin
Book Now Requests, AI enqueue, Stripe checkout/webhook, token routes) are the ones this branch
most changed — and by design dark-launch **read-compare** telemetry cannot surface write-path
changes. Those boundaries are validated by the **684-case test suite** (blob-keys, tenant-resolve,
stripe-tenant, public-route-tenant, public-token-routes, ai-tenant-scope, name-derived) + the
fail-closed unit tests, and the live run confirms they run **without error or fail-closed
warning while `TENANCY_ENABLED=false`**. An optional future admin-side pass (open Book Now
Requests) would add read-compare coverage of the `bk:` booking-key family (expected: benign
`missing-tenant-copy`, like `pv:`).

**Sweep status: COMPLETE** — zero Critical/High/Medium/Low mismatches; zero errors. No fix required.

## Earlier partial result (superseded — hardening-branch traffic)

| Metric | Value |
|---|---|
| Telemetry mechanism | ✅ confirmed firing |
| Workflows exercised | **1 of 20** — admin dashboard read (`/api/admin/analytics`, reached during the owner's earlier Preview click-through) |
| Dark-launch mismatches seen | `pv:` (page-view counters) only |
| Mismatch type | `missing-tenant-copy` only (benign — legacy key exists, tenant copy never written) |
| **Dangerous mismatches** (`value-mismatch` / `serialization-mismatch` / `stale-tenant-copy` / `cross-tenant-denial`) | **0** |
| Verdict for exercised paths | ✅ clean (only the expected pre-migration signal) |
| Remaining 19 workflows | ⏳ NOT YET EXERCISED (need Preview traffic) → NOT VERIFIED |

### Finding DL-1 (LOW / migration-required, not a defect)
`pv:*` (and by the same logic `uv:*`) site-analytics counters emit `missing-tenant-copy`:
if `TENANCY_ENABLED` flips, `scopeKey` prefixes them to `t:jkiss:pv:*`, which is empty until
backfilled — analytics would read zero, not wrong. **Action:** include the analytics
counter families in the pre-flip data migration (backfill or accept-reset). Not customer/
financial data; low severity. This is the expected dark-launch purpose: it inventories which
tenant-owned key families need migration before a flip. It is NOT introduced by this sprint
(analytics keys already route through the chokepoint).

## To complete the sweep (owner or Playwright)

Exercise these Preview-only workflows with test data (no live SMS/email/charges), then ping
me to read + classify the resulting `tenancy:*` telemetry:

1. Book Now submit · 2. photo upload · 3. admin Book Now Requests · 4. admin photo view ·
5. AI enqueue + result read · 6. quote create · 7. quote status token · 8. quote accept
(test) · 9. Stripe test checkout · 10. Stripe test webhook (`stripe trigger`) · 11. scheduling ·
12. route assignment · 13. crew confirm token · 14. uniform/completion photo · 15.
payment-proof upload · 16. applicant doc upload/read · 17. AI audit read · 18. background job ·
19. cron test path · 20. alert test path.

**Pass criteria:** every workflow produces only `missing-tenant-copy` (or `ok`, which isn't
logged) — i.e. **zero** `value-mismatch` / `serialization-mismatch` / `stale-tenant-copy` /
`cross-tenant-denial` / `key-gen-failure` / `unauthorized-global-access`. Any of those is a
High/Critical to reproduce + fix on this branch.

**Access options for automation:** a Vercel *Protection Bypass for Automation* token enables a
Playwright run to reach the SSO-gated Preview headlessly; without it, the owner drives the
click-through in a logged-in browser. Do not disable Vercel protection globally; do not commit
bypass tokens.
