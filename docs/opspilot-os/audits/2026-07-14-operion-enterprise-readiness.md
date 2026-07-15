# Operion Platform Readiness Report — 2026-07-14

> Evidence-based end-to-end validation of the Operion platform as implemented in the
> J KISS LLC repository. READ-ONLY audit. No app code changed, no deploy, no env change,
> `TENANCY_ENABLED` remained `false`. Directory `docs/opspilot-os/` is retained as the
> single authoritative blueprint source (legacy name; product = Operion).

> **Resolution update — 2026-07-14 (branch `fix/operion-production-hardening`).** The
> Production Hardening sprint has since resolved a set of these findings (code changed,
> `tsc` 0 · **629/629 tests** · `next build` OK; `TENANCY_ENABLED` still `false`; not merged/deployed):
> - **H-SEC-1 RESOLVED** — 38 admin routes migrated off coarse `requireSession` to
>   `requirePermission`/`requireStaffSession`/`requireAdmin`; managers are now denied the
>   admin-only surfaces (pay/invoices/profitability/settings/decrypted applicant docs) at the
>   API, not just the edge. New `scripts/manager-authz.test.ts` + hardened `authorization-coverage.test.ts`.
> - **H-AI-1 RESOLVED** — lease-based stale-`processing` reaper (`AI_PROCESSING_LEASE_MS`,
>   idempotent under the write-lock, preserves attempts, terminal at MAX, never resurrects
>   failed jobs). **M-AI-3 RESOLVED** — `AbortSignal.timeout` (`AI_CALL_TIMEOUT_MS`) classified transient.
> - **M-OBS-1 / M-OBS-2 / M-MSG-1 RESOLVED** — Stripe webhook + daily/reminders cron failures
>   now `alert()`; alert **email fallback wired** (Slack→email→console) with correlation IDs.
> - **M-ADM-1/2/3 RESOLVED** — KPI "Awaiting AI" count==filter (shared predicate), "Booked
>   Today" uses `confirmedAt`+`centralToday()`, poll `refreshing`-vs-`loading` split.
> - **M-A11Y-1 RESOLVED** — wizard fields programmatically labeled (`htmlFor`/`id`,
>   `aria-required`, group `aria-labelledby`, upload `aria-live`).
>
> Still open (not in this sprint): the tenant-activation blockers (H-AI-2, H-PAY-1, H-BLOB-1,
> H-KEY-1/2, M-TEN-4/5), M-OBS-3 (logger adoption), M-SEC-2 (CSP), and the remaining MEDIUM/LOW
> operational items. See `CHANGELOG.md` (2026-07-14 hardening entry).

## 1. Executive summary

Operion, as run today by J KISS LLC (its first live tenant), is a **genuinely capable,
well-engineered single-tenant operations platform**. The customer→cash spine (Book Now
intake → photo upload → governed AI estimate → quote → payment → booking) is real,
connected end-to-end, and unusually well-guarded for correctness: per-booking write
leases, session-id/idempotency-key dedup, signature-verified webhooks, AES-GCM sealing of
sensitive proofs, a fail-closed Redis chokepoint, a blocking CI gate, and **586/586
automated tests passing** with `tsc` clean and `next build` succeeding.

It is **PARTIALLY READY** for enterprise use:

- **Production-solid for the single J KISS tenant**, with a set of **HIGH** hardening items
  that are independent of multi-tenancy and carry low regression risk (manager
  over-privilege on ~31 admin routes; a durable AI job that can strand in `processing`;
  silent failures in the Stripe webhook and daily/reminders crons).
- **NOT READY for multi-tenant activation.** The tenant-context foundation (S1) is shipped
  and inert, fail-closed protections are verified, but **five concrete activation blockers**
  remain (Blob not tenant-scoped; `ai:*` global; name-derived key collisions in
  business/pay and job-learning; Stripe webhook + public token routes cannot resolve a
  tenant), and the **dark-launch has never been exercised** (BLOCKED — requires a browser
  against Preview).

