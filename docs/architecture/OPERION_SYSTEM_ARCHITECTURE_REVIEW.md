# Operion — System Architecture Review

**Repository:** `jkissllc` (Operion platform + J KISS LLC tenant)
**Reviewed at:** commit `28e7fa8`, branch `main`, 2026-08-09
**Reviewer role:** Principal Enterprise Architect — production validation
**Scope:** analysis only. No application code was modified, no flags changed, no deployments made, no PRs opened.

> **Historical snapshot:** This review is intentionally frozen at commit `28e7fa8` and records the architecture, counts, findings, and recommendations observed on 2026-08-09. It is not a current production-status report. For the maintained description of Operion's present implementation and release state, see [`OPERION_CURRENT_STATE.md`](../../OPERION_CURRENT_STATE.md).

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [System architecture](#2-system-architecture)
3. [User journey maps](#3-user-journey-maps)
4. [Data architecture](#4-data-architecture)
5. [Security assessment](#5-security-assessment)
6. [Concurrency assessment](#6-concurrency-assessment)
7. [AI architecture assessment](#7-ai-architecture-assessment)
8. [Reliability assessment](#8-reliability-assessment)
9. [Testing maturity](#9-testing-maturity)
10. [Risk register](#10-risk-register)
11. [Recommended roadmap](#11-recommended-roadmap)
12. [Appendix — verification method and limits](#12-appendix--verification-method-and-limits)

### Conventions used throughout

| Marker | Meaning |
|---|---|
| **IMPLEMENTED** | Code path verified end-to-end by reading it; reachable in the current default configuration. |
| **PARTIAL** | Code exists and is reachable, but a material branch is unwired, unproven, or gated such that the feature is not whole. |
| **PLANNED** | Code exists and is flag-gated OFF everywhere by default; enabling it is a separate, deliberate decision. |
| **MISSING** | No implementation found. A filename or a document mentioning it is not implementation. |

Priorities: **P0** production correctness/security · **P1** reliability risk · **P2** important improvement · **P3** optimization.

---

## 1. Executive summary

### What this system is

Operion is a **single Next.js 16 App Router application on Vercel** that serves four distinct audiences from one codebase and one Redis (Upstash) key space:

- a **public marketing + intake site** (quote wizard, instant booking, tracking, careers),
- a **customer self-service surface** addressed by unguessable tokens (booking detail, pay, reschedule, receipt, review),
- an **operations console** (`/admin/*`, ~69 pages) for admins and managers,
- a **crew portal** (`/portal/*`, 12 pages) for field staff — clock, jobs, pay, documents, time off,

plus a **platform control plane** (Operion Release/Update Center, Sync Status, AI Command Center) that is owner-only and largely dormant behind flags.

Scale of the artifact: **225 API routes**, **102 pages**, **400 library modules**, ~**126k lines** of `app/` TypeScript, **285 test files / 3,688 tests** (verified passing in 15.9s at review time), **48 feature flags** (46 default OFF), **7 registered cron jobs**.

### Overall verdict

This is an unusually **disciplined** codebase for a system of this size and origin. The things that most often destroy small operations platforms — duplicate money writes, lost concurrent updates, forged authorization, silent cross-tenant reads — have each been identified, reasoned about in-code, fixed with a named primitive, and pinned by a regression test. The booking idempotency state machine (`app/lib/booking-idempotency.ts`), the KV lock primitive (`app/lib/kv-lock.ts`), the RBAC matrix (`app/lib/rbac.ts`) and the Redis tenancy chokepoint (`app/lib/redis.ts`) are genuinely well-designed pieces of engineering, and each carries the reasoning for why the obvious "simplification" is a bug.

The weaknesses are of a different character. They are not sloppiness; they are **unfinished transitions and unbounded assumptions**:

1. **Correctness assumptions that hold only at current data volume.** A large family of business-critical computations — daily capacity/availability, payroll, timesheets, reports, GPS compliance — is computed from a *capped page* of the record index (`listBookings(1000)`, `listRoutes(2000)`). Past the cap the read silently truncates and the answer is quietly wrong. Nothing detects it. This is the single most consequential systemic risk in the review.

2. **One genuine unprotected race in a customer-facing money path.** Daily job capacity is a check-then-act (`isDateBookable` → build → save) with no reservation. Two concurrent bookings for the last slot on a date both pass. Every *other* comparable path in this system has a lock; this one does not.

3. **Tenancy is a half-crossed bridge.** The key chokepoint, the key API, the login/membership resolution, and the token-binding index are all built and tested. But the flag cannot be turned on: `withTenantRoute` throws for any session-less request, and every customer `booking/[token]` API route is wrapped in it. The inner `resolveTenantFromResource` calls in those routes are unreachable when tenancy is on.

4. **Observability is structurally sound but operationally unproven.** `alert()` is well-designed and fail-soft, but its delivery falls back to `console.log` unless a Slack webhook or owner email is configured, and nothing in the repo proves one is. There are no metrics, no dashboards outside the app itself, and no external synthetic monitoring beyond `/api/health`.

5. **A large dormant surface.** 46 of 48 flags are OFF. Much of the "AI shadow", "Release Center", "Sync Status", and "automation" subsystem is built, tested, and inert. This is *good* discipline, but it means the tested-and-passing signal covers a great deal of code that has never run against production traffic — and the maintenance burden is real.

### Scorecard at a glance

| Category | Score (0–4) | One-line justification |
|---|---|---|
| Architecture | **3** | Clear layering, one chokepoint per concern; weakened by a monolithic Redis-document model and a very large dormant surface. |
| Security | **3** | Signed sessions, central RBAC matrix, CI-enforced guard coverage, verified webhook signatures. Held back by an unproven CSP-less posture and client-only page gating. |
| Reliability | **2** | Excellent fail-soft discipline and durable job recovery; no proven alert delivery, no external monitoring, capped scans that fail silently. |
| Concurrency | **3** | Best-in-class idempotency + lock primitives with mutation-tested races — minus one real unprotected capacity race. |
| AI Safety | **3** | Single chokepoint with RBAC, budget cap, schema validation, bounded retry, deadline, circuit breaker. Cost cap is unset by default. |
| Observability | **2** | Structured redacting logger, per-stage tracing, health checks — all present; delivery + external monitoring unproven. |
| Testing | **3** | 3,688 tests, mutation-checked race tests, CI-enforced authorization coverage. Gaps in capacity, scan-truncation, and end-to-end payment. |
| Deployment | **2** | CI gate exists and is comprehensive, but is *advisory* by its own admission; a known "green merge, no deploy" failure mode requires manual verification. |
| Scalability | **1** | Capped index scans back correctness-relevant math; O(n) Redis round trips per aggregate; no per-business index. |
| Maintainability | **3** | Outstanding in-code reasoning and naming; burdened by 400 lib modules, 48 flags, and several parallel half-migrations. |

**Weighted verdict: the system is production-appropriate for its current single-tenant volume and is being run responsibly. It is not yet enterprise-ready, and the gating item is not security — it is the class of computations that silently truncate as the business grows.**

---

## 2. System architecture

### 2.1 Component diagram

```
                                   ┌──────────────────────────────────────┐
   Public internet                 │  Vercel Edge / Platform              │
        │                          │  · deployment protection (Preview)   │
        ▼                          │  · DDoS + BotID challenge            │
 ┌───────────────┐                 │  · HSTS at the edge                  │
 │  proxy.ts     │◀────────────────┘
 │ (Next 16      │  · apex → www 308
 │  middleware)  │  · STRIP client x-tenant-id  ← anti-spoof
 │               │  · X-Content-Type-Options / X-Frame-Options / Referrer-Policy
 │               │  · RBAC choke: crew principal blocked from /admin + /api/admin
 │               │  · sliding 10-min idle session refresh
 └───────┬───────┘
         │
 ┌───────┴───────────────────────────────────────────────────────────────────────┐
 │  Next.js App Router (single Vercel project, Node.js runtime / Fluid Compute)   │
 │                                                                                │
 │  PAGES (102)                          API ROUTES (225)                         │
 │  ├ public marketing/SEO   (~20)       ├ public intake      /api/quote /api/book│
 │  ├ customer token pages   (~8)        │                    /api/upload /api/estimate
 │  ├ /admin  ops console    (69)        ├ customer token     /api/booking/[token]/*
 │  │   62 of 69 are 'use client'        ├ crew portal        /api/portal/*  (19)
 │  └ /portal crew portal    (12)        ├ admin/ops          /api/admin/*  (~150)
 │                                       ├ platform owner     /api/admin/platform/*
 │  SHELLS (client-side auth gate)       │                    /api/admin/release/*
 │  ├ OperationsShell (per-page mount)   ├ webhooks           stripe / twilio×2 / email
 │  └ PortalShell     (in layout)        ├ crons              /api/cron/*  (8)
 │                                       └ diagnostics        Preview-only, flag-gated
 └───────┬────────────────────────────────────────────────────────────────────────┘
         │
 ┌───────┴────────────────────────────────────────────────────────────────────┐
 │  app/lib — 400 modules. Enforced chokepoints:                              │
 │                                                                            │
 │   authz ──▶ app/lib/rbac.ts  (role × permission matrix)                    │
 │   authn ──▶ app/api/admin/_lib/session.ts  (HMAC-signed cookie)            │
 │   data  ──▶ app/lib/redis.ts ──▶ platform/tenancy/keys.ts (scopeKey)       │
 │   locks ──▶ app/lib/kv-lock.ts  (SET NX PX + CAS + heartbeat)              │
 │   AI    ──▶ app/lib/ai/service.ts  (runAiTask)                             │
 │   alert ──▶ app/lib/alerts.ts                                              │
 │   flags ──▶ app/lib/platform/flags.ts                                      │
 │   log   ──▶ platform/observability/logger.ts + redact.ts                   │
 └───────┬────────────────────────────────────────────────────────────────────┘
         │
 ┌───────┴───────────────────────────────────────────────────────────────────────┐
 │  EXTERNAL DEPENDENCIES                                                        │
 │  ├ Upstash Redis (REST)   — SOLE datastore. Critical. No RDBMS anywhere.      │
 │  ├ Vercel Blob            — photos, sealed Zelle proof, crew documents        │
 │  ├ Vercel AI Gateway      — vision + text models (OIDC auth in-deployment)    │
 │  ├ Stripe                 — checkout sessions + signed webhook                │
 │  ├ Resend                 — transactional + ops email                         │
 │  ├ Twilio                 — SMS out, signed inbound webhooks (SMS + status)   │
 │  ├ Vercel BotID           — invisible challenge on public forms               │
 │  ├ zippopotam.us          — ZIP → lat/lon (unauthenticated, cached 30d)       │
 │  ├ GitHub API             — Operion automation/sync (flag OFF)                │
 │  └ Vercel API             — Operion deployment reconciliation (flag OFF)      │
 └───────────────────────────────────────────────────────────────────────────────┘
```

**Evidence:** `proxy.ts`; `vercel.json`; `next.config.ts`; `package.json`; `app/lib/redis.ts`; `app/lib/platform/tenancy/keys.ts`.

**Architecturally significant fact:** there is **no relational database**. Every entity is a JSON document in Upstash Redis, indexed by hand-maintained sorted sets and string index keys. Every consistency guarantee in the system is therefore built from `SET NX PX`, `EVAL` (Lua CAS), and application-level locks. This is a coherent choice at current scale and the team has built the right primitives for it — but it is the root cause of the scalability findings in §6 and §8.

### 2.2 Module ownership map

| Domain | Owning modules | Public entry points |
|---|---|---|
| **Identity & session** | `app/api/admin/_lib/session.ts`, `app/api/admin/_lib/tenant-session.ts`, `app/lib/users.ts`, `app/lib/password.ts` | `POST /api/auth/login`, `POST /api/admin/auth`, `POST /api/auth/tenant`, `GET /api/admin/session` |
| **Authorization** | `app/lib/rbac.ts` (matrix), `app/api/portal/_lib/crew.ts` (crew narrowing) | consumed by every guarded route |
| **Tenancy** | `app/lib/platform/tenancy/*` (37 modules) — `keys`, `context`, `request-context`, `membership`, `token-binding`, `with-*-route` | route wrappers |
| **Booking (customer)** | `app/lib/bookings.ts` (963 LOC, the aggregate root), `booking-idempotency`, `booking-requests`, `booking-status`, `booking-concurrency`, `availability` | `POST /api/book`, `POST /api/quote`, `/api/booking/[token]/*` |
| **Routes (B2B lane)** | `app/lib/routes.ts`, `route-mutex`, `route-pay`, `route-invoices`, `route-templates`, `route-notify`, `route-reprice` | `/api/admin/routes/*`, `GET|POST /api/route/[token]` |
| **Crew / workforce** | `staff`, `crew-timeclock`, `crew-availability`, `crew-comp`, `crew-documents`, `crew-score`, `timeclock/*` (10 modules), `timeoff`, `timesheets`, `time-corrections`, `uniform` | `/api/portal/*`, `/api/admin/crew-*`, `/api/admin/timesheets` |
| **Payroll & money** | `pay-statements`, `pay-statement-mutex`, `pay-corrections`, `route-pay`, `finance`, `payments`, `record-payment`, `stripe`, `payment-proof`, `promo`, `tax-readiness` | `/api/admin/pay-statements`, `/api/webhooks/stripe`, `/api/booking/[token]/pay` |
| **Claims** | `claims`, `claim-mutex`, `claim-accrual`, `claim-payroll`, `claim-documents`, `claim-notify`, `claims-report`, `claim-assist` | `/api/admin/claims/*` |
| **AI / estimation** | `app/lib/ai/*` (46), `app/lib/estimation/*` (44), `book-now-ai`, `book-now-confirmation`, `ai-recovery`, `ai-due-index` | `/api/quote/analyze`, `/api/ai/photo-estimate`, `/api/cron/ai-jobs` |
| **Communications** | `notify`, `sms`, `booking-emails`, `messages`, `reminder-engine`, `comms/*` (13) | `/api/webhooks/twilio/*`, `/api/webhooks/email`, `/api/cron/reminders` |
| **Platform control plane** | `platform/release/*` (30), `platform/automation/*` (24), `platform/sync/*` (12), `platform/updates/*` (7), `platform/events/*` (6) | `/api/admin/platform/*`, `/api/admin/release/*`, `/api/automation/*` |
| **Observability** | `alerts`, `health`, `audit`, `observability/pipeline-*`, `platform/observability/{logger,redact,tenant-telemetry}` | `GET /api/health`, `/api/admin/audit`, `/api/admin/alerts` |

### 2.3 Dependency map (direction of allowed imports)

```
   routes / pages
        │  (may import anything below)
        ▼
   domain libs (bookings, routes, claims, pay-statements, staff, …)
        │
        ├──────────────▶ app/lib/rbac.ts            (pure, no I/O)
        ├──────────────▶ app/lib/platform/flags.ts  (pure, no I/O)
        ├──────────────▶ app/lib/kv-lock.ts ────┐
        └──────────────▶ app/lib/redis.ts ◀─────┘
                              │
                              ▼
                platform/tenancy/keys.ts (scopeKey)
                              │
                              ▼
                platform/tenancy/context.ts (AsyncLocalStorage)
```

**Enforced invariants** (each is a CI test, not a convention):

- No module outside `app/lib/redis.ts` and `scripts/tenant-migration` may reference `KV_REST_API_*` — `scripts/bypass-detection.test.ts`.
- No module outside `platform/tenancy/keys.ts` may build a `t:{tenant}:` prefix — same test.
- Every route under `app/api/admin/` must call a server-side guard, and must use a *principal-resolving* guard (not the coarse `requireSession`) — `scripts/authorization-coverage.test.ts`.
- `app/lib/rbac.ts` and `app/lib/platform/flags.ts` are pure and side-effect free, so they are safe to import anywhere including at module scope.

This is a real, enforced architecture — not a diagram in a wiki. It is the single strongest structural property of the system.

### 2.4 Subsystem detail

For each major subsystem: purpose · entry points · dependencies · data created · data consumed · failure behavior.

<details open>
<summary><b>2.4.1 Public intake (quote + instant book)</b> — IMPLEMENTED</summary>

- **Purpose:** convert a website visitor into a persisted `Booking` with a held date and a deposit.
- **Entry points:** `POST /api/quote` (337 LOC), `POST /api/book` (249 LOC), `POST /api/upload`, `POST /api/estimate`, `POST /api/quote/analyze`.
- **Dependencies:** Redis, Vercel Blob, Stripe, Resend, BotID, zippopotam.us, AI Gateway.
- **Creates:** `Booking` (`bk:{token}`), `bk:num:{n}` index, `bk:index` ZSET entry, idempotency claim `bk:idem:{key}`, optional `aiJob` on the booking, funnel analytics events, ops email.
- **Consumes:** `cfg:capacity`, `cfg:blackout`, `cfg:deposit`, promo records, disposal settings, learning calibration.
- **Failure behavior:** intake is aggressively fail-soft. Persistence failure in `/api/quote` is caught and logged; the customer still receives their estimate (`app/api/quote/route.ts` — `catch (e) { console.error('[quote] persist request', e) }`). AI enqueue failure is recorded as a booking event, not thrown. Stripe checkout failure degrades to a booking-without-payment-link response. Zelle proof-sealing failure is the *only* hard 500 — correctly, since a Zelle booking without proof must not exist.
</details>

<details open>
<summary><b>2.4.2 Durable AI estimation worker</b> — IMPLEMENTED (junk lane) / PLANNED (moving lane)</summary>

- **Purpose:** produce a photo-derived price estimate without ever leaving a customer stranded at "Awaiting AI".
- **Entry points:** `enqueueAiJob()` from `/api/book` and `persistQuoteRequest()`; `GET /api/cron/ai-jobs` (`*/15`); optional post-response kick via `after()` (`OPERION_EVENT_ENQUEUE`, OFF).
- **State model:** the job lives **on the booking** (`booking.aiJob`), not in a separate queue. Status ∈ queued → processing → {completed | manual_review | retrying → failed}. Idempotency key = `book-now-ai:{tenant}:{token}:{photoCount}:{photoFingerprint}`.
- **Selection:** `runDueAiJobs` picks jobs where `isDue()`. Under `OPERION_DUE_INDEX` (OFF) it reads a ZSET; otherwise it falls back to `listBookings(500)`.
- **Failure behavior:** bounded exponential backoff `[1m, 5m, 15m, 1h]`, `MAX_ATTEMPTS = 5`. Permanent error classes (`unsupported_image`, `bot_blocked`, `invalid_schema`, `pricing_validation_failed`) go terminal immediately. A per-job graceful deadline (`AI_JOB_DEADLINE_MS`, default 150s) routes to `manual_review` before Vercel's 300s hard kill, so a job never wedges in `processing`. A circuit breaker (`ai-recovery.ts`) opens on outage-class errors.
- **Known structural hazard, documented in `AGENTS.md` and verified in code:** `isDue()` is false when a booking has **no** `aiJob` at all. A booking that was never enqueued is invisible to the worker *forever*, not merely late. This is why `/api/book` had to add its own `enqueueAiJob` call (PR #175).
</details>

<details open>
<summary><b>2.4.3 Crew portal + timeclock</b> — IMPLEMENTED, with PLANNED enforcement</summary>

- **Purpose:** field staff self-service: clock in/out with GPS, view assigned jobs, upload completion + uniform photos, view pay statements, request corrections and time off.
- **Entry points:** 19 routes under `/api/portal/*`, every one gated by `requireCrew()` which returns the caller's single permitted `staffId`.
- **Authorization model:** `requireCrew` refuses anything that is not `role === 'crew'` **with** a `staffId`, then hands back that id. The stated contract is that handlers must scope every query to `who.staffId` and never trust an id from the body/query. Verified on `clock`, `me`, and by `scripts/crew-portal-authorization.test.ts`.
- **Punch policy:** "one effective open punch per crew member per service date" is enforced at the portal today; extending it to *every* punch ingress is `SINGLE_OPEN_PUNCH_ENABLED` (**OFF**). The materialized index that makes that affordable is `OPEN_PUNCH_INDEX_ENABLED` (**OFF**) and additionally requires a `punchidx:ready` completion marker from a backfill that has **not** been run in production.
- **Failure behavior:** when the index is not authoritative, `punch-policy.ts` falls back to a **complete scan of every route and every booking** and fails *closed* (`coverage_unavailable`) if it cannot prove completeness. The in-code comment records the reason: at production volume the naive version would have consumed a third of the daily Redis request budget on a single clock-in, and the July-31 outage signature was `ERR max requests limit exceeded`.
</details>

<details open>
<summary><b>2.4.4 Operations console</b> — IMPLEMENTED</summary>

- **Purpose:** the day-to-day business surface — bookings, routes, schedule, crew, claims, payroll, finance, reports, communications, settings.
- **Entry points:** 69 pages, ~150 API routes.
- **Structural note:** **62 of 69 admin pages are `'use client'`**, and there is no `app/admin/operations/layout.tsx`. Each page mounts `OperationsShell` independently, so the shell remounts on every navigation and re-runs its session check. This is a known, recorded property; it is a UX/performance issue, not a security one (see §5.3).
</details>

<details open>
<summary><b>2.4.5 Platform control plane (Operion Release / Update / Sync)</b> — PLANNED (inert)</summary>

- **Purpose:** govern releases of the Operion product to tenant businesses — publish review, typed-confirmation owner approval, publish execution, rollback, release history, cross-product sync reconciliation, and CI-driven commit transfer.
- **Entry points:** `/api/admin/platform/*`, `/api/admin/release/*`, `/api/automation/{callback,manifest}`, crons `operion-reconcile` (`*/30`) and `operion-sync` (`10,40 * * * *`).
- **Authorization:** every route is `requirePlatformOwner` — a tier *above* admin, satisfied only by the legacy owner session or a `sub` listed in `PLATFORM_OWNER_SUBS`.
- **Gating:** `OPERION_AUTOMATION_ENABLED` and its six siblings are OFF; `OPERION_SYNC_STATUS_ENABLED`, `OPERION_APPROVAL_GATE_ENABLED` OFF. The `/api/automation/*` endpoints are session-less by design and gated instead by an HMAC signature over `${timestamp}.${rawBody}` with a freshness window and a `deliveryId` replay guard — a correct design for a CI callback.
- **Assessment:** this is roughly **30–40% of the platform library surface** and it does not run. It is well-built and well-tested, but it is carrying cost.
</details>

---

## 3. User journey maps

### 3.1 Customer flow — photo quote → booking → payment → completion

```
[1] Visitor → /quote  (client wizard)
      │
      ├─▶ POST /api/upload            public · rateLimit(upload, 20/10m) · BotID
      │     └─ Blob PUT  quote-photos/{uuid}.{ext}
      │     └─ optional  quote-photos/{uuid}.ai.jpg   ← IMAGE_OPTIMIZATION_ENABLED (OFF)
      │
      ├─▶ POST /api/quote/analyze     interactive photo read (single-shot, budgeted)
      │     └─ runAiTask → AI Gateway → validated JSON → priced → estimate-store
      │
      └─▶ POST /api/quote             rateLimit(quote, 5/10m) · BotID
            ├─ ZIP → zippopotam.us (cached 30d)          ← external, unauthenticated
            ├─ price: disposal engine (junk) or distance formula (delivery)
            ├─ promo validate + apply
            ├─ persistQuoteRequest()  ─▶ commitIdempotently()  ─▶ Booking WRITE
            │      └─ enqueueAiJob() if photos + eligible family
            ├─ after():  processAiJob()      ← OPERION_EVENT_ENQUEUE (OFF) → cron only
            └─ optional guided confirmation → processFinalAiJob() inline (cron recovers)

[2] Visitor → "Book my date" → POST /api/book
      ├─ rateLimit(instantbook, 8/10m) · BotID
      ├─ finalizedBookingToken(idemKey)      ← FINAL checked BEFORE the lease
      ├─ reserveIdempotencyKey(idemKey)      ← renewable lease; 409 if held
      ├─ isDateBookable(date, units)         ⚠️  CHECK-THEN-ACT — see CR-1
      ├─ getDepositCents()
      ├─ Zelle path:  validateProofImage → sealAndStoreProof (Blob) → payment{sent_by_customer}
      ├─ commitIdempotently(idemKey, token, saveBooking)   ← SET NX = the commit point
      ├─ emailOpsBookingCreated()            fail-soft
      └─ Stripe path: checkout.sessions.create(metadata{bookingToken, tenantId, …})
            └─ redirect to hosted checkout

[3] Stripe hosted checkout
      ├─ success_url → GET /api/booking/{token}/stripe-return   (return path recorder)
      └─ webhook     → POST /api/webhooks/stripe                (durable backstop)
            ├─ constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)  ← verified
            ├─ resolveTenantFromStripe(metadata) — null ⇒ skip + ERROR alert (fail closed)
            └─ withBookingWriteLock(token) → dedupe on session.id → recompute()
                  ├─ payments[] += Payment{stripe, confirmed}
                  ├─ status → confirmed  (first time only)
                  ├─ loyaltyCode minted on paid-in-full
                  ├─ onPaymentCaptured()          INTAKE_WORKFLOW_ENABLED (OFF)
                  └─ emails + SMS + owner notify  (skipped when booking.isTest)

[4] Customer link  /booking/{token}
      GET /api/booking/{token} → first-view stamp (chargeback evidence) → customerView()
      Actions: /pay /promo /reschedule /cancel /verify /review /confirm-return /manual-payment

[5] Operations completes the job → status completed
      └─ completion proof photos, review request via cron/daily, invoice/receipt at
         GET /api/booking/{token}/confirmation
```

**Every state transition, write, and failure point in this flow:**

| Step | Redis writes | External calls | Failure behavior | Risk |
|---|---|---|---|---|
| Upload | none | Blob PUT ×1–2 | 400 on bad data URL; derivative failure returns original | low |
| Analyze | `ai:*` telemetry, estimate store | AI Gateway | single-shot (attempts=1); budget/timeout → manual path | med |
| Quote persist | `bk:{token}`, `bk:num`, `bk:index`, `bk:idem:*` | Resend | **swallowed** — customer sees an estimate with no record | **P1** |
| Book | same + `bk:idem:lock:*` | Blob (Zelle), Stripe, Resend | 409 on lease held; 500 only on proof seal failure | low |
| Capacity check | none | none | **no reservation** — TOCTOU | **P0** |
| Stripe return | booking doc | Stripe retrieve | dedupe on session id | low |
| Stripe webhook | booking doc | Stripe retrieve | returns **200 on handler error** by design; return path reconciles | med |
| Customer view | booking doc | Resend | best-effort | low |

> **Finding CF-1 — a quote can be shown to a customer that was never recorded.**
> **Evidence:** `app/api/quote/route.ts`, the `try { … persistQuoteRequest … } catch (e) { console.error('[quote] persist request', e) }` block; the estimate response is returned regardless.
> **Impact (business):** a customer is quoted a price the business has no record of. There is no alert, no retry, and no dead-letter — only a `console.error`. At the volume the site runs, a Redis blip during a marketing burst is exactly when this bites.
> **Recommendation:** route the catch through `alert({ type: 'quote_persist_failed', severity: 'ERROR' })` and write a minimal lead record to a fallback key so the contact is never lost.
> **Priority: P1.**

### 3.2 Crew flow — invitation → onboarding → work → pay

```
[1] Invitation                  IMPLEMENTED (admin-created, no self-serve invite)
      Admin (users:manage) → POST /api/admin/users
        ├─ role validated by isRole(); crew MUST carry a staffId that resolves
        ├─ passwordPolicyError(password) enforced server-side
        ├─ createUser → platform:user:{id} + platform:user:email:{norm}
        └─ audit row (never the password)
      ⚠️ There is NO invitation email / token / self-set-password flow.
         An admin chooses the crew member's initial password and must convey it
         out of band.  → GAP CR-A (P2)

[2] Authentication
      POST /api/auth/login  { email, password }
        ├─ rl:userfail:{ip}:{email}   8 attempts / 15 min   (IP+email keyed)
        ├─ constant-time-ish: verifyPassword runs against a dummy hash when the
        │  user does not exist, so existence does not leak by timing
        ├─ !user.active → 403 "suspended"
        ├─ listActiveMembershipsForUser → resolveLogin
        │     ├─ 0 memberships → 403 NO_MEMBERSHIP
        │     ├─ 1 membership  → session token {sub, role, staffId, tid, mid}
        │     └─ >1            → PENDING token (roleless, 5-min) → /login/organization
        └─ Set-Cookie jk_admin_session  httpOnly secure sameSite=lax  2h absolute
      proxy.ts then slides a 10-minute idle window forward on every request.

[3] Portal access                every /api/portal/* → requireCrew(req) → staffId
      GET  /api/portal/me            own Staff + User record only
      GET  /api/portal/jobs          listBookings(500) + routes, filtered to staffId
      POST /api/portal/clock         punch in/out + GPS
            ├─ crewUsesTimeclock(staffId)      opt-in per staff member
            ├─ listClockableForStaff(staffId)  ← authorization is the target list
            ├─ punch policy (flag OFF today; portal-local rule still applies)
            └─ mutateRoute / booking write under the route mutex
      POST /api/portal/uniform       daily uniform photo
      POST /api/portal/upload        presigned completion-photo upload
      GET  /api/portal/pay-statements[/id]     own statements only
      POST /api/portal/pay-correction          submits a request; never mutates pay
      POST /api/portal/timeoff  /availability  /ack  /messages  /documents

[4] Assignment                   PLANNED for bookings, IMPLEMENTED for routes
      Routes:   admin assigns → assignees[] on rt:{token} → SMS confirm link
                → GET/POST /api/route/{token}  (per-assignee confirm token, rt:atok:)
      Bookings: BOOKING_ASSIGNMENT_ENABLED — flag is LIVE in production per the
                operator's own verification; the crew portal Jobs tab is served.

[5] Payroll
      computePay(start, end)  ← listRoutes(2000) + listBookings(2000) + staff + claims
        ├─ effectivePunch(raw, corrections)     append-only corrections model
        ├─ resolveCompensation(snapshot | legacy payCents)
        └─ claim deductions applied via claim-payroll
      POST /api/admin/pay-statements   (pay:generate)
        └─ withPayStatementLock({staffId, periodStart, periodEnd})
             ├─ 30s lease, 10s heartbeat, 60 attempts × 100ms
             ├─ findByPeriod()  duplicate check INSIDE the lock
             ├─ lock.assertHeld()  immediately before the first write
             └─ nextStatementNumber() (INCR) → saveStatement()
```

> **Finding CR-A — no crew invitation/onboarding flow exists.**
> **Evidence:** `app/api/admin/users/route.ts` accepts a plaintext `password` chosen by the admin; no token-mint, no email, no forced rotation. `POST /api/portal/password` allows a later self-change.
> **Impact (system/security):** initial credentials travel out of band (text message, verbal). There is no forced first-login rotation and no proof the crew member ever changed it.
> **Recommendation:** mint a single-use, short-TTL onboarding token; email/SMS a set-password link; force rotation on first login.
> **Priority: P2.**

### 3.3 Admin flow

```
[1] Login
      Legacy owner:  POST /api/admin/auth  { password }
            ├─ rl:adminfail:{ip}   5 / 15 min   (IP only — see AZ-4)
            ├─ SHA-256 digest comparison, fixed-length, non-short-circuiting
            └─ session token with NO sub/role  → resolves to owner admin, DEFAULT_TENANT
      Named user:    POST /api/auth/login   (as §3.2)

[2] Page load  /admin/operations
      proxy.ts: crew principal → 302 /portal   (or 403 for /api/admin)
      Page is 'use client'; OperationsShell calls useAdminSession() → GET /api/admin/session
      Unauthenticated ⇒ the shell renders a password prompt.  The PAGE ITSELF is
      served to anyone; only its DATA is gated.  → AZ-3

[3] Working surfaces (all server-gated on a permission)
      bookings           requireStaffSession        /api/admin/bookings[, /export, /[id]]
      routes             routes:manage/​view          /api/admin/routes*
      schedule           requireStaffSession        /api/admin/schedule
      crew               crew:manage / crew:view    /api/admin/crew-*, /staff, /users
      claims             claims:manage              /api/admin/claims*
      payroll            pay:generate / pay:approve /api/admin/pay-statements, /routes/pay
      finance            profitability:view         /api/admin/finance
      reports            reports:view               /api/admin/reports*
      comms              messages:send / dispatch   /api/admin/comms*, /communications*
      settings           settings:manage            /api/admin/policy, /moving-settings
      audit              audit:view (admin only)    /api/admin/audit
      permissions        permissions:view (RO)      /api/admin/permissions
      AI control centre  ai:analytics               /api/admin/ai/*
      platform           requirePlatformOwner       /api/admin/platform/*, /release/*
```

**Manager vs admin boundary (verified in `app/lib/rbac.ts`):** managers are explicitly denied `roles:manage`, `settings:manage`, `integrations:manage`, `pay:configure`, `pay:approve`, `tax:view`, `profitability:view`, `accounts:suspend`, `audit:view`, `applicants:decide`, `crew:manage`, `ai:prompts:manage`. They **are** granted `time:manage` (append-only punch corrections) and `pay:adjust:submit` (submit for admin approval). This separation is coherent and is asserted by `scripts/manager-authz.test.ts` and `scripts/rbac.test.ts`.

---

## 4. Data architecture

### 4.1 Storage substrate

**Single store: Upstash Redis over the REST API.** Accessed only through `app/lib/redis.ts`, which exposes a deliberately narrow command set: `GET SET DEL ZADD ZREM ZRANGE ZREVRANGE ZRANGEBYSCORE ZCARD INCR EXPIRE PEXPIRE HINCRBY HGETALL PFADD PFCOUNT SET-NX-PX EVAL`.

Notably **absent: `KEYS`, `SCAN`, `MGET`, pipelines, transactions.** Consequences that shape the whole architecture:

- Every list operation is "read a ZSET page, then one `GET` per member" — **O(n) REST round trips**.
- There is no way to enumerate a key family; every index must be maintained by hand at write time.
- There are no multi-key transactions, so cross-document consistency is application-enforced via locks and CAS.

Secondary stores: **Vercel Blob** (photos, sealed payment proof, crew documents — tenant-scoped paths via `platform/tenancy/blob-keys.ts`) and **Vercel Edge/env** (feature flags, secrets).

### 4.2 Entity catalogue

| Entity | Source of truth | Keys | Lifecycle | Created by | Updated by | Deleted by | Owner |
|---|---|---|---|---|---|---|---|
| **Booking** | `bk:{token}` JSON doc (aggregate root: payments, events, assignees, aiJob, aiEstimate, reminders all nested) | `bk:{token}`, `bk:num:{n}`, `bk:index` ZSET(updatedAt), `bk:counter`, `bk:invcounter`, `bk:inforeq:{t}`, `bk:idem:{k}`, `bk:idem:lock:{k}`, `bk:wlock:{token}` | draft/created → viewed → time_verified → confirmed → completed \| cancelled \| refunded | `POST /api/book`, `persistQuoteRequest()` | `updateBooking` (CAS) or `withBookingWriteLock` (lease) | `deleteBooking` (admin) | Bookings lane |
| **Route** (B2B job) | `rt:{token}` JSON doc (assignees nested) | `rt:{token}`, `rt:num:{n}`, `rt:atok:{t}` → route token, `rt:index`, `rt:lock:{token}` | draft → assigned → text_sent → confirmed/declined → completed | admin / template materialization | `mutateRoute` under `withRouteLock` | admin | Routes lane |
| **Staff** | `staff:{id}` | `staff:{id}` + index | active / inactive; `usesTimeclock` opt-in | admin | admin | soft (deactivate) | Crew |
| **User** (login) | `platform:user:{id}` | + `platform:user:email:{norm}`; legacy `user:*` still read | active / suspended | `POST /api/admin/users` | admin, self (password) | admin | Identity |
| **Membership** (tenant↔user) | `platform/tenancy/membership` store | per-user + per-tenant indexes | active / revoked | Wave 6 backfill (**not applied**) | admin | admin | Tenancy |
| **Customer** (CRM) | `cust:{id}` | + `cust:email:{norm}`, `cust:phone:{digits}` | derived/projected from bookings | `customer-link.ts` on booking write | projection | none | CRM |
| **Claim** | `clm:{id}` (aggregate: assignments + money ledger) | `clm:{id}`, `clm:num:{n}`, `clm:lock:{id}` | open → assigned → accruing → resolved (terminal) | admin | `mutateClaim` under `withClaimLock` | none (terminal) | Claims |
| **PayStatement** | `paystmt:{id}` | + `paystmt:staff:{id}`, `paystmt:period:{staff}:{start}:{end}`, `paystmt:lock:…` | generated → issued → void | `POST /api/admin/pay-statements` | void only | never | Payroll |
| **Punch** | **nested inside Route/Booking assignee** — `clockInAt` / `clockOutAt` | index: `punchidx:open:{staff}:{bucket}`, `punchidx:loc:{punchId}`, `punchidx:ready`, `punchidx:buckets` | open → closed; corrections are append-only (`tcorr:*`) | crew portal clock | portal + admin corrections | never | Timeclock |
| **AI job** | **nested on the Booking** — `booking.aiJob` | due index `aidue:*` (flag-gated) | queued → processing → completed \| manual_review \| retrying → failed | `enqueueAiJob` | cron worker | never | AI |
| **AI telemetry** | `ai:call:{id}`, `ai:cost:{tenant}:{day}` | platform-global (never tenant-prefixed) | 40-day TTL on cost counters | `recordAiCall` | append-only | TTL | AI |
| **Audit** | `audit:{id}` + index | append-only | `pushAudit` / `audit.ts` | never | never | Governance |
| **Business** (B2B account) | `biz:{key}` **and** `biz:id:{stableId}` + `biz:byname:{norm}` | dual-identity — see DA-2 | admin | admin | admin | Routes lane |
| **Message** | `msg:{id}` | `msg:booking:{t}`, `msg:phone:{e164}`, `msg:staff:{id}`, `msg:pid:{providerId}` (dedupe) | inbound/outbound, unread flag | webhooks + admin | read state | none | Comms |
| **Tenant / token binding** | `platform:*` + token binding index | platform-global | — | `bindBookingToken` on every booking save | — | — | Tenancy |

### 4.3 Duplicate sources of truth

> **Finding DA-1 — the customer record is a projection, not a record.** `Customer` (`cust:*`) is derived from bookings by `customer-link.ts` / `customer-timeline.ts`. The booking remains authoritative for name/email/phone. Editing a customer does not retro-update their bookings, and the timeline is recomputed on read.
> **Impact (business):** the CRM view can disagree with the booking a crew member is looking at.
> **Recommendation:** document the projection direction explicitly in the admin UI ("derived from bookings"), or make the customer authoritative and have bookings reference `customerId`.
> **Priority: P2.**

> **Finding DA-2 — businesses have two identity schemes simultaneously.** `app/lib/businesses.ts` defines `bizKey(name)` (name-derived, `biz:{key}`) **and** `newBizId()` / `bizIdKey(id)` (stable id, `biz:id:{id}`) plus a `biz:byname:` bridge, with a live predicate `isNameDerivedBizKey()` that detects un-migrated records.
> **Impact (system):** renaming a business under the legacy scheme orphans its records; the migration is visibly incomplete (the detection helper exists precisely because both forms are live).
> **Recommendation:** complete the stable-id migration and delete `bizKey`-as-primary; keep `biz:byname:` as a lookup only.
> **Priority: P2.**

> **Finding DA-3 — payroll-relevant punches live inside two different aggregates.** A punch is a field on a Route assignee *or* a Booking assignee. `computePay`, `timesheets`, `gps-compliance`, and `punch-policy` each have to load **both** collections and merge. `open-punch-index` exists solely to make one question answerable without that double scan.
> **Impact (system):** any new punch-consuming feature must independently rediscover the merge, and each does so with its own cap (`listBookings(500)` in `crew-timeclock`, `1000` in `timesheets`, `2000` in `route-pay`) — meaning three features can disagree about the same week's hours.
> **Recommendation:** promote punches to a first-class `punch:{id}` entity with a per-staff-per-period index; keep the nested field as a denormalized cache.
> **Priority: P1.**

### 4.4 Missing indexes

- **No per-business route index.** `listRoutes(limit)` reads a single global ZSET. Filtering by business is done in memory. Contract-ending and per-business reporting therefore cap out at the scan limit (2,000).
- **No per-date booking index.** Availability computes date occupancy by scanning `listBookings(1000)` and bucketing in memory (`app/lib/availability.ts:80–108`). There is no `bk:date:{YYYY-MM-DD}` set. This is the direct cause of both **CR-1** and **SC-1**.
- **No per-staff booking index.** `GET /api/portal/jobs` reads `listBookings(500)` and filters. A crew member's job list is therefore only correct while the tenant has fewer than 500 recently-updated bookings.
- **No per-status booking index.** Every status-filtered admin view scans.

### 4.5 Missing constraints

Redis enforces nothing; every constraint is application-level. Verified enforcement:

| Constraint | Enforced? | Where |
|---|---|---|
| Unique booking number | ✅ atomic `INCR` on `bk:counter` | `nextBookingNumber` |
| One booking per idempotency key | ✅ `SET NX` on the FINAL key is the commit point | `booking-idempotency.ts` |
| `bk:num:{n}` never re-pointed | ✅ guarded write | `bookings.ts:504` comment + `bindBookingToken` |
| One pay statement per crew+period | ✅ lock + in-lock duplicate check + `assertHeld` | `pay-statement-mutex.ts` |
| One Stripe payment per session id | ✅ dedupe on `stripeSessionId` under the booking lease | `record-payment.ts` |
| One inbound message per provider id | ✅ `msg:pid:` claim | `messages.ts` |
| One open punch per crew per date | ⚠️ **portal only**; global enforcement flag OFF | `punch-policy.ts` |
| Daily job capacity | ❌ **not enforced under concurrency** | `availability.ts` — see CR-1 |
| Referential integrity (assignee→staff, claim→route) | ❌ none | — |

### 4.6 Migration risks

1. **Wave 6 per-tenant auth backfill has NOT been applied.** Memberships are the authority for login role/tenant when tenancy is on; without the backfill, enabling `TENANCY_ENABLED` yields `NO_MEMBERSHIP` 403s for existing users. **P1 blocker for the tenancy flip.**
2. **`punchidx:ready` backfill has not been run in production.** `OPEN_PUNCH_INDEX_ENABLED` is inert until it is.
3. **Legacy key readers still live:** `user:*` (pre-`platform:user:*`), `'PENDING'` and bare-token idempotency encodings, `biz:{name}` keys. All are tolerated by design, all are technical debt with a real deletion date pending.
4. **Dual-write / dark-launch machinery exists and is OFF** (`TENANCY_DUAL_WRITE`, `TENANCY_DARK_LAUNCH`). It is the correct migration tooling; it has not been exercised in production.

---

## 5. Security assessment

### 5.1 Authentication — IMPLEMENTED, sound

| Property | Implementation | Assessment |
|---|---|---|
| Token format | HMAC-SHA256 over base64url JSON: `{iat, exp, idleExp, sub, role, staffId, tid, mid, pend}` | Stateless, tamper-evident. A crew member cannot edit `role` without invalidating the signature. |
| Signing key | `ADMIN_SESSION_SECRET`, min 16 chars, **throws** if absent | Correct: explicitly refuses to fall back to `ADMIN_PASSWORD`, with the reasoning recorded in-file. |
| Absolute lifetime | 2 hours, never slides | Good. |
| Idle lifetime | 10 minutes, slid forward in `proxy.ts` on every authenticated admin/portal request | Good. Preserves `sub`/`role`/`staffId` across the slide — a documented past bug. |
| Signature comparison | Constant-time loop over equal-length base64 strings | Correct for fixed-length HMACs. |
| Password comparison (legacy owner) | SHA-256 both sides, then fixed-length non-short-circuiting XOR | Correct; also hides password *length*, which a naive length check would leak. |
| Cookie | `httpOnly; secure; sameSite=lax; path=/` | Correct. `lax` is right for a redirect-based Stripe return. |
| Revocation | ❌ **none** | See AS-1. |
| Refresh | Idle-window slide only; no refresh token | Appropriate for a 2h cap. |
| Impersonation | ❌ no impersonation feature exists | Good — nothing to abuse. |
| Tenant selection | 5-minute roleless `pend:1` token; `getPrincipal` **refuses it**; only unlocks `POST /api/auth/tenant` | Excellent design. Addresses the PRIV-1 escalation class directly. |

> **Finding AS-1 — sessions cannot be revoked.** The token is stateless and there is no server-side denylist. Suspending a user (`user.active = false`) blocks *new* logins but a live session continues to work for up to its remaining 2h/10-min-idle window.
> **Evidence:** `app/api/admin/_lib/session.ts` — `getPrincipal` performs pure crypto with no store read ("Pure crypto (no Redis) so it is safe to call from middleware").
> **Impact (security):** terminating a crew member or a compromised admin does not immediately cut access.
> **Recommendation:** add a `sess:revoked:{sub}` epoch key checked in `slideSessionToken` (already a per-request Redis-adjacent path) rather than in `getPrincipal`; bump the epoch on suspend/role-change/password-change. This preserves the middleware's no-Redis property while capping exposure at one slide interval.
> **Priority: P1.**

> **Finding AS-2 — the legacy shared-password owner account is still the platform-owner authority.** `isPlatformOwner()` returns true for `sub === 'owner'`, i.e. anyone holding `ADMIN_PASSWORD`. That single shared secret is the highest privilege in the system (Release Center, publish, rollback, sandbox repair, seed).
> **Evidence:** `app/api/admin/_lib/session.ts` — `isPlatformOwner`; `app/api/admin/auth/route.ts`.
> **Impact (security):** no per-person attribution for the most destructive operations; no MFA; rotation invalidates nothing else but is the only mitigation.
> **Recommendation:** move platform ownership exclusively to named `PLATFORM_OWNER_SUBS` entries and retire the `sub === 'owner'` shortcut once a named owner account exists.
> **Priority: P1.**

> **Finding AS-3 — no MFA anywhere.** Admin, manager, crew, and platform owner all authenticate with a single factor.
> **Impact (security):** a phished or reused password is complete account takeover, including payroll and claims.
> **Recommendation:** TOTP for `admin` and platform-owner roles at minimum.
> **Priority: P2** (P1 if the platform takes a second paying tenant).

### 5.2 Authorization — IMPLEMENTED, with a CI-enforced floor

The model is a single role × permission matrix (`app/lib/rbac.ts`, 3 roles × 60 permissions), consulted by five guard functions that each return either a `Principal` or a ready-to-return `NextResponse`. **Three defense layers:**

1. **`proxy.ts` RBAC choke** — a crew principal is blocked from `/admin` and `/api/admin` centrally, regardless of any missed per-route check.
2. **Per-route guard** — `requirePermission` / `requireStaffSession` / `requireAdmin` / `requirePlatformOwner` / `requireCrew`.
3. **CI gate** — `scripts/authorization-coverage.test.ts` fails the build if any `app/api/admin/**/route.ts` lacks a principal-resolving guard, and separately if any of them uses the coarse `requireSession`.

### 5.3 Authorization coverage matrix

Compiled by static sweep of all 225 route files. `withTenantRoute` establishes tenant context but is **not** an authorization control.

#### Admin / operations surface (~150 routes)

| Route family | Role required | Current protection | Risk |
|---|---|---|---|
| `/api/admin/bookings*`, `/schedule`, `/book-now`, `/shipments`, `/reviews`, `/disposal*`, `/events`, `/approvals`, `/upload`, `/blob-upload`, `/estimator-diagnostics`, `/shadow-diagnostics` | admin \| manager | `requireStaffSession` | Low |
| `/api/admin/routes*`, `/route-templates*`, `/route-invoices*`, `/equipment`, `/fleet/*`, `/businesses` | per-permission (`routes:manage`, `equipment:*`, `fleet:maintenance`, `businesses:manage`) | `requirePermission` | Low |
| `/api/admin/crew-*`, `/staff`, `/users*`, `/permissions`, `/careers*` | `crew:*`, `users:manage`, `permissions:view`, `applicants:*` | `requirePermission` (+ `requireAdmin` on `/staff` DELETE, `/careers/doc`) | Low |
| `/api/admin/pay-statements*`, `/pay-corrections`, `/routes/pay`, `/crew-compensation`, `/finance` | `pay:generate`, `pay:approve`, `pay:view:all`, `profitability:view` | `requirePermission` | Low |
| `/api/admin/timesheets`, `/time-corrections`, `/timeoff`, `/punch-overlaps`, `/gps-compliance`, `/operations/punch-index` | `time:view`, `time:manage`, `timeoff:approve` | `requirePermission` | Low |
| `/api/admin/claims*` | `claims:manage` / `claims:create` | `requirePermission` | Low |
| `/api/admin/audit` | `audit:view` (**admin only** — manager excluded) | `requirePermission` | Low |
| `/api/admin/ai/*` (12 routes), `/ai-recovery`, `/moving-settings`, `/release`, `/alerts`, `/reminder-settings`, `/automation` | `ai:analytics` / `ai:prompts:manage`, else `requireAdmin` | `requirePermission` / `requireAdmin` | Low |
| `/api/admin/ai-alerts`, `/ai-config`, `/ai-overview`, `/ai-queue`, `/ai-settings`, `/shadow-*` (8) | **platform owner** | `requirePlatformOwner` | Low |
| `/api/admin/platform/**` (14), `/api/admin/release/**` (14) | **platform owner** | `requirePlatformOwner` | Low — but see AS-2 |
| `/api/admin/session` | any live session | `getPrincipal` (identity probe; explicitly allowlisted in CI) | Low |
| `/api/admin/auth`, `/api/admin/logout` | none (mints/clears) | rate-limited | Low |
| `/api/admin/opspilot-waitlist` | `requirePermission` | ⚠️ **no `withTenantRoute`** | Low (platform-global `opspilot:` keys) |

#### Crew portal (19 routes)

| Route | Role required | Protection | Risk |
|---|---|---|---|
| all `/api/portal/*` | `crew` **with** `staffId` | `requireCrew` → returns the single permitted `staffId`; handlers must scope to it | **Low, contract-dependent** — see AZ-1 |

#### Public / customer surface

| Route | Auth | Protection | Risk |
|---|---|---|---|
| `/api/quote`, `/api/book`, `/api/estimate`, `/api/contact`, `/api/careers/*`, `/api/coi`, `/api/track`, `/api/availability`, `/api/shipments/lookup` | none | `rateLimit` + `isBlockedBot` (BotID) + `withTenantRoute` | Low–Med |
| `/api/upload`, `/api/intake/config`, `/api/operion/demo`, `/api/quote/progress-calibration`, `/api/ai/photo-estimate` | none | `withPublicHostRoute` (tenant from verified Host) + rate limit | Low |
| `/api/booking/[token]/**` (11) | **bearer-token** = the unguessable booking token | `withTenantRoute` + inner `resolveTenantFromResource` | **Med** — see AZ-2 |
| `/api/invoice/[token]`, `/api/client/[token]`, `/api/route/[token]`, `/api/ack/[token]`, `/api/verify/[id]`, `/api/quote/status/[token]`, `/api/quote/resume/[token]` | bearer-token | `withPublicTokenRoute` — resolves the tenant from the token binding *before* the handler; uniform 404 for unknown/foreign tokens | Low |
| `/api/opspilot/waitlist` | none | rate-limited | Low |

#### Machine-to-machine

| Route | Auth | Protection | Risk |
|---|---|---|---|
| `/api/cron/{daily,reminders,ai-jobs,vision-shadow,shadow-alerts,operion-reconcile,operion-sync}` | `Authorization: Bearer ${CRON_SECRET}` | **fails closed** if the secret is unset | Low |
| `/api/cron/route-auto-cancel` | same, inside `runAutoCancelJob` | fails closed; **not registered in `vercel.json`** — manual-drive only, by design | Low |
| `/api/webhooks/stripe` | `stripe.webhooks.constructEvent` | signature verified; 503 if unconfigured | Low |
| `/api/webhooks/twilio/{sms,status}` | `verifyTwilio` signature | verified | Low |
| `/api/webhooks/email` | `?key=` vs `EMAIL_WEBHOOK_SECRET`, `timingSafeEqual` | **fails closed (503)** when unset — explicitly hardened from a prior fail-open | Low |
| `/api/automation/{callback,manifest}` | HMAC over `${ts}.${rawBody}` + freshness + `deliveryId` replay guard | flag-gated OFF; fail-closed | Low |
| `/api/diagnostics/{ai-provider,curate,analysis/[id]}` | **three gates**: 404 in Production regardless of flags · flag OFF by default · Preview deployment protection | Low |
| `/api/health` | public minimal; detailed via admin session **or** `HEALTH_CHECK_SECRET` | Low |

> **Finding AZ-1 — crew scoping is a convention, not a mechanism.** `requireCrew` hands the handler a `staffId` and the contract is "scope every query to it." Nineteen handlers each honour that by hand. Nothing structurally prevents a future handler from reading `body.staffId`.
> **Evidence:** `app/api/portal/_lib/crew.ts` — "Portal handlers must scope every query to `who.staffId` — never trust an id from the request body or query string."
> **Mitigation already present:** `scripts/crew-portal-authorization.test.ts` and `scripts/hardening-portal-abuse.test.ts`.
> **Recommendation:** extend the CI authorization-coverage gate to `app/api/portal/**`: assert every handler references `who.staffId` and that no portal handler reads a `staffId` from `body`/`searchParams`. This converts the convention into an invariant, exactly as was done for `/api/admin`.
> **Priority: P2.**

> **Finding AZ-2 — customer booking-token API routes are tenancy-blocked.** All 11 `/api/booking/[token]/*` routes are wrapped in `withTenantRoute`, which resolves the tenant from the **signed session**. A customer following an emailed link has no session. With `TENANCY_ENABLED=true`, `withTenantContextFromRequest` throws (`tenant context required`) *before* the handler runs — so the inner `resolveTenantFromResource(booking, …)` calls those routes carefully perform are **unreachable**. Sibling public-token routes (`invoice`, `client`, `route`, `ack`, `verify`, `quote/status`, `quote/resume`) correctly use `withPublicTokenRoute`.
> **Evidence:** `app/lib/platform/tenancy/request-context.ts:24–27`; `app/api/booking/[token]/route.ts:12,28`; contrast `app/api/invoice/[token]/route.ts`. (`stripe-return` does resolve a tenant, but from Stripe *session metadata* via `resolveTenantFromStripe` — a different authority from the other ten, and equally unreachable behind the same outer wrapper.)
> **Impact (customer):** not a live defect — `TENANCY_ENABLED` is `false`. It is a **hard blocker on the tenancy flip**: turning the flag on would 500 the entire customer post-booking surface (view, pay, reschedule, cancel, receipt).
> **Recommendation:** migrate all 11 routes to `withPublicTokenRoute({ expect: 'booking' })` and delete the now-redundant inner resolution. `stripe-return` needs care: its authority is Stripe metadata, so reconcile the two resolutions rather than dropping either.
> **Priority: P1** (P0 the moment a tenancy rollout is scheduled).

> **Finding AZ-3 — admin and portal pages are gated client-side only.** `app/admin/layout.tsx` renders `<>{children}</>` with no auth check. 62 of 69 admin pages are `'use client'`. `proxy.ts` blocks *crew* principals from `/admin`, but an **unauthenticated** request receives the full page bundle; `OperationsShell` then renders a password prompt after `GET /api/admin/session` returns unauthenticated.
> **Evidence:** `app/admin/layout.tsx`; `app/admin/operations/OperationsShell.tsx:80,172`; `proxy.ts` (the RBAC choke is inside `if (… && token)` — no token means no block).
> **Impact (security):** **no data exposure** — every data path is server-guarded, which is the control that matters. The exposure is the admin JS bundle: route names, field names, component structure, and the shape of the operations surface, which is reconnaissance value. It also means `/admin` is a soft target for credential-stuffing UI, and `robots` noindex is the only thing keeping it out of search.
> **Recommendation:** add an unauthenticated-redirect for `/admin` and `/portal` page requests in `proxy.ts` (it already parses the token), so the bundle is never served to an anonymous caller.
> **Priority: P2.**

> **Finding AZ-4 — legacy admin login is rate-limited per IP only.** `rl:adminfail:{ip}`, 5 per 15 min, and it **fails open** on a Redis error. The named-user login is correctly keyed on IP+email.
> **Evidence:** `app/api/admin/auth/route.ts`.
> **Impact (security):** distributed guessing of the single shared `ADMIN_PASSWORD` is not meaningfully slowed, and a Redis outage removes the limiter entirely at the exact moment the system is stressed.
> **Recommendation:** add a global (non-IP-keyed) failure counter for the shared-password endpoint with a lockout, and prefer Vercel WAF rate limiting as a second layer that survives a KV outage.
> **Priority: P2.**

### 5.4 Other security observations

- **No Content-Security-Policy.** `proxy.ts` sets `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, and `Referrer-Policy`, and the comment states CSP was consciously skipped because the app relies on inline styles. **Finding SEC-1, P2:** the admin surface handles payroll and tax data; a nonce-based CSP restricted to `/admin` and `/portal` is achievable without touching the marketing pages.
- **No CSRF tokens.** Mitigated by `sameSite=lax` cookies plus JSON-only request bodies (a cross-site form post cannot set `content-type: application/json` without CORS preflight). Acceptable, but it is a single-layer defense. **P3.**
- **PII redaction is centralized and good** — `platform/observability/redact.ts` masks by key pattern *and* by value pattern (bearer, long hex, email, phone, SSN). `alerts.ts` independently constrains its payload to safe fields.
- **Payment proof is encrypted at rest** — `doc-crypto.ts` + `sealAndStoreProof`; Zelle screenshots never land unencrypted in Blob.
- **Photo URLs are host-filtered** — `filterPhotoUrls` restricts to the app's own Blob host, so an attacker cannot get an arbitrary URL into an ops inbox or in front of the vision model.
- **Tenant header spoofing is blocked at the edge** — `proxy.ts` deletes `x-tenant-id` from every inbound request before any handler sees it.
- **BotID** is wired via `withBotId(nextConfig)` and checked on all public write endpoints.

---

## 6. Concurrency assessment

### 6.1 Primitives inventory

| Primitive | File | Guarantee | Used by |
|---|---|---|---|
| `SET NX PX` | `redis.setNxPx` | atomic acquire-if-absent with TTL | every lock below |
| Compare-and-delete (Lua) | `kv-lock.releaseIfOwned` | release only while still owner | all locks |
| Compare-and-extend (Lua) | heartbeat in `kv-lock` / `pay-statement-mutex` | can only prolong one's own lock | booking lease, pay statement, idempotency lease |
| Compare-and-set (Lua) | `kv-lock.compareAndSet` | advance a state machine from an exact observed state | booking idempotency claim |
| Versioned CAS (Lua, cjson) | `bookings.CAS_SCRIPT` + `optimisticUpdate` | lost-update-free pure-data writes with bounded retry | `updateBooking` |
| `INCR` / `INCRBYFLOAT` | `redis.incr`, budget Lua | atomic counters | booking/invoice/statement numbers, AI cost |

`app/lib/kv-lock.ts` is the canonical implementation and its header records the exact bug that motivated it (LOCK-1): *A acquires → work outruns TTL → key expires → B acquires → A finishes and unconditionally DELs → B's lock is gone.* Reproduced against the real `withBookingWriteLock` during the audit. Every lock in the system now uses a unique per-acquisition token.

### 6.2 Per-domain analysis

| Domain | Operation | Race | Duplicate-execution risk | Locking | Idempotency | Retry | Recovery |
|---|---|---|---|---|---|---|---|
| **Bookings — intake** | create | double-submit / retry | **closed** | `bk:idem:lock:{k}` renewable lease | `SET NX` on `bk:idem:{k}` is the commit point; `claimed`→`committed` CAS; `committed` terminal | client retry | claim takeover only when *provably* uncommitted (booking record absent) |
| **Bookings — capacity** | hold a date | **two bookings for one slot** | **OPEN** | ❌ none | ❌ none | — | manual | 
| **Bookings — data edits** | update | lost update | closed | versioned CAS + retry | mutate re-runs on fresh copy → no duplicate events | 5 attempts | — |
| **Bookings — side-effect ops** | Stripe/model/SMS | double side effect | closed | `bk:wlock:{token}` lease, heartbeat, `assertHeld` available | — | `onBusy` decides | lease self-expires |
| **Payments** | record Stripe payment | webhook + return path both fire | closed | booking write lease | dedupe on `stripeSessionId` | Stripe retries; handler returns **200 on error** | return path reconciles |
| **Payments — Zelle** | proof upload | double proof | closed by intake idempotency | — | — | — | owner review |
| **Payroll** | generate statement | **FIN-1: 5 identical POSTs → 5 statements** | **closed** | `paystmt:lock:{staff}:{start}:{end}`, 30s TTL, 10s heartbeat, 60×100ms attempts | in-lock `findByPeriod` + `assertHeld` before first write | 409 "generation in progress" | lease expiry |
| **Payroll** | pay correction | double credit | partially — corrections are append-only, reviewed by admin | — | — | — | — |
| **Routes** | any crew/status mutation | crew blob clobber | closed | `rt:lock:{token}`, 8s, 40×50ms | `mutateRoute` re-reads inside the lock | `RouteBusyError` → retry | lease expiry |
| **Routes — assignee links** | confirm/decline via per-assignee token | two assignees at once | closed | lock taken on the **canonical** route token | re-read inside lock | — | — |
| **Claims** | ledger post / waive / accrual cron | money clobber | closed | `clm:lock:{id}`, 8s | `mutateClaim` re-reads inside lock | `ClaimBusyError` | lease expiry |
| **Timeclock** | clock in | two open punches | ⚠️ **flag-gated** | per-staff `withLock` when `SINGLE_OPEN_PUNCH_ENABLED` (**OFF**) | — | `busy` block | fail-closed on incomplete coverage |
| **AI jobs** | process due job | two workers on one booking | closed | booking write lease + `hasValidEstimate` guard | idempotency key = token+photo fingerprint | bounded backoff, 5 attempts | cron is always the safety net; deadline → `manual_review` |
| **Release / publish / rollback** | platform ops | double publish | closed | `withBusinessLock` per business, unique tokens | approval is single-use + release-bound | — | flag OFF |
| **Messages** | inbound webhook | duplicate delivery | closed | `claimProviderMessage(providerMessageId)` | — | provider retries | claim release on failure |

### 6.3 Concurrency Risk Register

| ID | Area | Risk | Severity | Current protection | Recommendation |
|---|---|---|---|---|---|
| **CR-1** | Bookings / availability | `isDateBookable(date, units)` is read, then the booking is built and saved. No capacity reservation. **N concurrent bookings for the last slot on a date all pass and all persist.** Distinct idempotency keys mean the booking lock does not help. | **P0** | None. `bk:idem:*` is per-*key*, not per-*date*. | Take `withLock('bk:cap:{date}')` around `isDateBookable → commitIdempotently`, or maintain a `bk:date:{d}` units counter incremented atomically and validated post-write with compensation. Add a mutation-checked race test in the style of `scripts/book-idempotency-race.test.ts`. |
| **CR-2** | Bookings / availability | `getAvailability` computes occupancy from `listBookings(1000)`, ordered by `updatedAt`. A future-dated booking that has not been touched recently **falls out of the window** once >1,000 bookings exist, and its slot is silently resold. | **P0** (latent; triggers on volume) | Cap only. No coverage assertion. | Maintain a per-date occupancy index (`bk:date:{YYYY-MM-DD}` → units) updated in `saveBooking`, and compute availability from it in O(daysAhead) reads. |
| **CR-3** | Payroll | `computePay` reads `listRoutes(2000)` + `listBookings(2000)`. Past either cap, hours are silently omitted from a pay statement — and the statement is then *issued* under a lock that guarantees it is the only one. The lock makes a truncated answer permanent. | **P0** (latent) | None. `readBookingsByTokens` reports `missing`, but `listBookings` does not, and `computePay` uses `listBookings`. | Switch `computePay` to the `countBookingIndex` + `scanBookingIndexPage` + `readBookingsByTokens` triple that already exists and *proves* coverage; refuse to generate a statement when coverage is incomplete. |
| **CR-4** | Timeclock | Global single-open-punch enforcement is OFF; the public route-assignee link path can therefore open a second concurrent punch that the portal would refuse. Two open punches = double-counted hours. | **P1** | Portal-local check only. Phase A overlap report exists (`/api/admin/punch-overlaps`). | Read the Phase A report, run the `punchidx` backfill, then enable `OPEN_PUNCH_INDEX_ENABLED` followed by `SINGLE_OPEN_PUNCH_ENABLED`. This is already the documented plan; it is unexecuted. |
| **CR-5** | Payments | The Stripe webhook returns **HTTP 200 even when the handler throws**, deliberately, to stop Stripe retry storms on a KV blip. If the success-URL return path is also missed (customer closes the tab), the payment is captured by Stripe and **never recorded**. | **P1** | Comment asserts "the return-path/idempotent recorder will reconcile" — but nothing *drives* that reconciliation if the customer never returns. | Either return a 5xx for genuinely transient failures so Stripe retries (the recorder is idempotent, so retries are safe), or add a daily reconciliation cron that lists recent Stripe sessions and applies any unrecorded `paid` session. |
| **CR-6** | AI worker | `withLock(..., onStoreError: 'run_unlocked')` — a Redis error during lock acquisition causes the booking write to proceed **unlocked**. Chosen deliberately (availability over serialization). | **P2** | Holder owns no token, so it cannot delete another's lock; damage is limited to a lost update, not a duplicate. | Accept, but record it: emit a `WARNING` alert when `run_unlocked` is taken, so the frequency is known rather than assumed to be zero. |
| **CR-7** | Rate limiting | `rateLimit()` **fails open** on any Redis error, on every public endpoint including `/api/book` and `/api/upload`. | **P2** | Documented tradeoff. BotID still applies. | Add Vercel WAF rate rules as a second layer that does not depend on KV. |
| **CR-8** | Booking numbers | `nextBookingNumber()` is atomic, but is called **before** the idempotency commit in `/api/book`. A losing racer burns a booking number. | **P3** | Harmless — numbers are not required to be gapless. | None; note it so a future "gapless invoice numbering" requirement is not assumed to hold. |
| **CR-9** | Claims accrual | The daily accrual cron and an admin edit both mutate a claim; both go through `withClaimLock`. But `accrueAllClaims` iterates `listClaims(1000)` (`app/lib/claim-accrual.ts:144`) — same truncation family as CR-2/CR-3. | **P1** (latent) | Lock is correct; the *selection* is capped. | Same remedy as CR-3: coverage-proving pagination. |
| **CR-10** | Idempotency claim takeover | Takeover is permitted when a claim has no booking behind it. Correctness rests on the stated precondition "the caller holds the per-key reservation lease." Both call sites do; nothing enforces it. | **P3** | Documented precondition; both intake paths verified. | Make `commitIdempotently` take the `KvLock` handle as a required argument when `key` is set, so the precondition is type-enforced. |

**On the booking-idempotency design specifically:** I attempted to find a hole and did not. The commit point is `SET NX` on the FINAL key, which is clock-free and store-atomic. `committed` is terminal and no transition reads it as a source state. Absence of the booking record — never elapsed time — is the only evidence used to conclude non-commitment. The heartbeat is explicitly *not* load-bearing. The three warnings in `AGENTS.md` (don't add `assertHeld()` before the write; don't tune a TTL to fix a race; fix both intake paths or neither) are each correct, and each is backed by a test file (`book-idempotency-{race,recovery,ownership}.test.ts`). **This subsystem is enterprise-grade.**

---

## 7. AI architecture assessment

### 7.1 Entry points

| Entry point | Trigger | Sync/async | Auth | Flag | Status |
|---|---|---|---|---|---|
| `POST /api/quote/analyze` | customer, in-wizard | **synchronous**, budgeted | public + rate limit + BotID | always on | IMPLEMENTED |
| `POST /api/ai/photo-estimate` | customer | synchronous | `withPublicHostRoute` | always on | IMPLEMENTED |
| `enqueueAiJob` → `GET /api/cron/ai-jobs` | intake, `*/15` | asynchronous, durable | `CRON_SECRET` | always on | IMPLEMENTED |
| `processFinalAiJob` (guided confirmation) | customer confirms | inline + durable fallback | via `/api/quote` | always on | IMPLEMENTED |
| `after()` worker kick | post-response | asynchronous | — | `OPERION_EVENT_ENQUEUE` | PLANNED (OFF) |
| Vision shadow (`/api/cron/vision-shadow`, `0 */6`) | scheduled | asynchronous | `CRON_SECRET` | `VISION_SHADOW_WORKER_ENABLED` | PLANNED (OFF) |
| Shadow alerting (`/api/cron/shadow-alerts`, `30 */6`) | scheduled | asynchronous | `CRON_SECRET` | `SHADOW_ALERTING_ENABLED` | PLANNED (OFF) |
| Claim assist, review reply, ops message drafting | admin | synchronous | `requirePermission('ai:use')` | always on | IMPLEMENTED |
| AI workforce / autonomy registry | — | — | — | `AI_WORKFORCE_ENABLED` | PLANNED (OFF) |

### 7.2 The single chokepoint

Every AI call in the system goes through **`runAiTask()`** in `app/lib/ai/service.ts`. In order:

```
Input (taskId, vars, feature, principal?, schema?, messages?, attempts?, timeoutMs?)
  │
  ├ 1. RBAC              can(principal.role, requiredPermission)  → 403, telemetry written
  ├ 2. Budget            overBudget()  → 429 fail-soft            → AI pauses, app keeps working
  ├ 3. Prompt resolve    built-in version | admin override | A/B arm  (prompt-store)
  ├ 4. Model route       modelForFeature(feature)                  (ai/routing)
  ├ 5. Execute           generateAI() via Vercel AI Gateway
  │                       · attempts = input.attempts ?? 2   (interactive path pins 1)
  │                       · per-call timeoutMs abort
  │                       · classifyError → billing|auth|rate_limit|network|
  │                                          provider_unavailable|other
  │                       · retry only when isTransient(class)
  ├ 6. Cost              provider-reported cost when available, else estimateCostDetailed
  │                       → addCost() atomic INCRBYFLOAT on ai:cost:{tenant}:{day}
  ├ 7. Validate          validateJson(response, schema)  → invalid output is REJECTED
  ├ 8. Quality           scoreResponse() heuristic, read-only
  └ 9. Telemetry         recordAiCall{ id, tenant, actor, role, feature, taskId,
                          promptVersion, promptVariant, model, latency, tokens,
                          estCost, kind, bookingId, jobId, imageCount, queuedAt }
```

**The service is read-only by construction.** It returns validated data; it writes only to the AI audit log and the cost counter. No autonomous business writes. This is the correct architecture for an AI subsystem embedded in a money-handling application, and it is the single best design decision in the AI layer.

### 7.3 The photo-estimate pipeline, end to end

```
INPUT      customer photos (data URL ≤ 8MB, jpeg|png|webp|heic|heif)
   │
VALIDATE   regex on the data URL · size cap · HEIC/HEIF → JPEG (heic-convert, wasm)
   │       filterPhotoUrls() — only our own Blob host reaches the model
   │       photo-quality-gate (shadow) · photo-dedup · photo-set fingerprint
   │
OPTIMIZE   optimizeForModel() → {id}.ai.jpg sibling      ← IMAGE_OPTIMIZATION_ENABLED (OFF)
   │       four higher-risk cleanups each independently gated OFF
   │
ROUTE      serviceFamily(serviceType) → junk | moving | other
   │       junk    → junk-analysis + junk-critic + disposal pricing engine
   │       moving  → moving-analysis + moving-estimate   ← OPERION_MOVING_LANE (OFF)
   │                 with the lane OFF a move is returned UNPRICED for a human
   │                 (never priced by the disposal engine — that fall-through was
   │                  the defect this lane replaces)
   │       other   → never analyzed
   │
PROMPT     ops.junkAnalysis  (v1)  |  ops.junkAnalysisCompact  ← AI_COMPACT_ANALYSIS_PROMPT (OFF)
   │       resolved through prompt-store: built-in / admin override / A/B arm
   │
PROVIDER   Vercel AI Gateway, model chosen by modelForFeature()
   │       interactive: attempts=1, budgeted deadline (interactive-policy)
   │       durable:     attempts=2, AI_JOB_DEADLINE_MS=150s inside maxDuration=300s
   │
RESPONSE   validateJson against analysis-schema{,-v2,-moving}
   │       analysis-monitor  → concerns
   │       junk-critic       → second opinion; OPERION_CRITIC_JSON (OFF) would run it
   │                           on the structured JSON instead of a second vision call
   │       confidence scoring (5 sub-scores) → confidence-routing
   │       photo-text-consistency · photo-reconciliation
   │
PRICE      volume-engine / weight-engine / load-tier → disposal settings + calibration
   │       pricing validation — failure is a PERMANENT error class (no retry)
   │
PERSIST    booking.aiEstimate  +  booking.aiJob.status
   │       aiEstimate carries inputPhotoUrls so hasValidEstimate() can detect
   │       a changed photo set and invalidate rather than serve a stale price
   │
RESULT     customer: projected quote or "manual review"
           owner:    notifyOwnerAiOutcome on completed | manual_review | failed
```

### 7.4 Controls assessment

| Control | Implementation | Assessment |
|---|---|---|
| **Timeout** | per-call `timeoutMs` abort; per-job `AI_JOB_DEADLINE_MS` (150s) below the route's `maxDuration` (300s) | **Strong.** The two-level budget is exactly right: the job routes itself to `manual_review` *before* Vercel hard-kills it, so a job never wedges in `processing`. `FUNCTION_BUDGET_MS = 285s` additionally refuses to *start* a job that cannot finish. |
| **Retry** | 2 attempts in-service (1 for interactive); 5 job attempts with `[1m, 5m, 15m, 1h]` backoff; permanent classes never retry; `no_items` → manual review, not retry | **Strong.** The distinction between "provider failed" (retry) and "model ran and found nothing" (human) is correct and rare to see. |
| **Circuit breaker** | `ai-recovery.ts` — `breakerAllows`, `inProbeWindow`, `recordOutcome`, `isOutageClass` | **Good.** Prevents burning all 5 attempts against a dead provider. |
| **Cost control** | `AI_DAILY_COST_CAP_USD` → `overBudget()` refuses fail-soft with a 429; atomic `INCRBYFLOAT` per tenant per day; 40-day retention for forecasting | **Mechanism strong, configuration weak — see AI-1.** |
| **Schema validation** | `validateJson` against explicit `ObjectSchema`; invalid output is an error, not a fallback | **Strong.** This is the primary hallucination control. |
| **Hallucination controls** | schema validation · `analysis-monitor` concerns · `junk-critic` second opinion · five-factor confidence scoring · `confidence-routing` to human review · `photo-text-consistency` · pricing validation as a permanent-error class · `truck-anchor` per-tenant capacity constants | **Strong and layered.** A low-confidence read routes to a human rather than to a price. |
| **Fallback** | every failure path terminates at `manual_review` (owner hand-prices) rather than a guessed number | **Correct by design.** |
| **Observability** | `recordAiCall` on every call including failures; `AI_PIPELINE_OBSERVABILITY_ENABLED` adds per-stage traces (queue → image → provider → AI → pricing → database → notification); AI Command Center; `/api/admin/ai/*` (12 read surfaces) | **Rich, but flag-gated OFF** — see AI-2. |
| **Prompt governance** | versioned built-ins, admin overrides, A/B arms, `catalog-governance`, rollback; `ai:prompts:manage` is admin-only | **Strong.** |
| **Eval** | `scripts/ai-regression.test.ts` golden fixtures in `predeploy`; `tools/vision-benchmark` with a curated dataset and consensus labeling; LAT-002 latency experiment | **Good, partially executed** — the operator's own notes record 3/5 junk labels verified with 2 pending. |

> **Finding AI-1 — the AI cost cap is unset by default and the cron makes real vision calls every 15 minutes.**
> **Evidence:** `app/lib/ai/budget.ts` — `costCapUsd()` returns `0` (no cap) unless `AI_DAILY_COST_CAP_USD` is set. `vercel.json` schedules `/api/cron/ai-jobs` at `*/15`. `AGENTS.md`: "`/api/cron/ai-jobs` runs `*/15` in Production and makes real vision calls."
> **Impact (business):** a retry storm, a photo-heavy spam burst that clears BotID, or a prompt regression that inflates output tokens has **no financial ceiling**. Multi-photo vision calls are the most expensive operation the system performs.
> **Recommendation:** set `AI_DAILY_COST_CAP_USD` in Production to a value ~3× the observed p95 daily spend, and add an `alert()` at 50%/80% of cap. The mechanism is already built and tested; only the configuration is missing.
> **Priority: P1.**

> **Finding AI-2 — the pipeline observability that would explain a latency regression is off.**
> **Evidence:** `AI_PIPELINE_OBSERVABILITY_ENABLED: false` in `FLAG_DEFAULTS`; `runWithTrace`/`timeStage` are no-ops when off.
> **Impact (system):** when the instant quote is slow, there is no per-stage attribution. The known prior incident (30s × 2 attempts + a vision critic inside a 60s route) was diagnosed by reasoning, not by data.
> **Recommendation:** enable in Preview, then Production. It is explicitly additive, fail-soft, and writes nothing that affects behavior.
> **Priority: P2.**

> **Finding AI-3 — the moving lane is built, proven on one replay, and off.**
> **Evidence:** `AI_PHOTO_ESTIMATE_MOVING: false`, `OPERION_MOVING_LANE: false`; the `supportsPhotoAi` docstring records that a completed moving job was replayed correctly but that "recent probes still saw content refusals on residential interiors."
> **Impact (business):** the moving revenue line gets no AI assistance; a moving booking with photos produces nothing.
> **Assessment:** **this is correct restraint, not a defect.** Content refusals on residential interiors are a real provider behavior and shipping into it would produce unpriceable jobs at volume. Recorded here so the state is deliberate and visible.
> **Priority: P3** (product decision, not an engineering risk).

> **Finding AI-4 — `/api/quote/analyze` performs a synchronous vision call on a customer request.**
> **Evidence:** `app/api/quote/analyze/route.ts`; `app/lib/ai/interactive-policy.ts` pins `attempts=1` and a budget.
> **Impact (customer):** the interactive path is bounded by the route's function ceiling and single-shot, so a transient provider failure is a visible failure to the customer — with the durable job as the recovery. This is the right trade, but it means interactive quote success is directly coupled to provider availability.
> **Recommendation:** none beyond enabling `OPERION_PROGRESS_UX` (built, OFF) so the wait is truthful rather than an opaque spinner.
> **Priority: P3.**

---

## 8. Reliability assessment

### 8.1 Monitoring

| Capability | Status | Evidence |
|---|---|---|
| Liveness endpoint | **IMPLEMENTED** | `GET /api/health` — public minimal (`{status, build, at}`), 503 when KV is down; detailed breakdown for an admin session or `HEALTH_CHECK_SECRET`. |
| Dependency checks | **IMPLEMENTED** | `runHealthChecks` verifies KV (write-then-read round trip, **critical**), Blob, completion-upload readiness, AI gateway, cron secret, Stripe, **Stripe webhook secret separately**, Resend, Twilio (using the same predicate `sms.ts` sends by), tenancy profile validity. |
| Secret-value leakage | **prevented** | presence booleans only; `projectHealth` enforces the minimal/detailed split. |
| Structured logging | **IMPLEMENTED** | `platform/observability/logger.ts` + `redact.ts`. |
| Per-stage tracing | **PLANNED (OFF)** | `observability/pipeline-trace.ts`. |
| Alerting | **PARTIAL** | `alerts.ts` — severity levels, dedup windows scaled by severity, safe-field-only payloads, provider chain Slack → owner email → **structured console**. |
| Metrics / time series | **MISSING** | No Prometheus/OTel/Datadog. Counters exist only inside the app's own read surfaces. |
| External synthetic monitoring | **MISSING (unverifiable from the repo)** | No uptime-monitor config committed. |
| Error tracking (Sentry-class) | **MISSING** | Failures are `console.error` + `alert()`. |

> **Finding OB-1 — alert delivery is unproven and silently degrades to `console.log`.**
> **Evidence:** `app/lib/alerts.ts` — "a provider abstraction that uses the safest ALREADY-configured path: Slack webhook → owner email → structured console (always, the fallback)… If no provider env is set, the abstraction still runs and logs a structured line."
> **Impact (system):** every CRITICAL in the system — `health_critical` (KV down), `cron_job_failed`, `due_index_read_failed` ("this tick did NOTHING"), `stripe_webhook_tenant_unresolved` — may be landing exclusively in Vercel logs that nobody is watching. The alerting *code* is good; the alerting *pipeline* may not exist.
> **Recommendation:** verify `alertProviderStatus()` in Production, configure the Slack webhook, and fire a synthetic CRITICAL to confirm delivery. Until that is done, treat every reliability control below as **undetected**.
> **Priority: P0** — not because the code is wrong, but because unverified alerting invalidates the detection column of every row in §8.3.

> **Finding OB-2 — no external uptime monitoring is evidenced.** `/api/health` is built precisely for an uptime monitor and correctly returns 503 on KV loss, but nothing in the repository shows one is pointed at it.
> **Recommendation:** point an external monitor at `https://www.jkissllc.com/api/health` with alerting on non-200 and on `build` not changing after a deploy (which also catches the "green merge, no deploy" failure mode below).
> **Priority: P1.**

### 8.2 Deployment

| Aspect | Status | Notes |
|---|---|---|
| CI | **IMPLEMENTED** | `.github/workflows/ai-regression.yml` — `npm ci` → `tsc --noEmit` → full `npm test` → `next build`, on every push to `main` and every PR. Verified locally: 3,688 tests pass, 0 lint errors (3 baseline warnings), typecheck clean. |
| CI as a hard gate | **NOT ENFORCED** | The workflow's own header: *"Without one of those, this is a visible signal but does not by itself block Vercel's auto-deploy."* Branch protection / "only deploy when checks pass" is not evidenced. |
| Pre-deploy script | IMPLEMENTED | `npm run predeploy` = `tsc --noEmit` + AI golden-fixture regression. |
| Environments | Production / Preview / local, with a separate Preview KV store. | Preview deployment protection fronts Preview hosts; diagnostics routes additionally 404 in Production regardless of flags. |
| Migrations | **manual scripts** | `scripts/tenant-migration`, `open-punch-backfill`, `token-backfill`, `ai-due-backfill`. No migration framework, no applied-migration ledger. |
| Rollback | **PARTIAL** | Documented in `docs/operations/06-rollback-checklist.md`; the mechanism is `vercel redeploy <preview-url> --target production`. The Operion Release Center has a built rollback executor — flag OFF. |
| Known failure mode | **DOCUMENTED** | `AGENTS.md`: *"A green merge to `main` can silently produce no Production deployment. It has happened more than once, with CI and Vercel PR checks green and nothing queued."* Verification is a manual `curl /api/health` and a **tree-hash** comparison (a redeploy keeps the branch SHA, so the SHA field alone misleads). |

> **Finding DP-1 — the deploy pipeline has a known silent-failure mode and the only detector is a human running curl.**
> **Impact (business):** a shipped fix can be believed live while Production still runs the old build. This has occurred more than once.
> **Recommendation:** (a) enable branch protection requiring the `verify` check; (b) add a post-merge GitHub Action that polls `https://www.jkissllc.com/api/health` for the expected build id and fails loudly after N minutes. Both are small and directly address a recurring incident.
> **Priority: P1.**

### 8.3 Production Failure Matrix

| Scenario | Impact | Detection | Recovery | Missing protection |
|---|---|---|---|---|
| **Upstash KV unavailable** | **Total outage.** Every entity read/write fails. `/api/health` → 503. Public forms still render; every submission fails. Rate limits fail **open**. `/api/booking/{token}` returns a specific 503 for `UPSTASH_NOT_CONFIGURED`. | `/api/health` 503 + `alert('health_critical', CRITICAL)` | Wait out the provider; no failover | **No read replica, no cache, no degraded read-only mode.** Single point of total failure. **P1.** |
| **KV request-limit exhaustion** | Same as above, self-inflicted. Precedent: the July-31 `ERR max requests limit exceeded` outage traced to O(n) scans on clock-in. | Errors surface as generic KV failures; `cron-request-budget.test.ts` bounds cron usage | Reduce scan callers | **No per-request Redis budget in the request path** (only in crons). **P1.** |
| **AI provider unavailable** | Instant quotes degrade to manual review. Durable jobs retry with backoff, then go terminal. Circuit breaker opens. Booking/payment unaffected. | `alert('ai_analysis_failed', ERROR)` on retry exhaustion; health reports `ai_provider` degraded | Automatic — owner hand-prices | Good. Nothing material missing. |
| **AI cost runaway** | Unbounded spend. | None by default (cap unset) | Manual | **Cap unset — AI-1. P1.** |
| **Stripe unavailable** | Checkout creation fails → `/api/book` still returns a booking, without a payment link. Webhook backstop idle. | `console.error('[book] stripe')` — **no alert** | Customer pays later via `/booking/{token}/pay` | **No alert on checkout-creation failure. P2.** |
| **Stripe webhook secret unset** | Webhook 503s; confirmation rests solely on the success-URL return path. | `/api/health` reports `payments_webhook` **degraded** — deliberately separated from `payments` so a working checkout cannot mask a dead backstop | Configure the secret | Excellent — this is a well-designed check. |
| **Customer abandons Stripe return** | Payment captured, possibly never recorded (webhook returns 200 on handler error). | None | None automatic | **CR-5 — no reconciliation cron. P1.** |
| **Resend (email) unavailable** | Ops and customer emails silently fail. Every `email*` call is `.catch(() => {})`. Alert fallback chain loses its email leg. | Health reports `email` degraded | Manual resend | **Email failures are swallowed with no counter and no alert. P2.** |
| **Twilio unavailable** | SMS fails. Reminder cron already suppresses automated SMS. | Health reports `sms` degraded; `sms-status` webhook records delivery failures | Manual | Acceptable. |
| **Blob unavailable** | Photo upload fails (customer-visible 500 path); **Zelle booking correctly refuses** rather than persisting without proof; crew completion upload fails closed with `blob_store_not_configured`. | Health reports `storage` and `completion_uploads` separately | Retry | Good. |
| **Cron worker crash mid-job** | Booking left in `processing`; the durable lease expires; the next tick re-picks it up. | `alert('cron_job_failed', CRITICAL)` | **Automatic** — this is the core design property | Good. |
| **Cron doesn't run at all** | AI jobs, reminders, accrual, review requests all stall silently. | ❌ **none** — there is no "cron has not reported in N minutes" check | Manual noticing | **No cron heartbeat/deadman. P1.** |
| **Due-index read fails (when enabled)** | The tick processes **nothing** — there is deliberately no scan fallback. | `alert('due_index_read_failed', CRITICAL)` — explicitly added because "that must page, not hide in a log line" | Rebuild the index | Good, *conditional on OB-1*. |
| **Duplicate booking submission** | None. | — | Idempotency claim | Excellent. |
| **Concurrent booking of the last slot** | **Overbooked date; a crew cannot serve both.** | ❌ none | Manual reschedule + goodwill | **CR-1. P0.** |
| **Record count exceeds a scan cap** | Availability oversells; payroll underpays; reports understate; a crew member's job list goes blank. | ❌ **none — silent** | Manual discovery | **CR-2/CR-3/CR-9. P0 (latent).** |
| **Alert provider unconfigured** | Every CRITICAL above lands in `console.log` only. | ❌ by definition | — | **OB-1. P0.** |
| **Merge produces no deploy** | Fix believed live, is not. | Manual `curl /api/health` | `vercel redeploy` | **DP-1. P1.** |
| **`ADMIN_SESSION_SECRET` rotated** | Every session invalidated instantly (signature mismatch). | User reports | Re-login | Acceptable — arguably the revocation mechanism AS-1 lacks, at maximum blast radius. |
| **Tenancy flag enabled prematurely** | Customer booking APIs 500 (AZ-2); users without memberships get 403 (§4.6). | Immediate and total | Flag off | **The flip has two known blockers and no rehearsal.** P1. |

---

## 9. Testing maturity

### 9.1 Inventory

**285 test files · 3,688 tests · 0 failures · 15.9s** (`npx tsx --test scripts/*.test.ts`, verified at review time). Every test file runs in its own process with **no timeout** — a silent run means a hung promise, not a slow suite.

| Category | Count (approx.) | Representative files |
|---|---|---|
| Pure unit / domain logic | ~120 | `rbac`, `finance`, `estimation-engine`, `volume-engine`, `crew-comp`, `dates`, `validators` |
| Integration (multi-module, KV emulator) | ~70 | `booking-e2e`, `claims-integration`, `booking-pay-integration`, `schedule-auto-cancel-integration` |
| **Race / concurrency** | **~12** | `book-idempotency-{race,recovery,ownership}`, `booking-concurrency`, `punch-concurrency`, `pay-statement-concurrency`, `concurrency-inv-app-aprv`, `kv-lock`, `wave-c-idempotency` |
| **Authorization** | **~14** | `authorization-coverage` (CI gate), `rbac`, `manager-authz`, `crew-portal-authorization`, `booking-completion-authorization`, `audit-permissions`, `tenant-switch-role-escalation`, `hardening-portal-abuse` |
| **Tenant isolation** | **~18** | `tenant-isolation`, `tenant-isolation-wave5`, `bypass-detection`, `tenant-keys`, `blob-tenant-paths`, `public-token-tenancy`, `stripe-tenant`, `financial-token-tenancy`, `health-key-tenancy`, `ai-tenant-scope`, `dark-launch` |
| Architectural invariants | ~10 | `bypass-detection`, `dependency-closure`, `name-derived-keys`, `symbol-verification`, `platform-flags`, `nav-config` |
| AI / estimation | ~45 | `ai-service`, `ai-regression` (golden fixtures), `ai-timeout`, `ai-recovery`, `photo-*`, `moving-*`, `shadow-*`, `vision-benchmark` |
| Platform / release | ~40 | `operion-*` (25+), `release-*`, `promotion`, `rollback-truthfulness`, `transfer-evidence` |
| Accessibility / mobile | ~8 | `wizard-a11y`, `mobile-audit-*` (5) |
| Security hardening | ~5 | `security-hardening`, `hardening-nplus1`, `hardening-portal-abuse`, `doc-crypto`, `webhook-cron-auth` |
| Budget / cost | ~3 | `cron-request-budget`, `shadow-budget` |

### 9.2 What is unusually strong

1. **Mutation-checked race tests.** `AGENTS.md` mandates: *"Break the mechanism on purpose and confirm the test fails. Two real coverage gaps in this repo were found exactly that way."* This is a discipline most enterprise teams do not practise.
2. **CI-enforced architectural invariants.** `authorization-coverage` and `bypass-detection` make "someone forgot a guard" and "someone hand-built a tenant prefix" into build failures rather than review findings.
3. **Flag-off equivalence tests.** `punch-flag-off-equivalence`, `booking-assignment-flag-off`, `operion-flags-wiring` assert that a flag being OFF is byte-identical to before the feature existed. This is what makes 46 dormant flags safe to carry.
4. **Truthfulness tests.** `rollback-truthfulness`, `mobile-audit-truthfulness`, `baseline-live-verification` test that a *report* is honest, not just that code runs. Rare and valuable.
5. **The route-level-tests-hide-helper-branches rule** in `AGENTS.md`, with the corresponding practice of driving helpers directly.

### 9.3 False-confidence risks

> **TC-1 — the suite runs entirely against a KV emulator.** `scripts/kv-emulator-lua.test.ts` exists, so the emulator implements the Lua paths. But nothing tests against real Upstash: REST latency, `ERR max requests limit exceeded`, partial failures, and REST-specific type coercions are all unrepresented. The July-31 outage was exactly this class. **P2.**

> **TC-2 — passing tests over dormant code is not the same signal as passing tests over live code.** Roughly a third of the platform library and its ~65 associated test files exercise flag-OFF subsystems. The green suite is therefore less informative about production behavior than the raw number suggests. **P3 (awareness).**

> **TC-3 — `authorization-coverage` proves a guard is *called*, not that it is *correct*.** The regex asserts a guard identifier appears in the file. A route calling `requirePermission(req, 'crew:view')` where it should require `pay:approve` passes the gate. **P2** — extend the gate to assert the permission string against a reviewed route→permission manifest.

### 9.4 Coverage Gap Roadmap

| Gap | Why it matters | Suggested test | Priority |
|---|---|---|---|
| **Daily capacity race (CR-1)** | The one open race in a customer money path. | Mutation-checked: N concurrent `/api/book` for the last slot on one date → assert exactly one succeeds; then break the fix and assert the test fails. | **P0** |
| **Scan truncation (CR-2/3/9)** | Silent wrongness in availability, payroll, claims accrual. | Seed >cap records; assert `getAvailability` / `computePay` either see everything or **refuse**. Never silently truncate. | **P0** |
| **End-to-end payment reconciliation (CR-5)** | Captured-but-unrecorded payment. | Simulate: webhook handler throws → 200 returned → customer never returns → assert a reconciliation path recovers it. Currently there is no such path to test. | **P1** |
| **Tenancy flip rehearsal** | Two known blockers, no rehearsal. | Integration suite with `TENANCY_ENABLED=true` covering: anonymous customer `booking/[token]` reads, login with memberships, cron fan-out, webhook tenant resolution. Must currently **fail** on AZ-2. | **P1** |
| **Session revocation (AS-1)** | Suspension does not cut access. | Assert a suspended user's live session is rejected within one slide interval. Currently no mechanism to test. | **P1** |
| **Cron liveness** | A cron that stops running is undetected. | Assert a heartbeat key is written per tick and that a staleness check alerts. Mechanism does not exist. | **P1** |
| **Alert delivery (OB-1)** | Detection column of the whole failure matrix. | `alerts-delivery.test.ts` exists — extend it to assert `alertProviderStatus()` reports a **configured** provider in Production-like env, and fail if the only path is console. | **P1** |
| **Portal IDOR as an invariant (AZ-1)** | 19 handlers honour a convention by hand. | Static gate over `app/api/portal/**`: every handler references `who.staffId`; none reads a staff id from `body`/`searchParams`. | **P2** |
| **Real-Upstash smoke (TC-1)** | Emulator ≠ REST. | A Preview-only smoke suite against the real Preview store covering the Lua CAS scripts and lock heartbeats. | **P2** |
| **Permission-string correctness (TC-3)** | A guard can be present and wrong. | Route→permission manifest asserted in CI. | **P2** |
| **CSP regression** | If a CSP is added, inline styles will break silently. | Snapshot the header and assert admin pages render. | **P3** |

---

## 10. Risk register

Consolidated and ranked. Every row was verified by reading the implementation, not inferred from a filename.

### P0 — production correctness / security

| ID | Finding | Evidence | Impact | Recommendation |
|---|---|---|---|---|
| **CR-1** | Daily capacity is check-then-act with no reservation; concurrent bookings can oversell the last slot on a date. | `app/api/book/route.ts` (`isDateBookable` → build → `commitIdempotently`); `app/lib/availability.ts:113–118` | **Customer:** two jobs promised on a date one crew can serve. **Business:** goodwill cost, reschedule, possible refund. | Lock on `bk:cap:{date}` across check→commit, or an atomic per-date units counter. Mutation-checked race test. |
| **CR-2** | `getAvailability` computes occupancy from `listBookings(1000)` ordered by `updatedAt`; older future-dated bookings fall out of the window and their slots are resold. | `app/lib/availability.ts:80–108` | **Customer/business:** silent overselling that grows with record count. | Per-date occupancy index maintained in `saveBooking`. |
| **CR-3** | `computePay` reads `listRoutes(2000)` + `listBookings(2000)`; beyond either cap, hours are silently omitted from an **issued** pay statement. | `app/lib/route-pay.ts:135–139` | **Business/legal:** underpayment of contractors, with a statement that looks authoritative. | Use the existing coverage-proving triple (`countBookingIndex` / `scanBookingIndexPage` / `readBookingsByTokens`); refuse generation on incomplete coverage. |
| **OB-1** | Alert delivery falls back to `console.log` and configuration is unverified; every CRITICAL may be undetected. | `app/lib/alerts.ts` provider chain | **System:** the detection column of the entire failure matrix is unproven. | Verify `alertProviderStatus()` in Production; configure Slack; fire a synthetic CRITICAL. |

### P1 — reliability risk

| ID | Finding | Evidence | Impact | Recommendation |
|---|---|---|---|---|
| **AZ-2** | All 11 `/api/booking/[token]/*` routes use session-based `withTenantRoute`; with tenancy ON they throw for session-less customers before the inner resolver runs. `stripe-return` has no inner resolver at all. | `platform/tenancy/request-context.ts:24–27` vs `with-public-token-route.ts` | **Blocks the tenancy rollout entirely.** | Migrate to `withPublicTokenRoute({ expect: 'booking' })`. |
| **AS-1** | Sessions are stateless and cannot be revoked; suspension does not terminate a live session (up to 2h). | `app/api/admin/_lib/session.ts` | **Security:** delayed offboarding of crew and compromised admins. | Revocation epoch checked in `slideSessionToken`. |
| **AS-2** | The shared `ADMIN_PASSWORD` owner session holds platform-owner authority (publish, rollback, seed, sandbox repair). | `isPlatformOwner()` | **Security:** no attribution, no MFA on the highest privilege. | Named `PLATFORM_OWNER_SUBS` only; retire the `sub === 'owner'` shortcut. |
| **AI-1** | `AI_DAILY_COST_CAP_USD` is unset (no cap) while a `*/15` cron makes real vision calls. | `ai/budget.ts:16–19`; `vercel.json` | **Business:** unbounded AI spend. | Set the cap; alert at 50%/80%. |
| **CR-4** | Global single-open-punch enforcement is OFF; the public route-assignee path can open a second concurrent punch. | `SINGLE_OPEN_PUNCH_ENABLED: false`; `timeclock/punch-policy.ts` | **Business:** double-counted payroll hours. | Run the `punchidx` backfill, enable the index, then enforcement. |
| **CR-5** | Stripe webhook returns 200 on handler error; if the customer never returns, a captured payment is never recorded. | `app/api/webhooks/stripe/route.ts` | **Business:** unrecorded revenue, unconfirmed booking. | Reconciliation cron over recent Stripe sessions, or 5xx on transient failures. |
| **CR-9** | `accrueAllClaims` iterates `listClaims(1000)` — same truncation class as CR-2/CR-3, on money. | `app/lib/claim-accrual.ts` via `computePay` inputs | **Business:** missed claim deductions. | Coverage-proving pagination. |
| **DA-3** | Punches live in two aggregates; three consumers read them with three different caps (500/1000/2000). | `crew-timeclock.ts:160`, `admin/timesheets:32`, `route-pay.ts:137` | **Business:** timesheets, portal, and payroll can disagree about the same week. | Promote punches to first-class entities with per-staff-period indexes. |
| **REL-1** | No cron heartbeat: a cron that stops firing is undetected. | no deadman check found | **System:** AI jobs, reminders, accrual, review requests stall silently. | Write `cron:last:{job}` each tick; alert on staleness from `/api/health` or an external monitor. |
| **REL-2** | Upstash is a single point of total failure with no cache, replica, or degraded read-only mode. | `app/lib/redis.ts` | **System:** total outage on provider loss. | At minimum, a documented, rehearsed KV-outage runbook and a static maintenance page. |
| **DP-1** | Known "green merge, no Production deploy" failure mode; the only detector is a human running curl. | `AGENTS.md` "Deploying" | **Business:** fixes believed live that are not. | Branch protection + a post-merge build-id verification action. |
| **OB-2** | No external uptime monitoring evidenced against the purpose-built `/api/health`. | — | **System:** outages detected by customers. | Point an external monitor at it; alert on non-200 and on a stale `build`. |
| **CF-1** | `/api/quote` swallows persistence failure and still returns an estimate — a quote with no record. | `app/api/quote/route.ts` catch block | **Business:** lost lead, quoted price with no trail. | Alert + fallback lead write. |

### P2 — important improvement

| ID | Finding | Recommendation |
|---|---|---|
| **AZ-1** | Crew `staffId` scoping is a per-handler convention across 19 routes. | Extend the CI authorization gate to `app/api/portal/**`. |
| **AZ-3** | Admin/portal pages are gated client-side; the bundle is served to anonymous callers. | Redirect unauthenticated page requests in `proxy.ts`. |
| **AZ-4** | Legacy admin login is IP-only rate-limited and fails open. | Global failure counter + WAF layer. |
| **AS-3** | No MFA on any role. | TOTP for admin + platform owner. |
| **SEC-1** | No Content-Security-Policy. | Nonce-based CSP scoped to `/admin` and `/portal`. |
| **AI-2** | Pipeline observability flag OFF; no per-stage latency attribution. | Enable Preview → Production. |
| **DA-1** | Customer record is a projection that can disagree with bookings. | Label it as derived, or invert the authority. |
| **DA-2** | Businesses carry two live identity schemes. | Complete the stable-id migration. |
| **REL-3** | Email/SMS failures are swallowed with no counter or alert. | Count and alert on failure rate. |
| **REL-4** | Stripe checkout-creation failure logs but does not alert. | Add `alert('stripe_checkout_failed', ERROR)`. |
| **TC-1** | No tests against real Upstash REST. | Preview-only smoke suite. |
| **TC-3** | Authorization gate proves presence, not correctness, of the permission. | Route→permission manifest in CI. |
| **CR-6** | AI worker proceeds unlocked on lock-store error. | Alert when `run_unlocked` is taken. |
| **CR-7** | Rate limiting fails open on Redis error. | WAF as a KV-independent second layer. |
| **CR-A** | No crew invitation/onboarding flow; admins choose initial passwords. | Single-use onboarding token + forced rotation. |
| **MT-1** | 46 dormant flags and ~30–40% dormant platform surface. | Set an expiry review per flag; delete or ship. |

### P3 — optimization

| ID | Finding | Recommendation |
|---|---|---|
| **CR-8** | A losing racer burns a booking number. | Note it; do not assume gapless numbering. |
| **CR-10** | `commitIdempotently`'s lease precondition is documented, not type-enforced. | Require the `KvLock` handle as an argument. |
| **AI-3** | Moving lane built and off. | Product decision; keep the flag as the kill switch. |
| **AI-4** | Interactive analyze is synchronous and single-shot. | Enable `OPERION_PROGRESS_UX` for a truthful wait. |
| **PERF-1** | Admin shell remounts on every navigation (no `operations/layout.tsx`). | Introduce a shared layout. |
| **PERF-2** | Every list is a ZSET page + one `GET` per member. | Batch where Upstash REST allows; consider pipelining. |
| **SEC-2** | No CSRF tokens; relies on `sameSite=lax` + JSON-only bodies. | Add double-submit tokens on state-changing admin routes. |

---

## 11. Recommended roadmap

Sequenced so that each wave removes a class of risk, and so nothing later depends on something earlier that has not shipped.

### Wave 0 — Make failures visible (days, no code changes to business logic)

*Nothing below can be trusted until detection works. This is the cheapest, highest-leverage wave in the review.*

1. **Verify and configure alert delivery** (OB-1, P0). Check `alertProviderStatus()` in Production, wire the Slack webhook, fire a synthetic CRITICAL, confirm receipt.
2. **Point an external monitor at `/api/health`** (OB-2, P1) — alert on non-200 and on a `build` id that fails to change after a deploy (this also detects DP-1).
3. **Set `AI_DAILY_COST_CAP_USD` in Production** (AI-1, P1) and add 50%/80% alerts.
4. **Enable branch protection** requiring the CI `verify` check (DP-1, P1).

### Wave 1 — Close the open race and the silent-truncation class (1–2 sprints)

*These are the two P0 engineering items. They are independent and can run in parallel.*

5. **Capacity reservation** (CR-1, P0). Add a per-date lock or atomic units counter around check→commit. Ship with a mutation-checked race test.
6. **Per-date booking occupancy index** (CR-2, P0) maintained in `saveBooking`; rewrite `getAvailability` to read it.
7. **Coverage-proving payroll and claims selection** (CR-3, CR-9, P0). Migrate `computePay` and `accrueAllClaims` to `countBookingIndex` + `scanBookingIndexPage` + `readBookingsByTokens`, and **refuse** to produce a money artifact when coverage is incomplete. The primitives already exist and already report `missing` — they simply are not used on the money path.
8. **Audit every remaining capped scan** (~30 call sites, listed in §4.4/§8.3). For each, classify: *presentational* (a capped list is fine — say so in a comment) or *correctness-relevant* (must prove coverage). Add a CI gate that flags new `listBookings(` / `listRoutes(` calls outside the presentational allowlist.

### Wave 2 — Reliability and money integrity (1–2 sprints)

9. **Cron heartbeat + deadman** (REL-1, P1).
10. **Stripe reconciliation cron** (CR-5, P1) — daily sweep of recent sessions, applying any unrecorded `paid` session through the existing idempotent recorder.
11. **Quote-persist failure alert + fallback lead write** (CF-1, P1).
12. **Punch engine activation** (CR-4, P1) — read the Phase A overlap report, run the `punchidx` backfill, enable `OPEN_PUNCH_INDEX_ENABLED`, verify parity, then `SINGLE_OPEN_PUNCH_ENABLED`. This sequence is already documented in `docs/operations/PUNCH-ENGINE-ACTIVATION-HANDOFF.md`; it needs executing, not designing.
13. **Email/SMS failure counters and alerts** (REL-3, P2); **Stripe checkout-failure alert** (REL-4, P2).
14. **Write and rehearse a KV-outage runbook** (REL-2, P1).

### Wave 3 — Security hardening (1 sprint)

15. **Session revocation epoch** (AS-1, P1).
16. **Retire the shared-password platform owner** (AS-2, P1) in favour of named `PLATFORM_OWNER_SUBS`.
17. **Unauthenticated page redirect in `proxy.ts`** (AZ-3, P2).
18. **Portal authorization CI gate** (AZ-1, P2) and **route→permission manifest gate** (TC-3, P2).
19. **Global lockout on the shared-password endpoint + WAF rate rules** (AZ-4, CR-7, P2).
20. **MFA for admin and platform owner** (AS-3, P2).
21. **Nonce-based CSP on `/admin` and `/portal`** (SEC-1, P2).

### Wave 4 — Unblock tenancy (1–2 sprints, only after Waves 0–2)

22. **Migrate the 11 booking-token API routes to `withPublicTokenRoute`** (AZ-2, P1) — including `stripe-return`.
23. **Apply the Wave 6 membership backfill** in Preview, then Production (§4.6).
24. **Run the `punchidx` and token backfills** to completion with recorded evidence.
25. **Tenancy dress rehearsal in Preview** with `TENANCY_DARK_LAUNCH`, then `TENANCY_DUAL_WRITE`, comparing mismatches — the tooling exists and has never been exercised.
26. **Tenancy integration suite** that must pass with `TENANCY_ENABLED=true` before the flag is considered flippable.

### Wave 5 — Scale and simplify (ongoing)

27. **Promote punches to first-class entities** (DA-3, P1) with per-staff-per-period indexes; make timesheets, portal, and payroll read one source.
28. **Per-business route index and per-status booking index** (§4.4).
29. **Complete the business stable-id migration** (DA-2, P2) and delete the name-derived path.
30. **Flag hygiene** (MT-1, P2): assign every one of the 46 dormant flags an owner and a decision date — ship it or delete it. A flag with no expiry is permanent complexity.
31. **Shared `operations/layout.tsx`** (PERF-1, P3).

### What NOT to do

- **Do not "simplify" `app/lib/booking-idempotency.ts`.** The three rejected patches in `AGENTS.md` (an `assertHeld()` before the write; a TTL adjustment to fix a race; fixing one intake path) are each a regression to a bug that was already paid for. The file's comments are the design record.
- **Do not raise a scan cap as the fix for a truncation finding.** A bigger cap moves the cliff; it does not remove it, and it makes the eventual failure larger and later.
- **Do not enable `TENANCY_ENABLED` before Wave 4 completes.** Two blockers are known and neither has a workaround.
- **Do not add a third grade of lock.** `app/lib/kv-lock.ts` is the canonical primitive; the whole point of LOCK-1 was to eliminate the second grade.

---

## 12. Appendix — verification method and limits

### What was verified

- Every claim in this document about a code path was verified by **reading that path**, not by inferring from a filename, a comment, or a document. Where a comment asserts a property, the implementation was checked against it.
- **Static sweep of all 225 route files** for guard identifiers, tenancy wrappers, and webhook/cron authentication, producing the matrix in §5.3.
- **Full test suite executed**: `npm test` → 3,688 pass / 0 fail / 15.9s.
- **Typecheck executed**: `npx tsc --noEmit` → clean.
- **Lint executed**: `npx eslint .` → 0 errors, 3 warnings (the documented baseline).
- Flag defaults read directly from `FLAG_DEFAULTS`: 48 flags, 46 OFF, 2 ON (`CAPABILITY_REGISTRY_ENABLED`, `VISION_SHADOW_SELECTED_ONLY`).

### What was NOT verified, and why it matters

| Not verified | Why | Consequence for this document |
|---|---|---|
| **Production environment variables** | Reading them requires Production access and was outside the analysis-only scope. | Every statement about a flag or secret is about the **code default**, not the deployed value. Production may differ — in particular, the operator's own records indicate `BOOKING_ASSIGNMENT_ENABLED` is live in Production despite defaulting OFF. **Any flag-state claim here must be confirmed against the deployment before acting on it.** |
| **Production data volume** | No production reads were performed. | The scan-truncation findings (CR-2, CR-3, CR-9) are stated as *latent*. Whether they are already active depends on the current record counts. **Determining the current `bk:index` and `rt:index` cardinality is the single highest-value next measurement** — it converts three P0-latent findings into either "already broken" or "runway remaining". |
| **Whether alerts are actually delivered** | Requires Production configuration inspection. | OB-1 is stated as unproven rather than broken. |
| **Live behaviour under load** | No load test was run. | Concurrency findings are derived from code reading and from the existing race tests, not from observed contention. |
| **Runtime behaviour of the ~30–40% dormant platform surface** | It does not run. | Its tests pass; that is a weaker signal than for live code. |

### Reproducing this review

```bash
npm test                                    # 3,688 tests, ~16s, expect 0 failures
npx tsc --noEmit                            # expect clean
npx eslint .                                # expect 0 errors, 3 baseline warnings
curl -s https://www.jkissllc.com/api/health # build id + status (see AGENTS.md "Deploying")
```

Route authorization sweep (the source of §5.3):

```bash
for f in $(find app/api -name route.ts | sort); do
  printf "%-58s " "${f#app/api/}"
  grep -ohE 'require(TenantSession|StaffSession|Admin|Permission|Principal|PlatformOwner)\(|requireCrew\(|getPrincipal\(|withPublicTokenRoute|withPublicHostRoute|withTenantRoute|CRON_SECRET|constructEvent|verifyTwilio' "$f" | sort -u | tr '\n' ','
  echo
done
```

---

*End of review. No application code, flags, deployments, or PRs were changed in the course of producing this document.*
