# 10 — Security Risk Register (Phase 9) — Operion Platform

> **Hardening update 2026-07-14** (branch `fix/operion-production-hardening`, not merged):
> the manager-over-privilege gap (audit H-SEC-1) is **RESOLVED** — 38 admin routes moved
> from coarse `requireSession` to `requirePermission`/`requireStaffSession`/`requireAdmin`,
> so managers no longer reach admin-only pay/invoices/profitability/settings or decrypted
> applicant documents at the API. Server-side enforced; `scripts/manager-authz.test.ts` +
> `scripts/authorization-coverage.test.ts` prove it. Still open: single global
> `ADMIN_SESSION_SECRET` + single shared owner `ADMIN_PASSWORD` (no per-owner identity),
> and no CSP (M-SEC-2). See `CHANGELOG.md`.

> Threat-focused review, cited to `file:line` on `~/jkissllc@main`.
> Each risk: evidence · impact · exploitation · mitigation · priority · blocks
> commercialization? · **status (2026-07-14)**.
> _(Updated 2026-07-14: platform re-branded **Operion**; the `opspilot:*` Redis
> family and `docs/opspilot-os/` path are kept as **legacy internal identifiers**.
> Several tenancy risks below moved from OPEN to **PARTIAL** now that the tenant
> context/chokepoint shipped — each item is tagged **resolved / partial / open**.
> Identity risks that remain — single global HMAC secret and single shared owner
> password — are still fully **OPEN**; do not read the tenancy progress as
> "multi-tenant auth is done.")_

## 0. Fundamentals that are already SOLID (FACT — preserve)

- **Constant-time secret compares** — session HMAC (`session.ts:79-84`), admin
  password `secretsMatch` (`auth/route.ts:64-75`), Twilio/email webhook
  `crypto.timingSafeEqual`.
- **CSPRNG bearer tokens** — 256-bit hex for booking/route/invoice/portal/claim
  (`bookings.ts:322-324`, `routes.ts:219-221`, etc.).
- **Identity-doc encryption** — AES-256-GCM, fail-closed, decrypt only behind
  `requireSession` + path-traversal guard + `Cache-Control: private, no-store`
  (`doc-crypto.ts`, `careers/doc/route.ts`).
- **Full admin-route authorization coverage** — every admin route guards except
  `auth`/`logout` (correctly).
- **No secret logging** — grep of `console.*` + `process.env` = zero.
- **The four prior roadmap §1 defects are all FIXED** (see §9).

## 1. Risk register

### CRITICAL — all blockers for a second tenant on shared infra

**C1 — Tenant isolation chokepoint — mechanism SHIPPED, activation pending.**
_(Status 2026-07-14: **PARTIAL** — was OPEN "all keys global.")_
- Evidence: `app/lib/redis.ts` now routes every key through `scopeKey()`
  (`app/lib/platform/tenancy/keys.ts`), **fail-closed** when `TENANCY_ENABLED` is on
  without a tenant context; the two former bypasses (`app/api/track`,
  `app/api/admin/analytics`) are on the wrapper; a **blocking CI gate**
  (`scripts/bypass-detection.test.ts`) forbids direct `KV_REST_API_*` use.
- Residual exploit surface: the flag is **off** in prod (live no-op, byte-identical),
  so at the data level keys are still physically un-prefixed until the migration runs.
  Blob paths are **not** scoped (`app/api/upload/route.ts:27`) and `ai:*`/`opspilot:*`
  stay platform-global — a second live tenant would still commingle files + AI state.
- Mitigation remaining: run the data migration under DARK_LAUNCH→DUAL_WRITE;
  tenant-scope Blob paths; validate the dark-launch preview telemetry.
- Priority: **P0.** Blocks commercialization: **Yes (until activated).**

**C2 / R3 — Session tenant scoping — PARTIALLY RESOLVED; global secret + shared
owner password REMAIN open.**
_(Status 2026-07-14: **PARTIAL**.)_
- Resolved: `SessionPayload` now carries a `tid` claim
  (`app/api/admin/_lib/session.ts`); the resolved `Principal` carries `tenantId`
  (pre-tenancy tokens resolve to `DEFAULT_TENANT_ID` for single-tenant continuity);
  **104 request handlers establish per-request tenant context** via `withTenantRoute`.
  The min-length guard on the signing secret is now **enforced** — `getSecret()`
  throws if `ADMIN_SESSION_SECRET` is unset or `< 16` chars (`session.ts:67`).