No **CRITICAL live** issue was found: nothing is currently corrupting data or exposing one
customer's data to another. The tenancy blockers would become CRITICAL *if* `TENANCY_ENABLED`
were flipped without remediation — hence the guard rails that keep it inert are essential and
were verified working.

**Recommended next sprint:** *Production Hardening — Auth Tightening, Worker Recovery &
Failure Visibility* (see §22). It resolves the live HIGH issues with no schema, no auth
re-architecture, and no tenancy work.

## 2. Audit scope

Customer intake through completed operations, plus the platform substrate: Book Now,
photo storage, AI workflow, admin Book Now Requests, quotes, payments, scheduling/routes/
crew, completion & analytics, messaging, RBAC/security, tenant dark-launch, observability/
reliability, automated tests/build, and static performance/accessibility. Method: direct
repository inspection by nine parallel read-only reviewers + execution of the project's own
non-destructive quality gates. No new features built; no interfaces redesigned.

## 3. Branch and commit

- **Audit branch:** `audit/operion-enterprise-readiness`
- **Base:** `docs/operion-blueprint-reconciliation` @ `8b36a4d` (the reconciled blueprint), which is `main` (`9b0ce99`) + the 2026-07-14 documentation reconciliation.
- Untouched: `redesign/book-now-dashboard` @ `9b0ce99`, `main` @ `9b0ce99`.

## 4. Environments used

- **Local repository @ audit branch** — all code inspection + quality gates.
- **Quality gates executed locally:** `tsc --noEmit`, `npm test` (node:test via tsx), `npm run build`.
- **NOT used:** Production (no deploy, no reads), Preview (Vercel SSO + BotID blocked headless access), live Stripe/Twilio/Resend/AI-Gateway calls, Preview/Prod Redis or Blob. All live-UI, Lighthouse, screen-reader, real-provider, and live dark-launch-telemetry checks are therefore **BLOCKED BY ENVIRONMENT** (§19).

## 5. Safety controls honored

No app code modified · no merge · no Production deploy · no Production env change · no secret rotated · no secret value printed · no destructive DB/Blob op · no Production data touched · `TENANCY_ENABLED` left `false` · all tenancy flags left OFF. The only file changes on this branch are this report + a CHANGELOG entry (documentation).

## 6. Verified end-to-end workflow map

Legend: ✅ VERIFIED-WORKING (code complete + passing test) · 🟡 PARTIALLY-VERIFIED · 🟠 IMPLEMENTED-UNTESTED · 🔌 DISCONNECTED · ⛔ BLOCKED-ENV · ❌ NOT-FOUND.

