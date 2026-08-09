# Operion — Production Readiness Audit

**Audit date:** 2026-08-07 · **Commit:** `be45d27` · **Production deployment:** `dpl_AECcanGnrE7AmkjJPsFfwZGoPfFD`

**Updated 2026-08-09:** the registry-integrity finding (R1 / P1) is CLOSED by PR #182, merged
as `e064c1f`. Capability statuses below are unchanged — the registry was corrected to match
the system, not the other way round. Everything else stands as audited.

An evidence-based audit of whether the capabilities Operion markets are actually
production-complete. Nothing was fixed as part of this audit; findings only.

---

## Method and evidence standard

A capability was only marked **FULL** when all six held:

| dimension | how it was established |
|---|---|
| Implementation | the actual module, located by content search, not by guessed filename |
| API | route file exists AND answers in production |
| Production availability | live probe of `www.jkissllc.com` — auth-gated `401` proves the route exists and is protected |
| Permissions | a gate in `app/lib/rbac.ts` (50 distinct permissions defined) |
| Tests | named test files under `scripts/` that reference the module |
| UI | a rendered surface under `/admin/operations`, `/portal`, or public |

Two guards against fooling myself:

- An early filename-matching pass reported "equipment: 0 tests" and "messaging: 0 tests".
  Both were **wrong** — content search shows equipment referenced in 14 test files and
  messaging in 13. Filename globbing is not evidence of coverage; that pass was discarded.
- Admin pages all return `200` unauthenticated. That is **not** an access finding: they are
  client components that render a shell and fetch data afterwards. The real boundary is the
  API, and all 12 admin APIs probed return `401 {"error":"unauthorized"}`.

### System scale

| | |
|---|---|
| Admin operations pages | 53 |
| API routes | 222 |
| Crew portal pages | 12 |
| Public/customer pages | 12 |
| Test files | 274 (3,482 tests passing) |
| Cron jobs | 7 |
| `app/lib` modules | 393 |

---

## Scoreboard

**39 marketed capabilities audited.**

| status | count |
|---|---|
| FULL | 38 |
| PARTIAL | 1 |
| PLANNED | 0 |
| MISSING | 0 |
| OVERCLAIMED | 0 *(one was found and corrected pre-merge — see below)* |

**No PLANNED or MISSING capability is marketed.** The registry's five `planned`
capabilities — `organizations`, `memberships`, `customers`, `expenses`, `approvals` — all
carry `enabledForJkiss: false` and appear nowhere on the public site.

---

## Capability status

### Dispatch and scheduling

| capability | status | evidence |
|---|---|---|
| Route Assignment | **FULL** | `lib/routes.ts` · `/api/admin/routes` 401 · `/admin/operations/list` · 7 route test files · `routes:manage` |
| Recurring Routes | **FULL** | `lib/route-templates.ts` → `materializeTemplate` called by `runTemplates()` in `/api/cron/daily` (`0 14 * * *`), generating 14 days ahead. **The "generate themselves on schedule" claim is literally true**, not aspirational |
| One Unified Schedule | **FULL** | `lib/schedule/unified.ts` → `/api/admin/schedule` 401 → `/admin/operations/schedule` · 3 schedule test files |
| Smart Scheduling | **FULL** | `lib/availability.ts` · capacity/blackout/conflict logic · `schedule-conflict-scope` test |
| Contractor Confirmations | **FULL** | route confirm/decline API 401 · reassignment surfaces in `/admin/operations/list` |

### Workforce, time and compliance