- **Still OPEN:** a **single global `ADMIN_SESSION_SECRET`** signs every tenant's
  HMAC token (no per-tenant signing key), and a **single shared owner
  `ADMIN_PASSWORD`** is the owner identity for all tenants (`app/api/admin/auth/route.ts`)
  — there is **no per-owner identity**. On a shared apex domain a forged/leaked token
  or the one owner password is still cross-tenant. Cookie name `jk_admin_session`
  is also still global.
- Note: doc-crypto prefers `DOC_ENCRYPTION_KEY` (set) then derives from
  `ADMIN_SESSION_SECRET` via HKDF (`app/lib/doc-crypto.ts:16-17,45,53`) — so the
  global secret also underpins document encryption when `DOC_ENCRYPTION_KEY` is absent.
- Mitigation remaining: per-tenant (or rotated per-tenant-derived) signing key;
  replace the shared owner password with per-owner identities; per-tenant cookie scope.
- Priority: **P0.** Blocks: **Yes** (the identity half).

**C3 — Cross-tenant data leak via name-derived keys & global AI calibration.**
_(Status 2026-07-14: **OPEN** — chokepoint scopes id-keyed families, but these
name-derived collisions are unfixed and are a named activation blocker.)_
- Evidence: `biz:{name}` (`businesses.ts:41`) + `Staff.payByBusiness` map keys
  (`staff.ts:36`); `msg:phone:{e164}`; `learn:*` global (`job-learning.ts:41-42`);
  `ai:*` prompts/telemetry platform-global by allowlist.
- Impact/exploit: two tenants with the same client name overwrite each other's
  contract rates and payroll maps; two tenants texting the same consumer number
  merge threads; one tenant's job outcomes train another's pricing.
- Mitigation: id-based keys + tenant prefix + `learn:*`/`ai:*` scoping (data
  migration, `09-...` §4b). The `t:{tid}:` prefix alone does **not** fix these —
  they need a data rewrite.
- Priority: **P0.** Blocks: **Yes.**

### HIGH

**H1 — Stripe key shared with ClaimGuard, 100% customer-facing.**
- Evidence: `stripe.ts:3` ("Single Stripe account shared with ClaimGuard");
  6 call sites all `mode:'payment'`.
- Impact: SaaS billing on the same key commingles platform revenue with tenant
  revenue; no per-tenant payout isolation.
- Mitigation: **Stripe Connect** (destination charges / `stripeAccount`),
  reshapes all 6 call sites; platform billing on a separate product.
- Priority: **P1** (before first paid external tenant). Blocks: **Yes.**

**H2 — RBAC enforcement drift (declared ≠ checked).**
- Evidence: ~65 admin routes use coarse `requireSession`; ~20 permissions
  (`equipment:assign`, `businesses:manage`, `routes:manage`, `crew:assign`,
  `applicants:*`, `reports:view`, `profitability:view`…) declared in
  `rbac.ts:84-134` but never checked; e.g. `admin/reports`, `disposal`, `claims`
  gate only on `requireSession`.
- Impact/exploit: a `manager` reaches surfaces the matrix does not grant;
  least-privilege/enterprise/per-plan gating cannot be trusted.
- Mitigation: replace coarse guards with `requirePermission`; add a test that
  asserts every route's guard matches the matrix.
- Priority: **P1.** Blocks: Partially.

**H3 — Audit attribution gap.**
- Evidence: per-record `pushAudit(r,'admin',…)` (`routes.ts:301`) logs a literal
  `'admin'`; central attributed audit (`audit.ts`) covers only comms/reminders.
- Impact: for most operational + financial mutations you cannot prove *which*
  named user acted — fails multi-user accountability and enterprise audit needs.
- Mitigation: thread `Principal.sub` into `pushAudit`; widen central audit to
  routes/staff/finance/claims; backfill legacy as `legacy:admin`.
- Priority: **P1.** Blocks: Partially.

### MEDIUM

**M1 — Webhooks fail OPEN if their secret env is unset.**
- Evidence: Twilio processes unverified with only `console.warn` if neither
  `TWILIO_AUTH_TOKEN` nor `TWILIO_WEBHOOK_SECRET` set (`twilio/sms:74`); email
  likewise (`email:35-37`). (Stripe correctly hard-fails, `stripe:14`.)