| # | Stage | Status | Key evidence |
|---|---|---|---|
| 1 | Customer opens Book Now, selects service, enters contact/address/notes | 🟡 (client) / ✅ (server validation) | `app/quote/page.tsx`, `app/api/quote/route.ts:142-148` |
| 2 | Photo upload → validated → stored in Blob | ✅ validation / 🟠 store | `app/api/upload/route.ts:20-27` |
| 3 | Booking record created (`source:'online'`), photo associated | ✅ (unit) / 🟡 assoc | `app/lib/booking-requests.ts:144,158` |
| 4 | AI processing enqueued (durable) + instant path | ✅ | `booking-requests.ts:207`, `app/api/quote/analyze/route.ts:44` |
| 5 | AI output stored (draft `qa:*`, permanent on booking) | ✅ | `estimate-store.ts:61`, `book-now-ai.ts:210` |
| 6 | Admin sees request + photos + AI analysis | 🟠/⛔ (renders in code; visual unrunnable) | `app/admin/operations/book-now/[token]/page.tsx:190-394` |
| 7 | Quote created; AI recommendation auto-applied (owner may override) | ✅ | `app/api/admin/bookings/[id]/route.ts:355-356` |
| 8 | Quote sent (email/SMS link) | 🟡 | `route.ts:367`, `guided-approval.ts:96` |
| 9 | Customer opens quote, accepts (agreement + IP/UA audit) | ✅ | `app/api/booking/[token]/verify/route.ts:40-56` |
| 10 | Deposit/full payment (Stripe or Zelle sealed proof) | ✅ | `app/api/book/route.ts:167`, `webhooks/stripe/route.ts:24` |
| 11 | Booking confirmed; payment recorded idempotently | ✅ | `app/lib/record-payment.ts:29,51-60` |
| 12 | Job scheduled (date/window persist) | ✅ | `admin/bookings/[id]/route.ts:125-126` |
| 13 | Route/work assignment (contract/recurring model) | ✅ (routes) / ❌ auto-from-booking (by design) | `app/api/admin/routes/route.ts:34` |
| 14 | Crew notified + confirms (token link, clock-in, GPS) | ✅ | `route-notify.ts:70-107`, `api/route/[token]/route.ts:117-168` |
| 15 | Availability / time-off enforced at assignment | 🔌 | data exists (`crew-availability.ts:115`, `timeoff.ts`) but never consulted at `assign` |
| 16 | Work completed; completion notes/photos | ✅ | `api/route/[token]/route.ts:97-111`, `admin/bookings/[id]/route.ts:514-522` |
| 17 | Final invoice/balance; customer comms | 🟡 | `route-invoices.ts`; comms only on `mark-completed`, not generic `update` |
| 18 | Financial & operational analytics update (REAL data) | ✅ | `app/lib/analytics.ts:61-214` — pure fold over live bookings + Payment rows |
| 19 | AI-estimate-vs-actual learning | 🔌 | `job-learning.ts:106-110` never receives `aiRecommendedCents` |

## 7. Readiness scorecard

Scale: READY · READY WITH CONDITIONS (RWC) · PARTIALLY READY · NOT READY · NOT VERIFIED.

| Area | Rating | Highest sev | Enterprise blocker? | Next action |
|---|---|---|---|---|
| Customer Book Now | RWC | MEDIUM | No | Fix wizard label a11y (A1) |
| Photo handling | PARTIALLY READY | HIGH | Yes (tenant) | Tenant-scope Blob paths (T3) |
| AI processing | RWC | HIGH | No (live) | Stale-`processing` reaper + call timeout |
| Admin Book Now Requests | RWC | MEDIUM | No | KPI accuracy + poll-flicker |
| Quotes | READY | LOW | No | (opt) quote-expiry window |
| Payments | RWC | HIGH | Yes (tenant) | Refund reconcile + webhook tenant-context (T-Stripe) |
| Scheduling | PARTIALLY READY | MEDIUM | No | Enforce availability/time-off at assign |
| Route assignment | RWC | MEDIUM | No | Equipment conflict + no_response rollup |
| Crew workflows | RWC | LOW | No | Decide one-off-booking crew model |
| Messaging | RWC | MEDIUM | No | Wire alert-email; gate SMS suppression on A2P flag |
| Analytics | READY | LOW/MED | No | Wire AI-vs-actual outcome capture |
| Identity & access | PARTIALLY READY | HIGH | No (live) | Per-route `requirePermission` (H1) |
| Security | RWC | HIGH | No | H1 + CSP + availability rate-limit |
| Tenant readiness | NOT READY | HIGH | Yes | Clear 5 blockers → dark-launch validation |
| Observability | PARTIALLY READY | MEDIUM | No | Adopt logger + correlation IDs; close silent-failure gaps |
| Reliability | PARTIALLY READY | HIGH | No | Reaper + runbook + backup verification |
| Testing | RWC | MEDIUM | No | Add browser/a11y/perf E2E |
| Performance | NOT VERIFIED | — | No | Lighthouse against Preview |
| Accessibility | PARTIALLY READY | MEDIUM | No | Wizard labels + table keyboard |
| Deployment safety | RWC | LOW | No | Document rollback procedure |
| Disaster recovery | NOT READY | MEDIUM | No | Backup/PITR verification + runbook |
| Documentation alignment | READY | LOW | No | (current — reconciled 2026-07-14) |