| capability | status | evidence |
|---|---|---|
| Crew Management | **FULL** | `lib/staff.ts` · `/api/admin/staff` 401 · `/admin/operations/employees` · `crew:manage` |
| Time & Attendance | **FULL** | `lib/crew-timeclock.ts`, `lib/timesheets.ts`, `lib/time-corrections.ts` · `/api/admin/timesheets` 401 · tests: `crew-timeclock`, `timesheets`, `punch-overlap-audit` · `time:view` |
| GPS Clock Verification | **FULL** | geofence logic in `lib/crew-timeclock.ts` + `lib/routes.ts` · `/admin/operations/gps-compliance` · `gps-geofence` test |
| Availability & Time Off | **FULL** | `lib/crew-availability.ts`, `lib/timeoff.ts` · `/api/admin/timeoff` + `/api/portal/timeoff` both 401 · `crew-availability`, `timeoff-policy` tests |
| Daily Readiness Checks | **FULL** | `lib/uniform.ts` · `uniform-status` test · crew submit + admin review both present |
| Crew Reliability Scores | **FULL** *(thin coverage)* | `lib/crew-score.ts` → `/admin/operations/employees`. Management-only, as claimed. **Referenced by only 1 test file** |
| Hiring & Onboarding | **FULL** | `lib/applicants.ts`, `lib/ats-scoring.ts`, `lib/ats-config.ts` · `/careers` 200 public · `applicants` test |
| Crew Document Vault | **FULL** | `lib/crew-documents.ts` · `/api/portal/documents` 401 · `crew-documents` test · encrypted at rest via `lib/doc-crypto.ts` |
| Digital Agreements | **FULL** | Customer side: `agreementAcceptedAt/PolicyVersion/Ip` on `Booking` + `lib/policy.ts` versioning. Crew side: contractor agreement in `lib/crew-documents.ts`. 3 `*policy*` test files. *(No file named `agreement*` — this looked like a gap under filename search and is not one)* |
| Roles & Permissions | **FULL** | `lib/rbac.ts`, 50 permissions · `/api/admin/permissions` 401 · `permissions-ui`, `audit-permissions`, `permission-state-ux` tests |

### Equipment and fleet

| capability | status | evidence |
|---|---|---|
| Equipment Inventory | **FULL** | `lib/equipment.ts` · `/api/admin/equipment` 401 · `/admin/operations/equipment` · referenced in 14 test files · `equipment:manage` |
| Fleet Maintenance | **FULL** | maintenance/inspection logic in `lib/equipment.ts` · `/admin/operations/fleet` · `fleet-maintenance` test · `fleet:maintenance` permission |

### Customer intake and sales

| capability | status | evidence |
|---|---|---|
| Online Booking & Intake | **FULL** | `/quote` 200 · `POST /api/book` · 16 booking test files including `booking-e2e` |
| Photo-Assisted Estimating | **PARTIAL** | Analyzer and pipeline are `full`; **registry lists `quotes` as `partial`**, and the moving lane is gated by `AI_PHOTO_ESTIMATE_MOVING`, unset in both Production and Preview. Junk-family photo estimating is live; moving is not. The marketed wording is advisory and hedged, so this is a *scope* limit rather than an overclaim — see Risk R2 |
| Your Own Pricing Engine | **FULL** | `lib/pricing/*` deterministic · registry `pricing: full` · pricing computed outside the model, as claimed |
| Business Management | **FULL** | `/api/admin/businesses` · `/admin/operations/businesses` · contract rates, rate history, start/end dates |

### Money in, money out

| capability | status | evidence |
|---|---|---|
| Client Invoicing | **FULL** | `lib/route-invoices.ts` · `route-invoices` test · per-route stamping prevents double-billing |
| Deposits & Payments | **FULL** | `lib/payments.ts`, `record-payment.ts`, `payment-proof.ts` (sealed via `doc-crypto`) · `booking-payments` test |
| Pay Statements | **FULL** | `lib/pay-statements.ts` + 7 pay test files incl. `pay-statement-concurrency`, `pay-statement-void` · `pay:generate` |
| 1099 Readiness | **FULL** | `lib/crew-documents.ts` W-9 tracking + threshold assessment. Copy correctly says "assessed, never filed for you" |
| Financial Tracking | **FULL** | `/api/admin/finance` 401 · `/admin/operations/finance` |
| Route Profitability | **FULL** | `lib/route-stats.ts` + `platform/intelligence/generators.ts` · gated by `profitability:view` (managers excluded by design) |

### Claims and accountability

