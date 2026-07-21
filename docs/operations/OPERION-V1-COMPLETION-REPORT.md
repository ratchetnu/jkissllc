# OPERION V1 COMPLETION REPORT

**Date:** 2026-07-21
**Scope:** J KISS LLC + Supercharged as internal operating systems. Enterprise SaaS scope explicitly deferred.
**Baseline:** `main` @ `a5f647d` · `tsc --noEmit` clean · full suite **1635/1635 pass**
**Method:** static audit of `app/`, `app/lib/`, `app/api/`, `docs/`, feature flags, branches, and the sibling `supercharged` repo.

---

## 0. The central finding

Operion has **two operational lanes** that were built independently and **never joined**.

### Lane A — Routes (contract / recurring delivery)
Complete, end-to-end, production-grade. The full spine exists:

`Business contract rate → Route → staff-linked crew w/ per-person pay snapshot → equipment link → per-person SMS confirm link → clock in/out → completion note + photos → route invoice → pay statement → claim w/ payroll deduction → crew portal`

### Lane B — Bookings (Book Now: moving, junk removal, cleanouts — the customer revenue line)
Complete, end-to-end, production-grade **on the customer side only**:

`Quote intake → AI photo estimate → deterministic pricing → quote decision → Stripe/Zelle payment → confirmation link → time verification → reminders → invoice → review request`

**The operations side of Lane B is hollow.** A `Booking`'s entire operational assignment model is two free-text strings:

```ts
// app/lib/bookings.ts:337-338
assignedTo?: string          // lead crew/rep assigned to the job (shown to customer)
assignedHelper?: string      // helper / second rep (shown to customer)
```

These are **names typed into a box**. They are not linked to a staff record. Every downstream operational system therefore cannot see the customer revenue line. Verified consequences:

| Consequence | Evidence |
|---|---|
| Vehicle/equipment conflict detection is structurally blind to every customer job | `app/lib/schedule/unified.ts:224-225` hard-codes `equipmentId: undefined, equipment: []` for bookings |
| A crew member assigned to a moving job sees **nothing** in the crew portal | `app/api/portal/routes/route.ts:17` reads `listRoutes()` only; matches on `a.staffId` |
| No clock in/out on customer jobs | `crew-timeclock.ts` is keyed to route assignee tokens |
| No completion photos on customer jobs | `completionPhotos` exists on `RouteRecord` (`routes.ts:155`) — absent from `Booking` |
| Booking work is invisible to crew pay | `StatementLine { routeNumber, routeDate, businessName }` (`pay-statements.ts:9-14`) |
| A damage claim cannot be filed against a moving job | `claims.ts` snapshots a `RouteRecord` (`claims.ts:22`) |
| No single P&L | `finance.ts` = route revenue/payout/profit; `api/admin/reports` = booking revenue with **no cost side** |
| **No expense tracking exists anywhere in the system** | zero expense modules in `app/lib`; only capability-registry string mentions |

**This single disconnect is the reason J KISS cannot run entirely inside Operion today.** The moving/junk side of the business — the AI-quoted, customer-paying side — is a beautiful sales funnel that hands off to nothing.

---

## 1. Completed

Shipped, wired, and running in production unless noted.

### Customer acquisition & quoting
- Public marketing + funnel routes (quote, book-now, track, careers, reviews, COI, legal) — 87 pages
- Multi-step quote intake with photo upload, HEIC conversion, BotID protection
- **AI photo estimation pipeline**: vision analysis → inventory extraction → volume/weight engines → load tier → complexity → confidence → deterministic pricing → quote decision (`app/lib/estimation/*`, `app/lib/pricing/*`)
- Durable job queue for AI work with leases, idempotency keys, retry, provider-outage breaker (`book-now-queue.ts`, `book-now-ai.ts`, `ai-recovery.ts`)
- Clarification loop (request better photos / item counts) before quoting
- Promo codes, availability calendar, service-type taxonomy (8 types, 2 families)

### Customer transaction
- 17-state booking lifecycle with guarded transitions and full audit trail
- Payments: Stripe (deposit/balance/full/partial), Zelle w/ encrypted proof upload + owner verification, cash/Apple Cash manual recording
- Invoices with photos, net/balance computation, public invoice page + Stripe return
- Confirmation links, time verification, reschedule, cancel w/ tiered refund policy
- Reminder engine (segments, templates, dedupe stamps, cron-driven)
- SMS (Twilio, status webhooks, keyword handling) + email (Resend, webhooks)
- Review request flow