**Overall platform readiness: PARTIALLY READY** — production-solid for one tenant with HIGH hardening items; NOT READY for multi-tenant activation.

## 8. Detailed results by domain

Full per-stage evidence tables were produced for each domain (Book Now/photo, AI, admin
Requests tab, quote/payment, scheduling/crew/analytics, messaging, security/tenancy,
observability/tests/a11y). The material conclusions:

- **Book Now + photo:** intake validated server-side; upload validates type/size/count and
  stores at `quote-photos/<uuid>` (`access:'public'`, no expiry). Association happens at
  submit, not upload (orphan risk). No enumerable IDOR (122-bit UUID) but URLs are
  world-readable capability links.
- **AI:** single deterministic pricing path; AI is architecturally advisory (`writes:false`,
  `priceJob` sets every price); bounded retry; structured-output normalizer never throws /
  never prices; conflict detection surfaced to admin. Two HIGH gaps (stranded `processing`,
  global `ai:` audit index).
- **Admin Requests tab:** redesign is **UI-only** (commit `9b0ce99` touched exactly one file);
  all 12 PATCH actions + the GET feed + filters preserved; auth guarded (`requireSession`
  + crew→403). KPI computations derive from real data but three have accuracy defects.
- **Quote/Payment:** quote is **fully** AI-connected (one-click apply of AI recommendation,
  manual is optional override); payments idempotent + signature-verified + write-leased;
  Zelle sealed via AES-GCM. Gaps: un-tenanted Stripe webhook (HIGH, latent), no refund
  reconciliation, no quote expiry.
- **Scheduling/crew/analytics:** two operational models (one-off Bookings vs contract
  Routes); Routes have full confirm/clock/GPS/pay/claims; availability & time-off collected
  but **not enforced** at assignment. **Analytics confirmed computed from real live data —
  no placeholders.**
- **Messaging:** Twilio REST + Resend, opt-out/STOP, delivery-status ledger, signature-
  verified inbound webhooks, robust dedup. Scheduled SMS is deliberately suppressed
  (A2P pending); the ops-alert email path is disconnected.
- **Security/tenancy:** strong session/HMAC/RBAC/rate-limit fundamentals; fail-closed
  tenancy verified; manager over-privilege on ~31 routes; no CSP.
- **Observability/tests:** health endpoint solid; structured logger dormant; silent-failure
  gaps; 75 test files / 586 cases green; no browser/a11y/perf E2E.

## 9. Critical issues

**None currently live.** No active data corruption, cross-customer exposure, broken payment
integrity, or outage condition was found in the single-tenant production configuration. The
five tenant-activation blockers (§13, §21) would each be CRITICAL *on activation*; they are
inert today and gated by verified fail-closed protections.

## 10. High issues

| ID | Domain | Title | Live vs Activation | Fix effort |
|---|---|---|---|---|
| H-SEC-1 | Security/RBAC | ~31 admin routes use coarse `requireSession`; a **manager** session reaches admin-only pay/invoices/profitability + decrypted applicant docs (`careers/doc`). Edge proxy stops crew but not managers. | LIVE | M |
| H-AI-1 | AI | Durable Book Now job can strand in `processing` forever — `isDue`/`isFinalDue` only re-pick `queued`/`retrying`; a crash/timeout *during* the model call has no reaper. Contradicts the file's own crash-safe docstring. | LIVE | M |
| H-AI-2 | AI/Tenant | AI audit log/analytics read path (`ai:log`, `listAiCalls`, `computeAiAnalytics`) has **no tenant filter** → cross-tenant AI-output disclosure on activation. | Activation | M |
| H-PAY-1 | Payment/Tenant | Stripe webhook is a **bare handler** (no `withBackgroundTenant`); once tenancy is on, async-payment recording throws + is swallowed → payments silently unrecorded. | Activation | M |
| H-BLOB-1 | Photo/Tenant | Vercel Blob paths are globally namespaced (`quote-photos/`, `driver-docs/`, `payment-proofs/`) — no tenant segment; Redis chokepoint doesn't cover Blob. | Activation | M |
| H-KEY-1 | Tenant | Name-derived `bizKey` (business name) also keys `Staff.payByBusiness` → cross-tenant contract-rate + payroll collision; needs data migration, prefix alone insufficient. | Activation | M-L |
| H-KEY-2 | Tenant | Global `learn:jobs`/`learn:calibration` pricing model → one tenant's outcomes train another's estimator. | Activation | M |