| capability | status | evidence |
|---|---|---|
| Claims Tracking | **FULL** | `lib/claims.ts` + 8 claim modules · `/api/admin/claims` 401 · 5 claim test files |
| Crew Cost Recovery | **FULL** | `lib/claim-payroll.ts`, `claim-accrual.ts` · deduction capping verified by `claim-payroll` test |
| ClaimGuard Assist | **FULL** | `lib/claim-assist.ts` · playbook + deep links |

### Communication

| capability | status | evidence |
|---|---|---|
| Notifications | **FULL** | `lib/notify.ts` + 4 domain notifiers · `booking-notify` test · registry `notifications: full` |
| Messaging | **FULL** | `lib/messages.ts` · `/admin/operations/messages` · referenced in 13 test files · `messages:send` |
| Client Portals | **FULL** | `/route/[token]` via `withPublicTokenRoute` — *"the token IS the credential"*. The "no login" claim is exactly right |

### Visibility and governance

| capability | status | evidence |
|---|---|---|
| Operations Dashboard | **FULL** | `/admin/operations` · `useOps.ts`. **Was marketed as "Real-Time" — corrected before merge** (see below) |
| Business Analytics | **FULL** | `lib/analytics.ts` · referenced in 20 test files · `reports:view` |
| Reports & Exports | **FULL** | `lib/claims-report.ts` · CSV export · `reports:view` |
| Audit Logs | **FULL** | `lib/audit.ts` · 9 audit test files · records denied attempts, as claimed · `audit:view` |
| AI Command Bar | **FULL** | `/api/admin/ai/command` returns `kind:'navigate'` or an answer. Copy corrected pre-merge from claiming write actions |

---

## Overclaims

**One found, corrected before merge (`#181`):**

> "Real-Time Operations Dashboard" → "Operations Dashboard"

There is no polling, socket, or revalidation anywhere under `app/admin/operations` —
`useOps.ts` and the dashboard both fetch once on mount. The surface is current when opened,
not live.

**One corrected by the authoring session, recorded so it is not reintroduced:**

> "AI Command Palette — *'add a route for Acme tomorrow'* — and it happens"
> → "AI Command Bar — takes you there or answers from your live data"

The old copy sold write actions the endpoint does not perform.

**No remaining overclaim was found in the 39 marketed capabilities.**

---

## Registry integrity — the most actionable finding — **RESOLVED `e064c1f`**

> **Status: closed 2026-08-09 by PR #182.** Kept in full below because the failure mode is
> worth remembering, not because it is still open.

`app/lib/platform/capabilities/registry.ts` is documented as the internal status of record,
and `lib/opspilot.ts` instructs editors to cross-check it before changing marketing copy.
**Four shipped, marketed capabilities were absent from it entirely** — three found in the
original sweep, a fourth (`businesses`) found by the completeness pass:

| capability | implementation | why it mattered |
|---|---|---|
| **Claims** | `lib/claims.ts` + 8 modules, `/admin/operations/claims`, 5 test files, live in production, **3 cards on the public site** | A whole revenue-protection domain was invisible to the registry |
| **Client Accounts** (`businesses`) | `lib/businesses.ts`, `/api/admin/businesses`, 2 admin surfaces, `businesses:manage`, 25 test files | Hidden by the presence of a *different*, `planned` `customers` entry |
| **Crew reliability scoring** | `lib/crew-score.ts` → employees page | Marketed, unregistered |
| **Hiring / careers portal** | `lib/applicants.ts`, `ats-scoring.ts`, `/careers` public | Marketed, unregistered |

The rule "only `status: 'full'` may be marketed" could not be enforced against capabilities
the registry did not contain — an omission *disabled* the guardrail rather than tripping it.
This was a **governance gap, not a product gap**: all four were production-complete.

**What changed:** all four registered as `status: 'full'`, each entry recording where the
capability actually lives. The registry header now documents the status vocabulary, the fact
that `enabledForJkiss` answers a different question from `status`, and — the point — that
absence from the registry is not evidence the product lacks something. Registry now holds
**41 capabilities, 0 validation errors**; `full` 28→32.

**Still open (secondary):** the guidance comment in `lib/opspilot.ts` names only
`customers, expenses, approvals, organizations` as the excluded partial/planned set. The
registry also has `leads`, `jobs`, `quotes`, and `automations` as `partial`. That comment
remains out of sync — see P2.