### Operations — Routes lane (complete)
- Business/contract registry with per-business route rates
- Routes + recurring route templates, draft→assigned→confirmed→completed lifecycle
- Staff-linked crew assignment with per-person pay snapshot and independent confirmation
- Equipment roster with per-route asset linkage
- Per-person confirmation links, verbal-confirm capture, no-show tracking
- Clock in/out, completion note + completion photos
- Route invoices (to the contracting business), route re-pricing, route stats
- Contractor pay statements — immutable issued snapshots w/ deductions
- Claims: aggregate root, 9-state lifecycle, append-only money ledger, crew responsibility, payroll deduction accrual, claim documents, ClaimGuard Assist

### Operations — cross-cutting
- **Unified schedule** (`app/lib/schedule/unified.ts`): pure projection of Bookings + Routes into one generic `ScheduleItem`, with deterministic conflict detection (crew overlap, vehicle overlap, equipment overlap, travel time, missing crew, missing vehicle, accepted-not-scheduled, duplicate job)
- RBAC: centralized role→permission matrix, server-enforced via session guards (`rbac.ts`, `api/admin/_lib/session.ts`)
- Crew portal: login, my routes, availability, time off, documents, uniform review, pay statements, pay corrections, messages, tasks
- Careers/ATS: application intake, document upload, scoring, config
- Communications center: dispatch, history, preview, health, analytics
- Disposal tracking, shipments, client portals, messages/inbox

### AI platform (mature — most of it flag-off in prod)
- Centralized AI service through Vercel AI Gateway with prompt registry, versioning, A/B testing
- AI Command Center: usage, cost, performance, quality, alerts, models, controls, settings
- Telemetry + cost attribution over the `runAiTask` chokepoint
- Per-stage pipeline observability (queue→preprocess→provider→ai→pricing→database→notification)
- Shadow evaluation subsystem (independent queue/worker/cron) + shadow analytics + shadow alerting
- Learning loop: outcome capture from completed jobs, multi-dimensional calibration
- Image optimization for vision (model-optimized derivatives, originals preserved)
- Progress UX state machine for `/quote`

### Platform / release engineering
- Operion Release Center: publish review, approval gate (typed phrase), publish execution, rollback, release history — all owner-gated, flag-off in prod
- Product Sync Platform: content-based sync between J KISS and Supercharged (unrelated git histories) with ledger, gates, drift detection, dashboard
- Tenancy foundation shipped flag-off (key-scoping chokepoint in `redis.ts`)
- 16 operations runbooks in `docs/operations/`

---

## 2. Partially Complete

| # | Feature | State | What's missing |
|---|---|---|---|
| P1 | **Crew assignment on bookings** | free-text names only | staff-record linkage, multi-person crew, role, pay |
| P2 | **Vehicle/equipment on bookings** | none | equipment roster link; unified schedule hard-codes empty |
| P3 | **Crew portal job feed** | routes only | booking jobs, instructions, addresses, times |
| P4 | **Job execution capture** | routes only | clock in/out, status update, completion photos on bookings |
| P5 | **Crew pay** | routes only | booking work never reaches a pay statement |
| P6 | **Claims** | routes only | cannot file against a booking |
| P7 | **Revenue tracking** | two disconnected halves | `finance.ts` (routes) vs `api/admin/reports` (bookings); no combined view |
| P8 | **Business performance** | partial | no unified P&L, no cost side, no per-service margin |
| P9 | **Reviews display** | request flow ships | public display degrades to "coming soon" without Google API key (`lib/reviews.ts:6`) |
| P10 | **Equipment module** | roster only | "not (yet) tied to a specific route" per its own header — utilization, maintenance, assignment history |
| P11 | **Tenancy** | flag-off foundation | intentionally deferred — see §5 |
| P12 | **Release Center** | built, flags OFF in prod | `OPERION_APPROVAL_GATE_ENABLED` absent from prod env; live path never exercised end-to-end |
| P13 | **AI shadow/learning** | built, flags OFF in prod | `SHADOW_ANALYTICS_ENABLED`, `PLATFORM_OWNER_SUBS` unset in prod — dashboards deployed but dormant |
| P14 | **Supercharged parity** | ~22 lib modules behind | see §6 |