## 11. Medium issues

| ID | Domain | Title | Effort |
|---|---|---|---|
| M-PAY-2 | Payment | No refund/dispute reconciliation (`charge.refunded`/`async_payment_failed` unhandled) — refunded bookings still read paid. | M |
| M-SCH-1 | Scheduling | Availability + approved time-off never checked at crew `assign` (data collected, not enforced). | M |
| M-SCH-2 | Routes | `no_response` never rolls up to route status → ghosted routes don't lower the contractor reliability score (dead weight). | S |
| M-CMP-1 | Completion | Two completion paths diverge: generic `update`→completed skips the invoice guard **and** customer notification. | S |
| M-ADM-1 | Admin tab | 15s poll sets global `loading` → table blanks to "Loading…" every cycle (and detail page fully unmounts every 6s). | S |
| M-ADM-2 | Admin tab | "Awaiting AI" KPI counts 6 stages but its click-through filters to 1 (`ai_processing`) → number ≠ rows. | S |
| M-ADM-3 | Admin tab | "Booked Today" uses `createdAt` (submission) not `confirmedAt` (booking) → wrong daily metric. | S |
| M-MSG-1 | Messaging | Ops-alert **email** path is disconnected (`alerts.ts` email branch commented out) → CRITICAL/ERROR alerts go to console unless Slack webhook set. | S |
| M-MSG-2 | Messaging | All scheduled SMS suppressed in both crons (A2P posture) → SMS-only reminders silently deliver nothing; stats show `sms:false`. | S-M |
| M-OBS-1 | Observability | Stripe webhook handler errors only `console.error` (no `alert`) — payment-integrity blind spot. | S |
| M-OBS-2 | Observability | `cron/daily` + `cron/reminders` have no failure alerting (only `cron/ai-jobs` does). | S |
| M-OBS-3 | Observability | Structured/redacted logger is dormant; 151 raw `console.*` sites, no correlation IDs, no APM. | M |
| M-A11Y-1 | Accessibility | Wizard fields (contact/job steps) have `<label>` siblings with no `htmlFor`/`id`/`aria-label` → WCAG 1.3.1/4.1.2 fail on the primary lead-capture form. | S |
| M-SEC-2 | Security | No Content-Security-Policy (proxy sets nosniff/frame/referrer only). | L |
| M-AI-3 | AI | No per-AI-call timeout (`abortSignal`); only the 60s function cap bounds a stalled provider (worsens H-AI-1). | S |
| M-PHO-2 | Photo | Customer photos are public, non-expiring capability URLs (estate/eviction interiors); leak = permanent exposure. | M |
| M-PHO-3 | Photo | Uploaded blobs orphaned on wizard abandonment (association at submit, no GC sweep). | M |
| M-TEN-4 | Tenant | `ai:*` telemetry/cost/prompts platform-global (activation blocker; also drives H-AI-2). | M |
| M-TEN-5 | Tenant | Public token routes (booking/invoice/quote) + Stripe webhook can't resolve a tenant (session-only resolution) → fail-closed throw on activation; SMS webhook hardcodes `activeTenantIds()[0]`. | M-L |
| M-ANL-1 | Analytics | AI-estimate-vs-actual (`priceMape`/`overrideRate`) permanently null — outcome writer never sets `aiRecommendedCents`. | M |

