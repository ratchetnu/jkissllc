# 19 — Assessment Verification (Part 1)

> Re-inspection of the blueprint's cited claims against live code on branch
> `opspilot/platform-foundation`, 2026-07-12. **The blueprint is NOT materially
> inaccurate** — it is confirmed on every load-bearing point, with two wording
> corrections and a handful of precision notes. Safe to proceed.

## Confirmed findings (spot-checked against code)

| Claim | Verified at |
|---|---|
| Redis-first persistence, no SQL | `app/lib/redis.ts` (REST wrapper, `GET/SET/…/EVAL`, no SCAN) |
| Blob storage for files | `@vercel/blob` usage; identity docs sealed in `app/lib/doc-crypto.ts` |
| Auth = dual-path, HMAC cookie, 2h abs + 10min idle | `app/api/admin/_lib/session.ts:5-6,114-131` |
| RBAC live: `admin/manager/crew`, ~50 perms, `can()` | `app/lib/rbac.ts:10,21-134` |
| Session payload `{sub,role,staffId}`, **no tenant** (pre-change) | `session.ts` `SessionPayload` |
| Redis isolation chokepoint = `call()` | `app/lib/redis.ts` `call()` |
| Two Redis bypasses | `app/api/track/route.ts`, `app/api/admin/analytics/route.ts` (inline fetch) |
| AI governance = `runAiTask`, `writes:false` | `app/lib/ai/service.ts`, `app/lib/ai/registry.ts` |
| Audit actor = coarse `'admin'` | `app/lib/routes.ts:334/358/377/386/461` |
| CI advisory (does not gate deploy) | `.github/workflows/ai-regression.yml:6-10` |
| Stripe key shared with ClaimGuard, customer-facing | `app/lib/stripe.ts:3` |
| Route + Booking are separate money domains | `app/lib/routes.ts` vs `app/lib/bookings.ts` |
| §1 defects (JK-INV, ID fallback, pwd compare, blob PII) FIXED | confirmed in prior recon; pwd `secretsMatch` at `auth/route.ts:64-75` |

## Corrected findings

1. **AsyncLocalStorage cannot bridge `proxy.ts` → route handlers.** The blueprint
   (docs 05/14/16) said to "establish the tenant context in middleware." That is
   not how Next works: `proxy.ts` (Edge runtime) and route handlers are separate
   invocations with no shared call stack, so an ALS store set in the proxy does
   not propagate. **Corrected approach (implemented):** tenant identity is carried
   in the signed session token (`tid`), resolved by `requireTenantSession`, and
   the ALS context (`app/lib/platform/tenancy/context.ts`) is established
   **per-handler** via `runWithTenant(...)`. `proxy.ts` only performs a safe
   anti-spoofing step (stripping any inbound `x-tenant-id` header). `context.ts`
   imports `node:async_hooks` and is therefore never imported from `proxy.ts`.
2. **`middleware.ts` is `proxy.ts`.** Next 16 renamed the convention; the apex→www
   redirect + RBAC edge gate live in `proxy.ts:13-59` (blueprint already noted
   this in doc 01; restated here since Part 1 lists "middleware").

## Newly discovered / precision findings

- **Reminder id generators**: only `tok()` (the public ack bearer token) was
  security-relevant; `rid()`/`iid()` also use `Math.random` but are internal
  record ids never exposed as a capability — left as-is by design
  (`app/lib/reminders.ts:145-147`, now documented in code).
- **`pushAudit` signature** takes `actor: AuditEntry['actor']` (a coarse string
  union), with call sites passing the literal `'admin'` (`routes.ts:334` etc.).
  Attribution therefore needs an *additive* field, not a signature break — done
  via optional `actorId`/`actorRole` + a new `pushAuditFor` helper.
- **No `src/` directory exists**; the repo convention is `app/lib/`. New platform
  code lives at `app/lib/platform/` (not the prompt's suggested `src/platform/`).
- **Local `next build` is expected to fail** on `next/font/google` network fetch
  (pre-existing, env-related, prod-unaffected). Local gates are therefore
  `tsc --noEmit` + `npm test` + `npm run lint`, matching the repo's own
  `predeploy` philosophy. This is a known environment quirk, not a code defect.
- **Every admin API route already calls a server-side guard** (only `auth` +
  `logout` are correctly unauthenticated) — now locked by a CI test
  (`scripts/authorization-coverage.test.ts`).

## Unresolved implementation assumptions

- Full production env completeness (webhook/cron secrets set in prod) — mitigated
  regardless by the fail-closed changes (they no longer depend on it).
- Whether any consumer reads the two Redis-bypass analytics paths in a way that
  will complicate later prefixing — deferred to the isolation phase (unchanged).
- Backup/recovery durability guarantees of Upstash/Blob — external, unverified
  (tracked in `17-open-questions.md`).

**Conclusion:** proceed. No blueprint claim required a material reversal.