---

## 3. Missing Critical Workflows

Ranked by "what prevents J KISS from running completely inside Operion today."

1. **Job assignment & execution for bookings** (P1–P4). The customer revenue line has no operational execution layer. Today this happens in texts and memory.
2. **Expense tracking.** Nothing exists. Fuel, tolls, dump fees, supplies, truck maintenance, insurance, subcontractors — all outside the system. Without it there is no true profit number anywhere.
3. **Unified P&L / business performance.** Revenue lives in two places, cost lives in one place and a half, and nothing joins them.
4. **Job costing per booking.** No crew cost, no equipment cost, no expense allocation → no per-job margin → no way to know which service types actually make money.
5. **Crew pay for booking work.** Crews doing moving jobs are paid outside the system.
6. **Claims on booking work.** Damage on a customer move has no record path.
7. **Documents on bookings.** Contracts / bills of lading / signed authorizations — claim docs and crew docs exist; job docs do not.

---

## 4. Technical Debt

| # | Item | Severity | Detail |
|---|---|---|---|
| D1 | **52 stale branches** | medium | Most are merged or superseded. `git branch -a` lists 50+; many predate the merges of 2026-07-20/21. Deletion sweep needed. |
| D2 | **222 TODO/FIXME/placeholder hits** in `app/` | low-med | Concentrated in tenancy, billing, and industry-pack seams — mostly deferred-scope markers, not bugs. |
| D3 | **`jimp` missing from installed `node_modules`** | low (fixed) | Caused 2 test failures on a clean checkout. `npm install` resolves. Worth a CI guard. |
| D4 | **Dual "Update Center" surfaces** | medium | Platform console (write, owner) vs Release Center (read, admin) — overlapping mental models, documented but confusing. |
| D5 | **Money in two representations on routes** | medium | `payCents` (canonical) kept in sync with legacy free-text `pay`/`payRate` parsed by regex in `route-pay.ts` / `route-invoices.ts`. Fragile; should retire the legacy fields. |
| D6 | **Untracked docs in working tree** | low | 13 untracked files incl. generated PDFs/HTML manuals. Commit or gitignore. |
| D7 | **`VISION_ESTIMATION_SHADOW` retired but still in the flag union** | low | Flag wires nothing and "must stay false" per its own comment. Remove. |
| D8 | **Flag sprawl** | medium | 30+ flags in `platform/flags.ts`, many for shipped-and-verified work. Retire the settled ones. |
| D9 | **No booking↔staff referential integrity** | high | Root cause of §0. Renaming a staff member silently orphans historical booking assignments. |
| D10 | **Analytics split** | medium | `computeBookingAnalytics` (bookings) and `computeRouteMoney` (routes) never reconcile. |
| D11 | **`equipment.ts` header admits incompleteness** | low | "not (yet) tied to a specific route" — stale comment; route linkage now exists, booking linkage does not. |

**No blocking bugs found.** Typecheck clean, suite green, no broken production workflows detected.

---

## 5. Enterprise Features To Defer

Explicitly out of scope for V1. All of these exist in some form and are **flag-off / dormant** — they stay that way. Nothing is deleted; the flags simply remain off and no further work is invested.

| Deferred | Current state | Keep because |
|---|---|---|
| Multi-tenant SaaS architecture | foundation shipped, `TENANCY_ENABLED=false` | key-scoping chokepoint in `redis.ts` is harmless and already validated; ripping it out is riskier than leaving it off |
| Subscriptions / billing plans | not built | — |
| Self-service onboarding | not built | — |
| Enterprise billing | not built | — |
| Platform console (as a multi-tenant product) | built, owner-only | **retained for internal use** — it is how J KISS + Supercharged deployments are tracked; not developed further |
| Tenant branding | not built | — |
| SLA management | not built | — |
| Enterprise compliance | not built | — |
| Industry packs / editions | `INDUSTRY_PACKS_ENABLED=false` | the unified schedule's generic `ScheduleItem` already gives multi-industry headroom at zero cost; no further work |
| `AI_WORKFORCE_ENABLED`, `APPROVAL_QUEUE_ENABLED`, `INSIGHTS_UI_ENABLED` | off | no V1 dependency |