## 12. Low issues

Broken-image fallback missing (admin renders raw `<img>`); quote links never expire;
`stripe-return` reports success even if inline record throws (webhook backstops it);
duplicate pipeline chips (`accepted`/`payment_pending` same count); two real stages
(`final_processing`, `awaiting_confirmation`) have no filter chip; "Pending Revenue" KPI
filters to an unrelated view; table rows not keyboard-operable + `<th>` missing `scope`;
no template variable substitution in reminders; no auto-retry/backoff on failed sends;
`toE164` NANP-only; equipment is a display snapshot with no return/conflict lifecycle;
one-off bookings bypass crew-confirmation/timeclock/claims (architectural, not a bug);
persist-quote idempotency has no direct test; CSRF relies on sameSite=lax only;
`/api/availability` has no rate limit; no in-repo runbook/backup-verification/rollback doc.

## 13. Tenant dark-launch results

- **Config verified statically (flag OFF):** all tenancy flags default `false`
  (`flags.ts:30-35`); `scopeKey` fails **closed** (`keys.ts:62-71`, tested); request-context
  throws on missing tid when enabled (`request-context.ts:22-27`); forged `x-tenant-id`
  stripped at the edge (`proxy.ts:22-23`, tested); `PLATFORM_GLOBAL_PREFIXES` = `opspilot:`,
  `platform:`, `ai:`, `rl:`; `tenancy:dark-launch-mismatch` telemetry emitted from
  `dark-launch.ts:59`; bypass-detection CI gate present and green.
- **Static mismatch-producing paths:** exactly **1** production path — `redis.get()`
  (`redis.ts:63-72`, gated on `TENANCY_DARK_LAUNCH`). Note: `set`/`del` dual-write mirrors
  to both keys but emits **no** mismatch telemetry — write divergence is currently invisible;
  only read-time compares surface.
- **Live mismatch count: BLOCKED-ENV / NOT VERIFIED.** Exercising Preview workflows and
  reading the live `tenancy:dark-launch-mismatch` counters requires a browser against the
  SSO-gated Preview + access to Preview Redis — neither available in this audit. **Safe
  method:** Playwright against the Preview deploy (SSO-bypass token), `TENANCY_DARK_LAUNCH=true`
  + seeded tenant context (Preview env only, `TENANCY_ENABLED` stays `false`), drive
  booking/route/pay flows to trigger `redis.get()` compares, then read counts via an admin
  telemetry/health endpoint or Vercel runtime logs.
- **Activation blockers (confirmed in code):** T1 name-derived `bizKey`→payroll collision;
  T2 global job-learning model; T3 Blob not tenant-scoped; T4 `ai:*` global; T5 public token
  routes + Stripe webhook can't resolve a tenant. All must clear before `TENANCY_ENABLED`.
- **No Production data was changed and no Production resource was used** during this audit.

## 14. Security results

Strong fundamentals: HMAC-SHA256 sessions (min-16 secret enforced, no ADMIN_PASSWORD
fallback, tamper-evident), 2h absolute + 10-min idle expiry, httpOnly+secure+lax cookies,
edge role-gating of `/admin`, 256-bit unguessable customer tokens, Redis-backed auth rate
limiting, timing-safe password compare, signature-verified Stripe/Twilio webhooks,
fail-closed cron auth, AES-256-GCM sealing of payment proofs + applicant docs, telemetry
that logs key-families not values. **Open:** H-SEC-1 manager over-privilege (~31 routes on
`requireSession`); M-SEC-2 no CSP; single shared owner `ADMIN_PASSWORD` + single global
`ADMIN_SESSION_SECRET` (no per-owner identity); L-items (CSRF token, availability rate-limit).

## 15. Automated test results (EXECUTED)