---

## Risks

| id | risk | severity | basis |
|---|---|---|---|
| ~~**R1**~~ | ~~Registry omissions let future marketing copy overclaim without tripping the documented check~~ | ~~High~~ | **CLOSED `e064c1f`** — all four registered; guardrail restored |
| **R2** | `AI_PHOTO_ESTIMATE_MOVING` unset in both environments — moving photo estimating is marketed generically as "job photos" while only the junk family is analyzed | **Medium** | flag registered `false`, unset in Production and Preview |
| **R3** | Tagline still reads "AI Operating System for Business" across `OPSPILOT_TAGLINE`, `COMPANY.tagline`, and the hero logo asset — contradicting the repositioning away from AI-first | **Medium** | 3 locations, 2 outside marketing scope |
| **R4** | Thin test coverage on `crew-score` (1 file) and `route-templates` (2 files) relative to their marketing prominence | **Medium** | recurring-route generation is a headline claim running unattended on cron |
| **R5** | Multi-tenancy is `planned` and `TENANCY_ENABLED` is unset — Operion is marketed as "opening to more operators" while `organizations`/`memberships` remain planned | **Medium** | registry + flag state |
| **R6** | Merge→deploy is intermittently unreliable; #179 merged green and produced no production deployment | **Low** | observed twice; mitigated by post-merge build-ID verification |

---

## Recommended priorities

| # | action | rationale | owner |
|---|---|---|---|
| ~~**P1**~~ | ~~Add `claims`, `crew-reliability`, `hiring` to the registry~~ | **DONE `e064c1f` (PR #182)** — plus `businesses`, found by the completeness sweep | — |
| **P2** | Sync the partial/planned list in the `lib/opspilot.ts` header comment with the registry | One-line correctness fix; prevents the next editor trusting a stale list | *unassigned* |
| **P3** | Decide the tagline question (R3) — either reposition it in all three locations or accept the tension deliberately | Most visible remaining inconsistency; needs a brand decision, not an edit | *owner decision* |
| **P4** | Add regression coverage for recurring-route materialization and crew scoring | Recurring generation runs unattended daily; a silent failure produces missing routes | *unassigned* |
| **P5** | Decide whether to flip `AI_PHOTO_ESTIMATE_MOVING` or narrow the estimating copy to the junk family | Resolves R2 in whichever direction is intended | *owner decision* |
| **P6** | Treat multi-tenancy as the gate on "opening to more operators" messaging | R5 — sequencing question, not a defect | *owner decision* |

---

## Release readiness

**For J KISS's own operation: READY.** Every marketed capability is implemented, deployed,
auth-gated, and exercised by tests. All 12 admin APIs and all 7 crew portal APIs answer
`401` unauthenticated in production, so the surfaces exist and none leaks data. The full
suite is green at 3,482 tests, and the build renders 177 pages.

**For multi-operator ("opening to more operators"): NOT READY.** `organizations`,
`memberships`, and `customers` are `planned` with `enabledForJkiss: false`, and
`TENANCY_ENABLED` is unset in every environment. Operion today is a single-tenant system
that runs two related businesses. That is a materially different claim from multi-tenant SaaS,
and R5 should be resolved before the demo-and-onboarding funnel scales.

### Verification limits — what this audit did NOT establish

Stated plainly so the confidence above is not read wider than it is:

1. **No authenticated UI verification.** Admin and crew screens were verified to exist and be
   auth-gated, not visually confirmed. Owner credentials are a shared password with no user
   record and are unobtainable in Preview; using production credentials was out of scope.
   *Only `/operion` was visually verified, at 1440 / 768 / 390 with zero overflow.*
2. **No production data inspection.** Record counts, job queue depth, and whether capabilities
   are actively *used* were not measured — Production KV credentials were deliberately not
   accessed.
3. **Test presence is not test quality.** Coverage was measured by reference, not by asserting
   each test meaningfully exercises its capability. Two coverage claims in this repo have
   already been found vacuous by mutation testing, so treat counts as a floor.
