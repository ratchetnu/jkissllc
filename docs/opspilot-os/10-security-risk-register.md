# 10 — Security Risk Register (Phase 9)

> Threat-focused review, cited to `file:line` on `~/jkissllc@main`, 2026-07-12.
> Each risk: evidence · impact · exploitation · mitigation · priority · blocks
> commercialization?

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

**C1 — No tenant isolation (all Redis keys global).**
- Evidence: `redis.ts:4-12` (chokepoint un-prefixed); every namespace global.
- Impact/exploit: any second tenant sharing the Redis instance → one tenant's
  request can read/write another's bookings, pay, messages, claims by key.
- Mitigation: key-prefix in `call()` + tenant context (`05`,`09`); hand-migrate
  the two bypass files.
- Priority: **P0.** Blocks commercialization: **Yes.**

**C2 — Session carries no tenant; cookie + HMAC secret are global.**
- Evidence: `SessionPayload` has `{sub,role,staffId}` but no `tid`
  (`session.ts:17-24`); `COOKIE_NAME='jk_admin_session'` global (`:4`); one
  `ADMIN_SESSION_SECRET` (`:60`).
- Impact/exploit: on a shared apex domain a token minted for tenant A is valid
  for tenant B; no tenant scoping on any authorization decision.
- Mitigation: add `tid` to payload; `requireTenantSession`; per-tenant cookie
  name or path.
- Priority: **P0.** Blocks: **Yes.**

**C3 — Cross-tenant data leak via name-derived keys & global AI calibration.**
- Evidence: `biz:{name}` (`businesses.ts:41`) + `Staff.payByBusiness` map keys
  (`staff.ts:36`); `msg:phone:{e164}`; `learn:*` global (`job-learning.ts:41-42`).
- Impact/exploit: two tenants with the same client name overwrite each other's
  contract rates and payroll maps; two tenants texting the same consumer number
  merge threads; one tenant's job outcomes train another's pricing.
- Mitigation: id-based keys + tenant prefix + `learn:*` scoping (data migration,
  `09-...` §4b).
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
| Authentication / session | Solid; add MFA + revocation for enterprise |
| Authorization / role escalation | Solid mechanism; **enforcement drift (H2)** |
| IDOR / RLS | Tokens CSPRNG (good); **no tenant RLS (C1)**; ack token weak (M2) |
| Secret handling | Clean (no logging) |
| Webhook verification | Stripe good; **Twilio/email fail-open (M1)** |
| File-upload validation | Type/size checked; no magic-byte sniff; store public (M4) |
| Cross-tenant leakage | **Not prevented (C1/C3)** |
| Prompt injection / AI abuse | **Undefended (M3)**; mitigated by `writes:false` today |
| PII / financial / location exposure | Identity docs encrypted; rest plaintext; **GPS is worker PII** |
| Rate limiting / abuse | Broad coverage, fail-open (L2) |
| Backup / recovery / retention / erasure | **Absent** — see `09/12` |
| Auditability | Present but **narrow + coarse (H3)** |

## 3. Commercialization gate (what MUST be fixed before selling to a 2nd tenant)

C1, C2, C3 (isolation + tenant-aware auth), H1 (Stripe Connect), plus the cheap
P1s (M1, M2, L1, H2). Retention/erasure (M4 + `09/12`) and MFA are required
before **enterprise** buyers, not before the first small tenant.