- **`tsc --noEmit`:** ✅ exit 0, **0 errors**.
- **`npm test`:** ✅ **586 pass / 0 fail / 0 skipped** (75 files, node:test via tsx, ~1.2s),
  including tenant-isolation, bypass-detection, rbac, authorization-coverage,
  security-hardening, AI-regression, and the fail-closed cron/webhook suites.
- **`npm run build`:** ✅ compiled successfully; 136 static pages generated; exit 0.
- **Existence check:** no Playwright/Cypress E2E config; **NOT-FOUND** — Book Now browser E2E,
  photo-upload E2E, quote E2E, scheduling E2E, accessibility tests, performance tests,
  production smoke tests. `booking-e2e.test.ts` is API-level (real handlers, in-memory
  Upstash), not browser. `audit:mobile` is a Playwright horizontal-overflow tool (needs a
  running server; not in CI).

## 16. Performance findings (static; live = NOT VERIFIED)

Polling is bounded (wizard caps 8×2.5s; dashboard 15s only while an AI job is active).
Dashboard refetches the full list each cycle (fine at current scale). Wizard is a single
1.6k-line client component with tree-shakeable icons — heavy but not egregious. **Live
Lighthouse/Core-Web-Vitals/bundle-size BLOCKED-ENV** (needs Lighthouse against Preview).

## 17. Accessibility findings

Good: overlays (`components/ui/overlays.tsx`) implement a real focus trap, `role="dialog"`
`aria-modal`, Escape, focus-return; dashboard controls have `aria-label`s. **Failing:**
M-A11Y-1 wizard fields lack programmatic labels (WCAG 1.3.1/4.1.2 on lead capture); desktop
table rows are not keyboard-operable and `<th>` lack `scope`. **True SR/keyboard/contrast
BLOCKED-ENV** (needs AT or Playwright+axe against Preview).

## 18. Observability findings

Health endpoint solid (public + secret-gated detail, KV-critical→503, self-alert). Alert
layer has Slack→email→console fallback with dedup + redaction — but the **email branch is
disconnected** and Slack env is unset, so alerts are console-only in prod. **The structured/
redacted logger is dormant** (only reached via flag-gated `recordTenantEvent`); runtime
logging is 151 raw `console.*` with no correlation IDs and no external APM/Sentry/OTEL.
Silent-failure spots: Stripe webhook, `cron/daily`, `cron/reminders`. Classify overall:
**Partial → Insufficient** for an enterprise platform.

## 19. Items blocked from safe validation (with safe method)

1. **All live UI** (wizard, drawer, mobile, keyboard, screen-reader) — Playwright + axe against a Preview deploy with an SSO-bypass token; seed fixtures in Preview KV.
2. **Live Lighthouse / Core Web Vitals / bundle size** — Lighthouse or `next build --profile` against Preview.
3. **Live dark-launch mismatch telemetry** — Preview with `TENANCY_DARK_LAUNCH=true` (Preview env only), drive flows, read `tenancy:dark-launch-mismatch` (keep `TENANCY_ENABLED=false`).
4. **Blob round-trip / public-URL fetchability / cross-store isolation** — a Preview `BLOB_READ_WRITE_TOKEN`, PUT+GET an object; do not run against prod.
5. **Live Stripe checkout + webhook round-trip / refund path** — Stripe test keys + `stripe trigger` against Preview.
6. **Live Twilio/Resend delivery + inbound signed webhook** — provider test credentials/magic numbers against Preview; no real carrier/email send.
7. **A2P 10DLC brand/campaign approval state** — Twilio Console (not in repo).
8. **`audit:mobile` overflow sweep** — running server + `PW_EXE` headless-shell + `ADMIN_PASSWORD`.

## 20. Small fixes applied

**None — deliberately.** This was executed as a pure read-only audit to guarantee "no
application code changed / Production behavior preserved." Every issue above is specified
with effort + safe-rollback so it can be actioned in a scoped follow-up sprint. The only
changes on this branch are this report and the CHANGELOG entry (documentation).