**Retained as internal tooling (not enterprise scope):** Release Center, Product Sync Platform, AI Command Center. These are how *you* operate the two deployments — they are internal ops, not SaaS features.

---

## 6. Supercharged readiness

`supercharged` @ `c619920` is a branded copy running an **older platform baseline** — behind `main` by 22 lib modules:

```
approvals-store  comms/  crew-documents  crew-timeclock  customers  estimate-modify
health  intake-config  intake-metrics  intake-workflow  leads  operion-demo  operion-faq
opspilot  opspilot-waitlist  outcome-capture  pack-services  pay-statement-view
release/  schedule/  sms-keywords  sms-status  twilio-webhook
```

Most consequential: **`schedule/` is absent** — Supercharged has no unified schedule or conflict detection at all. Also missing: the communications layer, crew timeclock, crew documents, and ~20 admin pages (AI Command Center subpages, communications, schedule, platform, release, sync).

The Product Sync Platform (`tools/product-sync/`) exists precisely to close this, content-based, with a ledger. Supercharged parity is therefore a **sync operation, not a build** — which is why it is scheduled late (Sprint 6) rather than early: syncing before J KISS V1 is finished means syncing twice.

---

## 7. Scorecard

Measured against the Phase-2 definition of done.

| Dimension | Score | Basis |
|---|---:|---|
| **Customer side** | **95%** | 9/9 capabilities present; reviews display degrades without a Google API key |
| **Operations side** | **55%** | 4 complete, 6 partial, 1 absent (expenses) of 11 |
| **Crew side** | **45%** | 5 of 6 capabilities exist for routes only; only availability/issues is universal |
| **AI side** | **95%** | 5/5 present and sophisticated; much of it flag-off in prod |
| **Operion overall** | **~70%** | weighted toward ops + crew, which is where daily usage lives |
| **J KISS operational readiness** | **~65%** | contract-route lane ~95% runnable today; Book Now ops lane ~40%; no expenses |
| **Supercharged readiness** | **~45%** | branded copy on an older baseline, no unified schedule, no comms layer |

---

## 8. Operion V1 finish line (definition of done)

V1 is complete when every line below is true **in the product**, for **both** the routes lane and the bookings lane.

### Customer
- [x] Receive quote requests
- [x] Upload photos
- [x] Receive estimates
- [x] Approve work
- [x] Schedule service
- [x] Receive updates
- [x] Receive invoices
- [x] Pay
- [~] Leave reviews — *request flow ships; public display needs the Google key or an internal fallback*

### Operations
- [x] View all jobs — unified schedule
- [ ] **Assign crews** — bookings must use staff records
- [ ] **Assign vehicles/equipment** — bookings must link the equipment roster
- [x] Manage routes
- [x] Track job status
- [ ] **Track revenue** — one number, both lanes
- [ ] **Track expenses** — does not exist
- [ ] **Track crew pay** — must include booking work
- [ ] **Handle claims** — must cover booking work
- [x] Generate documents
- [ ] **View business performance** — unified P&L with a cost side

### Crew
- [ ] **View assigned jobs** — must include bookings
- [ ] **Receive instructions** — must include bookings
- [ ] **Upload completion photos** — must include bookings
- [ ] **Update status** — must include bookings
- [ ] **View pay information** — must include booking work
- [x] Submit availability / issues

### AI
- [x] Analyze photos
- [x] Assist estimating
- [x] Track accuracy
- [x] Provide confidence scoring
- [x] Improve decisions without replacing business rules — deterministic pricing stays authoritative

---

## 9. Execution sprints

Ordering principle: **join the two lanes first**, then make the joined system measurable, then make it pleasant, then sync Supercharged.

---

### SPRINT 1 — Job assignment & execution for bookings
> *Close the gap that keeps the customer revenue line out of Operion.*

**Objective.** A Book Now job becomes a first-class operational job: real crew, real equipment, real execution, visible in the crew portal.

