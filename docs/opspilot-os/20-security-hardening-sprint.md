# 20 — Security Hardening Sprint (Part 5) — Operion

> Changes applied originally on branch `opspilot/platform-foundation` (legacy
> internal identifier), 2026-07-12. No secrets were rotated or displayed. Each item
> is surgical and independently revertible.
>
> _(Updated 2026-07-14 — status since this sprint, verified on `main` + prod:)_
> - ✅ **Shipped:** all items §1–§7 below are on `main` + prod. Additionally: a
>   **min-16-char secret length check** on `ADMIN_SESSION_SECRET` is enforced
>   (`app/api/admin/_lib/session.ts:67`); the CI job is now a **blocking** gate
>   (`.github/workflows/ai-regression.yml`, tsc → full suite → `next build`); and
>   **bypass-detection** (`scripts/bypass-detection.test.ts`) is a blocking gate
>   proving every Redis key routes through `scopeKey()`.
> - ⚠️ **Still open (identity gap):** a **single shared global HMAC secret**
>   (`ADMIN_SESSION_SECRET`) and a **single shared owner `ADMIN_PASSWORD`** (no
>   per-owner identity) remain — the C2/R3 risk is only **partially** resolved
>   (sessions now carry `tid` and 104 handlers establish tenant context, but there
>   is still one shared owner credential). See `10-security-risk-register.md`.
>   `doc-crypto` derives from `DOC_ENCRYPTION_KEY` (set) then `ADMIN_SESSION_SECRET`.

## Webhook & cron endpoint inventory

| Endpoint | Auth mechanism | Verification | Failure behavior (AFTER) | Replay protection | Rate limit | Tenant resolution | Audit |
|---|---|---|---|---|---|---|---|
| `POST /api/webhooks/stripe` | Stripe signature | `constructEvent(rawBody, sig, secret)` | 400 bad sig / 503 no secret (already fail-closed) | idempotent by session id (`record-payment.ts`) | webhook (signature) | single-tenant | payment ledger |
| `POST /api/webhooks/twilio/sms` | Twilio HMAC-SHA1 **or** shared `?key=` | `verifyTwilioSignature` / `timingSafeEqual` | **503 when neither secret configured (CHANGED)**; 403 on mismatch | dedup by `MessageSid` (`seenProviderMessage`) | webhook | single-tenant | message log + owner alert |
| `POST /api/webhooks/email` | shared secret `?key=` | `timingSafeEqual` | **503 when secret unset (CHANGED)**; 403 on mismatch | dedup by `messageId` | webhook | single-tenant | message log + owner alert |
| `GET /api/cron/daily` | `Bearer CRON_SECRET` | string compare | **401 when secret unset (CHANGED)** | one-shot dedupe stamps per booking | n/a (auth) | single-tenant | per-record audit |
| `GET /api/cron/reminders` | `Bearer CRON_SECRET` | string compare | **401 when secret unset (CHANGED)** | occurrence dedup (`setNxPx`) | n/a (auth) | single-tenant | reminder instances |

## Changes applied

### 1. Fail-closed webhook authentication (M1)
- `app/api/webhooks/twilio/sms/route.ts` — previously **warned and processed** when
  neither `TWILIO_AUTH_TOKEN` nor `TWILIO_WEBHOOK_SECRET` was set. Now returns
  **503** (rejects) before any work. Mismatch still 403.
- `app/api/webhooks/email/route.ts` — previously warned and processed when
  `EMAIL_WEBHOOK_SECRET` was unset. Now returns **503**.
- The auth check runs before any Redis/side-effect, so rejection is side-effect-free.

### 2. Fail-closed cron authentication (L1)
- `app/api/cron/daily/route.ts` and `app/api/cron/reminders/route.ts` — `authorized()`
  previously returned `true` when `CRON_SECRET` was unset; now returns `false`
  (→ 401). Prod is unaffected (Vercel injects the secret); misconfigured
  environments now fail safe instead of open.

### 3. CSPRNG reminder acknowledgement token (M2)
- `app/lib/reminders.ts` — `tok()` (the sole bearer credential for the login-less
  `/api/ack/[token]` endpoint) moved from `Math.random` (predictable) to
  **256-bit CSPRNG hex** via `randomUUID()`, matching the token pattern in
  `bookings.ts`/`routes.ts`. Exposed as `newAckToken()` for testing. Existing
  issued tokens continue to resolve; only newly minted tokens change format.
  `rid()`/`iid()` intentionally remain on `Math.random` (internal ids, never
  public capabilities) — documented in code.

### 4. Audit attribution groundwork (H3)
- `app/lib/routes.ts` — `AuditEntry` gains optional `actorId`/`actorRole`; new
  `pushAuditFor(r, {sub, role}, actor, action)` records **which named user** acted.
  Existing `pushAudit(r, 'admin', …)` callers are unchanged (still coarse). Full
  rollout to all ~40 call sites is **deferred** (a later phase) to keep this
  sprint low-risk; the mechanism and the attributed helper are in place now.

### 5. Anti-spoofing tenant header (defense-in-depth)
- `proxy.ts` — strips any inbound `x-tenant-id` header so a client can never
  supply its own tenant identity; tenant is always derived server-side from the
  signed session.

### 6. No frontend-only authorization (H2)
- `scripts/authorization-coverage.test.ts` asserts **every** admin API route calls
  a server-side guard (`requireSession`/`requirePermission`/`requireAdmin`/
  `requireStaffSession`/`requirePrincipal`/`requireTenantSession`/`getPrincipal`),
  with only `auth`+`logout` allowlisted. This is now a CI gate. The full
  conversion of coarse `requireSession` routes to fine `requirePermission`
  (matrix-exact enforcement) is **deferred** to a follow-up; the coverage test
  prevents any *un*guarded route from shipping in the meantime.

### 7. No fail-open on the tenant boundary
- `app/lib/platform/tenancy/tenant-store.ts` — with tenancy enabled, `tenantKey`
  **throws** on a missing tenant and `resolveTenantId` returns `null` (never a
  shared default), so future tenant-scoped code fails closed.

## Explicitly NOT done (by design / deferred)
- No secret rotation, no secret display.
- Rate-limiter fail-open on Redis outage (L2) — accepted for availability;
  revisit later.
- Public blob store residual plaintext re-seal (M4) — a data task, later phase.
- Full `pushAudit` → `pushAuditFor` migration across all callers.

## Verification
`tsc --noEmit` clean · full suite **239/239 green** at authoring time (incl. 5 new
fail-closed tests + authorization-coverage) · eslint clean on all changed files.
_(Updated 2026-07-14: the suite has since grown to **586 cases / 75 files** — now
including tenant-isolation, bypass-detection, rbac, authorization-coverage,
security-hardening and AI-regression tests — and runs as a **blocking** CI gate
alongside `tsc` and `next build`.)_
