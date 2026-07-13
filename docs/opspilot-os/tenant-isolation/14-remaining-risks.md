# 14 — Remaining Risks

| Risk | Severity | Mitigation / status |
|---|---|---|
| **Public-token routes have no tenant context** (booking/route/invoice/client `[token]`) — resolving tenant needs the record, which needs the tenant | High (blocks Stage 7 for public routes) | Deferred: add a global `token → tenant` index (platform-scoped) so a token resolves its tenant before the scoped read. Documented; not built. |
| **Per-handler context not yet applied** to admin/portal routes | Medium | `withTenantContextFromRequest` provided; applying it + enabling the flag is Stage 7. Until then, enabling `TENANCY_ENABLED` fails closed (safe, but breaks preview until wired). |
| **Name-derived entity keys** (`biz`/`payByBusiness`/`promo`/`ship`) still legacy-form | Medium | Boundary is safe (opaque tenant id); entity id-remap is a separate cautious data step (doc 07). |
| **Blob paths not tenant-prefixed** | Medium | Documents encrypted; path prefixing is a Stage-8 storage task (doc 08). |
| **`learn:*` pricing calibration** becomes tenant-scoped only after migration | Medium | Prefixed by the chokepoint when tenancy on; copy migration moves existing state. Until then, single-tenant so no leak. |
| **Dual-write limited to set/del** | Low | Intentional (non-idempotent ops would double-count); migration copy + dark-launch cover the rest. Documented. |
| **Rate-limit / AI-cost treated as global** | Low | Deliberate (pre-auth infra; AI cost already tenant-embedded). Revisit if per-tenant rate limiting is needed. |

## Not a risk (verified)
Cross-tenant key collision (A≠B, tested); forged `x-tenant-id` (ignored — session
authoritative); silent global fallback (fail-closed); accidental direct Upstash or
raw-prefix construction (CI gate).