## 21. Remaining enterprise blockers

**For multi-tenant activation (must clear before `TENANCY_ENABLED`):** Blob path scoping
(H-BLOB-1/T3) · `ai:*` scoping incl. audit-read filter (M-TEN-4/H-AI-2) · name-derived key
collisions in business/pay (H-KEY-1) and job-learning (H-KEY-2) · public-route + Stripe-webhook
tenant resolution (M-TEN-5/H-PAY-1) · then a validated dark-launch (§13). **For enterprise
operation regardless of tenancy:** manager RBAC tightening (H-SEC-1) · durable-worker reaper
(H-AI-1) · failure-alert coverage + logger adoption (M-OBS-1/2/3) · per-owner identity (single
shared password) · backup verification + runbook.

## 22. Recommended next implementation sprint

**Sprint: "Production Hardening — Auth Tightening, Worker Recovery & Failure Visibility"** (Stage 0/1, no schema/auth-rearchitecture/tenancy):

1. **H-SEC-1** — replace coarse `requireSession` with `requirePermission(req, '<perm>')` on the ~31 admin routes that expose pay/invoices/profitability/applicant-docs (primitive already exists; per-route two-line swap; add to `authorization-coverage.test.ts`).
2. **H-AI-1 + M-AI-3** — treat stale `processing` (older than a lease window) as due in `isDue`/`isFinalDue` (or add a cron reaper) + pass `AbortSignal.timeout(~30s)` to `generateText`; update the test that currently locks the stranding behavior.
3. **M-OBS-1/M-OBS-2 + M-MSG-1** — add `alert()` on the Stripe-webhook catch and the daily/reminders cron catches; wire the alert-email sender (or correct the status string).
4. **M-ADM-1/2/3** — separate `refreshing` from `loading`; fix the two KPI accuracy defects.
5. **M-A11Y-1 (+L table)** — add `htmlFor`/`id` to wizard fields; make table rows keyboard-operable + `<th scope>`.

Rationale: highest customer/security/reliability impact per effort, entirely low-regression,
depends on nothing, and unblocks confidence before the heavier tenancy work.

## 23. Recommended next five sprints (ranked)

1. **Production Hardening** (above) — live HIGH/medium, low risk. *Do first.*
2. **Tenant Isolation Completion (S2)** — Blob scoping, `ai:*` scoping + audit-read filter, name-key migrations, public-route/Stripe-webhook tenant resolution. Architectural; gated before dark-launch.
3. **Dark-Launch Validation** — the documented Stage-0 gate; exercise Preview with `TENANCY_DARK_LAUNCH=true`, drive flows, drive the mismatch count to zero (needs the browser harness from §19).
4. **Observability Adoption** — request-scoped logger + correlation IDs + one external APM; add write-divergence telemetry to the dual-write path.
5. **Quality Harness** — Playwright E2E (Book Now, quote, payment-sandbox, crew-confirm) + axe a11y + Lighthouse budget in CI; fixes the "no browser E2E" gap.

## 24. What was intentionally not changed

No feature built or removed; no interface redesigned; no schema/migration; no auth
architecture change; no tenancy enablement; no payment behavior change; no Production
deploy or env change; no secret rotated; no working system rebuilt. The Book Now redesign
and the doc-reconciliation branches were not modified. `docs/opspilot-os/` remains the single
authoritative blueprint directory.

## 25. Production-safety confirmation

`TENANCY_ENABLED` remained `false` throughout. No Production deployment, env change, secret
rotation, destructive DB/Blob operation, or Production data modification occurred. All
validation used local read-only inspection + the project's own non-destructive quality
gates. No merge was performed.

---
*Generated by a nine-reviewer parallel read-only audit + local quality-gate execution on
`audit/operion-enterprise-readiness` @ base `8b36a4d`, 2026-07-14.*