**Features**
1. `BookingAssignment` — staff-linked crew on a booking, mirroring `Assignee` on routes (staffId, name, role, payCents, paySource, per-person token)
2. Equipment/vehicle linkage on a booking (`equipmentId`, `vehicle`)
3. Booking execution capture: clock in/out, `completionNote`, `completionPhotos`
4. Crew portal shows booking jobs alongside routes ("My Jobs")
5. Unified schedule projects real crew + real equipment for bookings → conflict detection finally covers the whole business
6. Backward compatibility: `assignedTo` / `assignedHelper` continue to work and are derived from the new model

**Files affected**
- `app/lib/bookings.ts` — new types + mutators (additive)
- `app/lib/schedule/unified.ts:180-225` — replace hard-coded empties
- `app/api/admin/bookings/[id]/route.ts` — assignment PATCH
- `app/api/portal/routes/route.ts` → generalize to a job feed (or add `app/api/portal/jobs/route.ts`)
- `app/lib/crew-timeclock.ts` — accept booking jobs
- `app/admin/operations/book-now/[token]/page.tsx` — assignment UI
- `app/portal/*` — My Jobs
- new: `app/lib/job-assignment.ts` (shared crew/equipment assignment logic for both lanes)

**Data changes.** Redis, additive only. New optional fields on the `bk:*` blob. No migration; absent fields read as unassigned. Legacy bookings keep working untouched.

**Tests.** `scripts/job-assignment.test.ts` (new): assignment invariants, pay snapshot immutability, legacy-field derivation, unified-schedule projection with crew/equipment, conflict detection now firing on bookings, portal authorization (a crew member sees only their own jobs).

**Dependencies.** None. Builds on `staff.ts`, `equipment.ts`, `finance.ts`, `schedule/unified.ts` — all shipped.

**Flag.** `BOOKING_ASSIGNMENT_ENABLED` — default OFF. Off = byte-identical to today.

**Done when.** A booking can be assigned two staff members and a truck; both see it in the portal; both can clock in and upload completion photos; the unified schedule flags a double-book across a route and a booking; `assignedTo` still renders on the customer confirmation page exactly as before.

---

### SPRINT 2 — Job costing & crew pay unification
> *Make the joined system pay people correctly.*

**Objective.** Booking work flows into pay statements. Every job has a cost.

**Features:** per-person `payCents` snapshot on booking assignment (Sprint 1 lays the field, Sprint 2 wires the engine) · `computeJobPay` covering both lanes · `StatementLine` widened to `{ kind: 'route' | 'booking', ref, date, label, amountCents }` · pay statement generation spanning both · crew portal pay view includes booking work · claims fileable against a booking.

**Files:** `app/lib/route-pay.ts` → `app/lib/job-pay.ts` · `pay-statements.ts` · `claims.ts` (accept a booking snapshot) · `app/api/admin/pay-statements/*` · `app/api/portal/pay*`

**Data:** `StatementLine` gains `kind`/`ref`; existing statements are immutable and read as `kind: 'route'` by default. Claims gain an optional booking snapshot alongside the route snapshot.

**Tests:** pay arithmetic across mixed periods · statement immutability · deduction never exceeds gross · claim snapshot isolation · legacy statement read compatibility.

**Depends on:** Sprint 1.

**Done when.** A pay period containing both a contract route and a moving job produces one correct statement, and a damage claim on that moving job deducts from it.

---

### SPRINT 3 — Expense tracking & true profit
> *The missing half of the money.*

**Objective.** Every dollar out is recorded and allocable.

**Features:** `Expense` record (date, category, amountCents, vendor, method, receipt blob, allocation) · categories (fuel, tolls, dump/disposal fees, supplies, maintenance, insurance, subcontractor, permits, other) · allocation to a job, a business, or overhead · receipt photo upload · recurring/fixed expense support · expense entry from the crew portal (crew submits, admin approves) · disposal fees fold into the same ledger.

**Files:** new `app/lib/expenses.ts`, `app/api/admin/expenses/route.ts`, `app/admin/operations/expenses/page.tsx`, `app/api/portal/expenses/route.ts` · integrate `app/lib/disposal.ts`

**Data:** new key family `exp:*` + index + per-job/per-business indexes. Purely additive.

**Tests:** money parsing reuses `parseMoneyCents` · allocation invariants · receipt IDOR (same pattern as `payment-proof.ts`) · approval workflow · category rollups.

**Depends on:** Sprint 1 (job identity to allocate against).