- Impact/exploit: missing env → forge inbound messages, pause reminder
  automation, spoof owner alerts, toggle `sms:optout`.
- Mitigation: fail-closed — reject if the verifying secret is absent.
- Priority: **P1** (cheap). Blocks: No (config-gated), but do it.

**M2 — Reminder ack bearer token uses `Math.random`.**
- Evidence: `reminders.ts:147` `tok()` = two `Math.random().toString(36)`; sole
  capability for public `app/api/ack/[token]` (GET leaks crew name + message;
  POST forges acks).
- Impact/exploit: V8 `Math.random` state is recoverable → predict tokens → read
  minor PII + forge task acknowledgements.
- Mitigation: switch to `crypto`-based token (match the CSPRNG pattern used
  everywhere else).
- Priority: **P1** (cheap). Blocks: No.

**M3 — No PII redaction / prompt-injection defense in AI.**
- Evidence: raw customer/review/message text into prompt vars
  (`message/route.ts:29-36`, `review-reply/route.ts:12-19`); no injection filter.
- Impact/exploit: malicious review/message attempts prompt injection; PII sent
  to model provider un-redacted.
- Mitigation: Context Service with redaction; treat uploads/messages as
  untrusted; keep the "model proposes id, code disposes" pattern for any action
  tool (`07-...`).
- Priority: **P2** now, **P0 before any Level-3 AI action.** Blocks: Partially.

**M4 — Public blob store; residual plaintext PII.**
- Evidence: all `put` use `access:'public'` (`doc-crypto.ts:3-11`); pre-fix
  identity docs + `/api/upload` quote photos remain unsealed (`upload:26`).
- Impact/exploit: a leaked/forwarded old SS-card URL is readable with no auth.
- Mitigation: one-time re-seal of legacy docs; tenant-prefix paths; reconfigure
  store for private access if the platform allows.
- Priority: **P2.** Blocks: No (but privacy-sensitive).

### LOW

**L1 — Cron endpoints fail OPEN if `CRON_SECRET` unset** (`cron/daily:207-211`)
— missing env → anyone triggers deductions/route-gen/sends. Mitigation:
fail-closed. **P1** (cheap).

**L2 — Rate-limiter and login limiter fail OPEN on Redis error**
(`rate-limit.ts:34`, `auth:31`) — during a Redis outage, abuse protections
vanish. Mitigation: accept for availability, or add a conservative in-memory
fallback. **P3.**

## 2. Threat-model coverage summary

| Area | Status |
|---|---|
| Authentication / session | Solid; session now carries `tid` + min-16 secret enforced; **single global HMAC secret + single shared owner password remain (C2)**; add MFA + revocation for enterprise |
| Authorization / role escalation | Solid mechanism; **enforcement drift (H2)** |
| IDOR / RLS | Tokens CSPRNG (good); **tenant chokepoint SHIPPED but flag-off / not activated (C1)**; ack token weak (M2) |
| Secret handling | Clean (no logging) |
| Webhook verification | Stripe good; **Twilio/email fail-open (M1)** |
| File-upload validation | Type/size checked; no magic-byte sniff; store public (M4) |
| Cross-tenant leakage | **Chokepoint enforced in code (fail-closed), flag-off; not yet activated (C1)**; name-derived keys + Blob + `ai:*` still shared (C3) |
| Prompt injection / AI abuse | **Undefended (M3)**; mitigated by `writes:false` today |
| PII / financial / location exposure | Identity docs encrypted; rest plaintext; **GPS is worker PII** |
| Rate limiting / abuse | Broad coverage, fail-open (L2) |
| Backup / recovery / retention / erasure | **Absent** — see `09/12` |
| Auditability | Present but **narrow + coarse (H3)** |

## 3. Commercialization gate (what MUST be fixed before selling to a 2nd tenant)

C1, C2, C3 (isolation + tenant-aware auth), H1 (Stripe Connect), plus the cheap
P1s (M1, M2, L1, H2). Retention/erasure (M4 + `09/12`) and MFA are required
before **enterprise** buyers, not before the first small tenant.

_(Updated 2026-07-14 — progress against the gate: **C1** mechanism is built and
CI-enforced (activation still pending the migration + Blob scoping); **C2** is
half-closed (session carries `tid`, 104 handlers scope context) with the global
signing secret + shared owner password still to fix; **C3** unchanged. The gate is
**materially advanced but not cleared** — data-level isolation is inactive and
per-owner identity does not yet exist.)_