**Done when.** A dump fee photographed at the transfer station lands on the right job and reduces that job's margin.

---

### SPRINT 4 — Unified financial visibility & reporting
> *One number, and the story behind it.*

**Objective.** One P&L. Per-job, per-service, per-business margin.

**Features:** unified revenue (bookings + routes) · unified cost (crew pay + expenses + processing fees) · per-job margin · per-service-type margin (which service actually makes money) · per-business margin for contract work · period comparison · A/R view (unpaid invoices + balances) · tax-readiness rollup (1099s already exist in `tax-readiness.ts`) · export.

**Files:** new `app/lib/pnl.ts` · rework `app/admin/operations/finance/page.tsx` into the real financial center · `app/api/admin/finance/route.ts` · reconcile `analytics.ts` + `finance.ts`

**Data:** none — pure projection over existing records, same philosophy as `schedule/unified.ts`.

**Tests:** P&L arithmetic against fixtures · revenue never double-counted across lanes · pay/expense allocation correctness · permission gating (`profitability:view`).

**Depends on:** Sprints 1–3.

**Done when.** You can answer "did junk removal make money last month, and which job lost it" without opening a spreadsheet.

---

### SPRINT 5 — Daily-use UI & mobile
> *Make it the thing you actually reach for.*

**Objective.** Operion is faster than the spreadsheet it replaces, on a phone, in a truck.

**Features:** Today view as the operational home (jobs, crews, conflicts, money, exceptions) · one-tap assignment from the schedule · mobile-first crew portal pass · resolve the deferred Release Center UX audit items · retire settled feature flags · consolidate the dual Update Center surfaces (D4) · loading/error/empty states across the new surfaces.

**Files:** `app/admin/operations/page.tsx`, `schedule/page.tsx`, `OperationsShell.tsx`, `app/portal/*`, `app/lib/platform/flags.ts`

**Tests:** `npm run audit:mobile` clean · keyboard/a11y on new controls · no regression in the 1635-test baseline.

**Depends on:** Sprints 1–4.

---

### SPRINT 6 — Hardening, Supercharged parity, daily-use readiness
> *Ship it to both businesses and prove it.*

**Objective.** Both businesses run on the same verified baseline.

**Features:** retire legacy money fields (D5) · branch cleanup (D1) · flag retirement (D7, D8) · full regression + security pass · sync everything to Supercharged via `tools/product-sync/` · runbook updates · production deploy with rollback verified · one full week of real J KISS operations run inside Operion, with a gap log.

**Depends on:** Sprints 1–5.

**Done when.** A full week of real business ran through Operion and the gap log is empty of blockers.

---

## 10. Deferred enterprise roadmap (post-V1, not scheduled)

Recorded so it is not lost, and explicitly **not** worked on:

1. Multi-tenant activation (`TENANCY_ENABLED=true`) — foundation + dark-launch + dual-write validation already exist
2. Self-service business onboarding
3. Subscription billing & plans
4. Industry editions / packs — the generic `ScheduleItem` is the seam
5. Tenant branding & white-label
6. Platform console as a customer-facing product
7. SLA management, enterprise compliance, audit export

**Trigger to revisit:** a third business, or a paying external customer. Not before.

---

## 11. Immediate priority

**The one highest-value unfinished workflow: job assignment & execution for bookings (Sprint 1).**

Not chosen for technical interest. Chosen because it is the literal answer to *"what prevents J KISS from running completely inside Operion today?"* — the moving and junk-removal side of the business, the side with AI quoting and customer payments and the most revenue per job, currently gets dispatched by text message and tracked in the owner's head. Everything downstream (crew pay, claims, costing, P&L, crew portal) is blocked on it, and every one of those systems **already exists** and works — they are simply pointed at the wrong half of the business.

**Exact first implementation task:**
> Create `app/lib/job-assignment.ts` and extend `app/lib/bookings.ts` with an additive, staff-linked `BookingAssignment[]` + equipment linkage, behind `BOOKING_ASSIGNMENT_ENABLED` (default OFF), deriving the legacy `assignedTo` / `assignedHelper` strings so the customer-facing confirmation page is byte-identical. Ship with `scripts/job-assignment.test.ts` proving the derivation and the flag-off no-op.

Branch: `feat/booking-job-assignment`.
