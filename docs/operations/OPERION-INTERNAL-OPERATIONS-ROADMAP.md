# Operion Internal Operations Completion Roadmap

**Updated:** 2026-07-30
**Customers:** J KISS LLC and Supercharged  
**Scope:** Daily internal operations. Enterprise tenancy, editions, subscriptions, and self-service onboarding remain deferred.

This roadmap supersedes the execution ordering in `OPERION-V1-COMPLETION-REPORT.md`. That report remains the detailed repository audit; this document reflects the completed booking-assignment work and the verified Preview storage repair.

## Current baseline

- Booking-to-crew and equipment assignment is implemented behind `BOOKING_ASSIGNMENT_ENABLED`.
- Bookings and routes share schedule conflict detection.
- Assigned crew can see booking jobs, accept or decline, clock in/out, and attach completion photos.
- J KISS Preview uses `OperionPreview` Redis and `operion-preview-blob`.
- Supercharged Preview now uses its own `SuperchargedPreview` Redis; it is no longer connected to J KISS's Redis or Blob store.
- A dedicated `supercharged-preview-blob` exists and is connected to Supercharged Preview under `SC_PREVIEW_` variables. Existing Supercharged upload code still uses its legacy Blob token until the parity sprint migrates it.
- Preview crew uploads use presigned, put-only Blob tokens bound to the configured store ID.
- J KISS Production configuration and deployment were not changed during Sprint 0.
- Booking status transitions are governed by one authoritative matrix in
  `app/lib/booking-status.ts`; all eleven mutation sites route through `canTransition`
  and fail closed on an illegal pair.
- Sprint 2 code is merged through PRs #128 and #130. Schedule scoping, explicit
  dispatch readiness, and the owner-side vehicle rule are now on `main`; automatic
  route cancellation remains flag-off and unscheduled.
- Sprint 3 weak-network handling is merged through PR #131. Crew job reads,
  accept/decline, and clock punches now have bounded, retry-safe behavior.
- Completion-proof idempotency and the visible photo-retry increment are merged through
  PR #132, live in Production as deployment `dpl_DNUCzre3V7LEJJvCCTdYykdUtzGr`.
- Crew Activity — the read-only aggregate over the assignment audit ledger, gated on
  `audit:view` — is merged through PR #134 (`dpl_8UAqrrrZURtFrLdZJnuRaHYSTBrH`).
- PR #135 unpinned the auto-cancel integration suite from the calendar: the cron job body
  moved to `app/lib/schedule/auto-cancel-job.ts` so its clock is an ordinary parameter,
  and Production still passes `Date.now()` from the route. It fixed a red `main`
  (`dpl_382FhqAxfub2szYbnngjg2zQFfLc`).
- Sprint 6 on `main` passes **3097/3097 tests**, TypeScript, and lint with zero errors
  (one pre-existing warning in untouched `pay-statements.ts`).
- The Sprint 3 completion-integrity follow-up is implemented separately: delayed
  admin completion cannot strand effective punches, and a correction-masked public
  punch is rejected instead of reporting a false clock-out.
- Sprint 4 is complete without changing pricing rules or visible customer copy.
  Photo-set identity now governs draft attachment, durable AI idempotency, admin
  invalidation, final-confirmation freshness, and OpsPilot read-back.
- `BOOKING_ASSIGNMENT_ENABLED` is **Production ON, independently verified on 2026-07-29
  through the route-gate probe**. The crew booking surface is serving, not dormant. See
  [Production activation decision](#booking_assignment_enabled--production-activation-decision).
  No flag change is authorized without owner approval.

## Sprint 0 — Foundation cleanup

**Objective:** Put the booking-assignment branch on the current platform baseline and prove Preview/Production isolation before more feature work.

**Status:** Complete.

**Affected files/components:**

- `app/lib/platform/flags.ts`
- `app/api/portal/upload/route.ts`
- `app/portal/jobs/[id]/page.tsx`
- `scripts/portal-presigned-upload.test.ts`
- Vercel Preview-only connections and variables for J KISS

**Completed work:**

- Merged current `origin/main` into `feat/booking-job-assignment` while preserving both booking and AI flags.
- Reconnected `OperionPreview` to J KISS for Preview only; replaced empty Redis credentials.
- Repaired Preview-only booking flag, admin password, and session secret.
- Replaced Supercharged's shared Preview Redis binding with `SuperchargedPreview` and removed its connection to J KISS's Preview Blob store.
- Provisioned dedicated Supercharged Preview Blob storage without replacing its existing upload token prematurely.
- Replaced legacy crew Blob upload transport with OIDC-compatible presigned uploads.
- Added a fail-closed store boundary: missing store configuration or a token for the wrong store rejects the upload.
- Verified a real protected-Preview upload on booking `JK-B-1009`; the persisted URL uses the `operion-preview-blob` hostname.

**Verification:** TypeScript; focused lint; 1742 tests; 2 AI regressions; production-mode build; mobile audit 45/45; authenticated protected-Preview crew upload; Redis read-back; Blob hostname/store-ID check.

**Difficulty:** High — configuration and storage isolation were the risk, not the UI change.

## Sprint 1 — Complete booking and crew workflow

**Objective:** Close the remaining operational seams after assignment, so a booking follows one explicit state path from dispatch through completion and pay preparation.

**Affected files/components:**

- `app/lib/booking-assignment.ts`
- `app/lib/bookings.ts`
- `app/lib/crew-timeclock.ts`
- `app/lib/pay-statements.ts`
- `app/api/admin/bookings/[id]/assignment/route.ts`
- `app/api/portal/jobs/*`
- `app/admin/operations/book-now/[token]/page.tsx`
- `app/portal/jobs/*`

**Dependencies:** Sprint 0; existing staff, equipment, schedule, and finance records.

**Status:** Complete (code); **Production ON, independently verified on 2026-07-29 through
the route-gate probe** — this surface is serving.

**Completed work:**

- Booking crew pay snapshots feed pay-statement generation — `pay-statements.ts` carries
  `source: 'route' | 'booking'`, covered by `scripts/booking-pay-integration.test.ts`.
- The assignment → accept → clock → photo → complete workflow was rerun on isolated
  Preview; it surfaced and fixed a customer-visible stale-crew-name defect.
- Legacy booking reads are preserved: an unrecognised stored status is neither coerced
  nor rewritten, and `recompute()` still returns money fields for such records.
- A single authoritative status-transition matrix now governs every booking status
  change (see below).

**Booking status transition matrix:** `app/lib/booking-status.ts` exports
`BOOKING_TRANSITIONS` (the adjacency map over all 17 statuses), `canTransition()` — the one
validation boundary — and `nextStatusOrKeep()` for the fact-derived automatic paths. Of the
289 status pairs, 129 are allowed, 143 are refused, and 17 are idempotent same-status
no-ops. Terminal statuses may only move between closure outcomes and never back into the
active funnel; `refunded` is absorbing. The matrix was derived from an audit of the
pre-existing call sites, so every workflow that previously worked still does — what changed
is that anything outside them is now refused rather than silently written.

**Production activation status:** `BOOKING_ASSIGNMENT_ENABLED` is **Production ON,
independently verified on 2026-07-29 through the route-gate probe**. Any enable/disable
change remains an owner decision — see
[Production activation decision](#booking_assignment_enabled--production-activation-decision).

**Verification:** assignment and conflict tests; authorization tests; duplicate-action idempotency; real mobile crew flow; mixed route/booking pay statement fixture; Preview data inspection.

**Difficulty:** Medium.

## Sprint 2 — Finish admin operations dashboard

**Objective:** Give dispatch one simple daily view for bookings, routes, crew, equipment, conflicts, and work requiring attention.

**Status:** Complete (code); route auto-cancellation activation remains separately gated.

**Affected files/components:**

- `app/admin/operations/page.tsx`
- `app/admin/operations/schedule/page.tsx`
- `app/admin/operations/book-now/*`
- `app/components/admin/OperationsShell.tsx`
- `app/lib/schedule/*`
- admin schedule, booking, staff, and equipment APIs

**Dependencies:** Sprint 1 lifecycle and assignment source of truth.

**Current implementation:**

- Schedule conflicts and Attention totals use the same selected-day boundary; historical
  conflicts are hidden without rewriting historical routes.
- Vehicle/equipment readiness is opt-in per route through `requiresVehicle`; existing
  routes and route types remain compatible.
- Admin confirmation refuses a route that explicitly requires equipment but has none.
  Crew acceptance remains separate from owner-controlled dispatch readiness.
- The stacked closeout stores `dispatchReadiness` independently from route status,
  distinguishes crew/equipment/closed states, and stamps real readiness transitions.
  Owner assignment texts fail closed while required equipment is missing; crew may
  still accept an existing link and sees a clear “confirmed—waiting on equipment”
  message. The owner route screen now exposes the opt-in requirement control.
- A protected route auto-cancel endpoint exists for routes that reach their Central-time
  route day with no crew. It is fail-closed on incomplete scans, rechecks full eligibility
  under the route lock, and records one attributed lifecycle event.
- `ROUTE_AUTO_CANCEL_ENABLED` defaults off. No Vercel cron schedules the endpoint, and
  merging PR #128 does not activate automatic cancellation or change Production data.
- Tenancy-enabled execution remains blocked until a complete tenant registry can be
  proven; the job will not sweep one tenant and claim platform-wide success.

**Remaining before automatic route cancellation can be activated:**

- Design and verify complete tenant fan-out before scheduling the cancellation endpoint.
- Run Preview-only dry reports across representative route days before any separate
  activation proposal.

**Verification:** desktop and 320/375/390/430 px layouts; search/filter state; one-click navigation from alerts to records; no hidden conflicts; role checks for owner/admin/manager; empty/loading/error states.

**Difficulty:** Medium-high.

## Sprint 3 — Finish crew mobile workflow

**Objective:** Make the crew portal dependable in a truck or at a job site, including weak-network behavior.

**Status:** In progress.

**Affected files/components:**

- `app/portal/*`
- `app/api/portal/*`
- `app/lib/crew-timeclock.ts`
- completion-photo and document upload paths
- client-side pending-action storage/queue

**Dependencies:** Sprint 1 state matrix and Sprint 0 isolated upload transport.

**Current implementation:**

- My Jobs, booking-job details, and the shared timeclock detect offline state,
  preserve already-loaded details, reload after reconnect, and show a real retry action.
- Reads retry a bounded three times on dropped connections and transient HTTP failures.
- Accept, decline, clock-in, and clock-out use the same bounded retry because their
  server mutators are already idempotent; an unknown first response cannot create a
  duplicate event or punch on retry.
- Completion proof remains excluded from automatic mutation retry: recovery is an
  explicit crew action, while the server-side request key makes that action safe.
- Completion proof now carries a bounded request-level dedupe key. A lost response
  can be retried without replacing the first timestamp/note or adding another audit
  event, and those internal keys are excluded from every customer projection.
- The request key is validated on the RAW trimmed value: a non-string, an id under 16
  characters, an id over 100 characters, or an invalid character is refused with a
  400. The id is never truncated into validity, so two distinct ids cannot collapse
  onto one dedupe key and silently discard a genuinely-new completion.
- The job screen keeps selected files and each successful Blob URL in page memory
  after a failed attempt, then offers a visible 44 px **Retry upload** action. It
  retries only unfinished files and reuses the original completion request ID.
- A pending attempt is IMMUTABLE. While photos are pending, the dispatch note is
  read-only and the file picker is disabled, so a crew member cannot make an edit that
  looks accepted and is then dropped when the original request id is replayed, and
  cannot abandon Blob URLs that already uploaded. The note stays focusable and keeps
  its accessible name, and both controls are described by an always-rendered
  explanation of the lock. **Retry upload** stays available whenever online and no
  action is in flight. The note and picker are restored only on success or on page
  navigation, and the retry card says so.
- No punch is stored for later delivery: replaying a payroll action after reconnect
  would incorrectly stamp server receipt time as work time. Offline punches fail
  visibly instead of silently changing the time.

**Legacy public route-confirmation surface — decision: RETAIN AND HARDEN.**

A read-only audit resolved the open "apply the treatment or retire it" question in
favour of retaining it. The deciding evidence: **a route assignee is not guaranteed to
have a login.** A `Staff` roster record and a `User` account are separate objects,
`staff.email` is documented as "contact only", and creating a crew login is a distinct
admin action (`POST /api/admin/users`, role `crew` + `staffId`). Assigning someone to a
route creates no account, so for an account-less contractor the public token is the only
way to act — and SMS delivers that link in the assignment, reminder, and details
messages (`route-notify.confirmUrl`). Redirecting or retiring would strand exactly the
population the surface exists for. `/portal/jobs` and `/portal/clock` already cover both
lanes functionally; the gap is authentication, not capability.

`/route/[token]` now carries the same connection treatment as the portal: bounded read
retry, automatic mutation retry restricted to the four verbs that are idempotent
server-side (`confirm`, `decline`, `clock_in`, `clock_out` — each guarded by its own
stamp and answering `already` on replay), completion left single-attempt, an offline
banner that keeps the route readable, every action control disabled while offline, and a
reload on reconnect. **No punch is queued** — an offline punch is refused outright,
because a stored punch would record the reconnect moment as the work time.

A failed read is never reported as a dead link. "Link not found" is now reserved for a
literal 404 — which is the single, identical answer the API gives to an invalid,
malformed, revoked, unknown, or foreign-tenant token. A dropped connection, exhausted
retry, timeout, 408/425/429 or any 5xx produces a connection/service error instead:
details already on screen are preserved with a non-blocking Retry beside them, and a
first load with no data yet shows either an offline state or a connection-error state
with a 44 px Try again.

**Remaining before Sprint 3 closes:**

- **Sprint 3.1 Phase A (measurement) is built**: `/admin/operations/punch-overlaps`,
  gated on `audit:view`, tenant-scoped, read-only and aggregate-only. It answers whether
  D1 has actually happened — currently-open duplicate punches and historical overlapping
  intervals, each reported both globally and restricted to a shared service date, split
  by route/route, route/booking and booking/booking, with per-lane scan completeness.
  It enforces nothing and changes no punch. Phases B (consolidate the duplicated punch
  logic) and C (enforce one open punch) remain unstarted and unapproved.
  - Note the portal's existing guard is **day-scoped** (`selectClockable` filters on
    `routeDate`), so the same-date figure is what today's rule would have prevented and
    the global figure is what a stricter rule would catch. That asymmetry is a decision
    for Phase C, not an accident to fix silently.
  - Surface attribution is **inferred, best-effort**: a punch record carries no marker
    (`Assignee` has `confirmedVia` but no `clockedVia`), so it is read from the audit
    trail, which is capped at 200 entries per route. Punches outlive that evidence, so
    an `unattributable` bucket is reported as a real answer.
- **Sprint 3.1 completion clock-out is built**: completing a route through the public
  contractor link now closes that crew member's open punch, at the identical timestamp
  the route is marked complete. This closed a *guaranteed* defect, not an edge case —
  no surface set `clockOutAt` on completion, so anyone who clocked in and then finished
  from the link stayed on the clock indefinitely. It is what produced the single stale
  Production punch (route JK-R-1004).
  - The decision is made on the **effective** punch (`effectivePunch` over
    `listCorrections`), so an admin correction that already closed the punch is never
    overwritten, and an absent clock-in is never turned into one.
  - Completion and clock-out share **one** `Date.now()` and **one** `saveRoute`, so the
    record cannot claim the shift ended at a different moment than the work did, and a
    failed save leaves the route uncompleted with the punch untouched — recoverable by
    retrying the same request. If corrections cannot be read at all, completion is
    **refused** (503) rather than completing on a guess.
  - The automatic punch records `clockOutLocationDenied`, so a missing GPS pin reads as
    unverified rather than as a verified one.
  - **Correction-masked punches fail closed.** A correction is a separate append-only
    record, and the current store has no transaction spanning that ledger and the job
    record. If a correction leaves the effective punch open, public completion now
    refuses with an explicit dispatch/time-correction recovery message instead of
    writing a raw clock-out that the correction would hide and falsely reporting
    success.
  - **Delayed admin completion never invents payroll time.** Admin route completion and
    both booking status-completion paths read the same effective-time projection as
    Timesheets. If any assignee remains effectively open, completion is refused and
    names the crew whose time must be closed or corrected first. A correction-store
    failure also refuses the transition rather than completing on raw data.
  - `recordBookingCompletion` remains intentionally proof-only. It stores field photos,
    note and `jobCompletedAt`; it does not end a shift or change `BookingStatus`.
    Actual booking closure remains the owner's explicit status transition, where the
    effective-open-punch gate applies.
- **Two divergences that remain deliberately untouched**, because both alter live
  contractor write behaviour and need their own owner-approved change:
  1. The public surface does **not** enforce `hasOtherOpenPunch`. The portal refuses a
     second concurrent clock-in on a different job; a contractor holding two route links
     can hold two open punches at once. Payroll-relevant.
  2. The public API implements `clock_in`/`clock_out` **inline** instead of using the
     shared, tested `applyPunch` that both the portal and the booking lane use — two
     copies of one rule.
- Verify accept/decline, punches, duplicate taps, and photo recovery at
  320/375/390/430 px on representative iPhone and Android browsers.
- Run an authenticated Preview mobile flow with forced request interruption and
  inspect the resulting audit history for exactly-once events.

**Verification:** iPhone and Android widths; accept/decline; clock in/out; retry after network interruption; duplicate taps; photo retry; assigned-only authorization; no pricing/internal-note leakage.

**Difficulty:** High — offline and retry behavior affects field reliability.

## Sprint 4 — Complete customer booking and AI quote experience

**Objective:** Make the existing customer pipeline understandable and dependable from photo selection through quote decision and OpsPilot visibility.

**Status:** Complete.

**Affected files/components:**

- `app/quote/*`
- `app/api/quote/*`
- `app/lib/estimation/*`
- `app/lib/pricing/*`
- `app/lib/book-now-ai.ts`
- booking detail AI estimate panels and analytics events

**Dependencies:** Stable booking lifecycle from Sprint 1; no pricing-rule changes without explicit approval.

**Verification:** zero/one/six photos; remove/change photos invalidates stale analysis; provider failure saves manual-review booking; quote/range/manual-review outcomes; mobile photo previews; duplicate submission; OpsPilot read-back.

**Completion evidence (2026-07-30):**

- Zero, one, and six-photo requests persist into the booking index and read back
  through the same queue projection OpsPilot renders.
- Draft estimates attach only when their exact source-photo set matches the submitted
  set. Replacing a photo with another at the same count creates a new durable AI job;
  simple reordering does not.
- Owner photo edits preserve prior analysis as invalidated audit history, retire stale
  final analysis/confirmation, and queue the current evidence. An invalidated
  confirmation cannot be retried as if it were current.
- A provider-failure draft remains attached as manual-review evidence while the
  bounded durable recovery job is queued. Customer submission is never lost.
- Duplicate quote submission returns the original durable booking.
- Existing responsive photo previews, retry/remove controls, and
  instant/range/manual-review routing remain unchanged. No pricing rule changed.
- Full suite **3029/3029**, TypeScript, lint (zero errors; one pre-existing warning),
  ordinary Production build, and tenant-enabled Production build pass.

**Difficulty:** High.

## Sprint 5 — Payments, invoices, and customer history

**Objective:** Join booking execution, payment, invoice, communication, and customer history into one traceable record.

**Affected files/components:**

- `app/lib/pay-statements.ts`
- invoice and payment libraries/APIs
- `app/lib/customers.ts`
- booking/customer admin pages
- communications history and claims linkage

**Dependencies:** Sprints 1 and 4.

**Verification:** no duplicate customers/invoices/jobs; immutable issued statements; partial/full/manual payment; refunds; mixed booking/route pay; customer timeline; authorization and audit history.

**Difficulty:** High.

**Status — the retail customer record is built.** `/admin/operations/customers` is a
deterministic lookup (email, phone, or a booking token) and
`/admin/operations/customers/[id]` is that customer's timeline: bookings, payments,
refunds and communications, plus the booking event trail for readers who hold
`audit:view`.

- **The join is DERIVED, never stored.** A `Booking` carries `customerName`,
  `customerPhone` and `customerEmail` but no customer id, and nothing back-fills
  one. The association is resolved at read time from the identity indexes
  `customers.ts` already maintains (`cust:email:*`, `cust:phone:*`). That works on
  every historical booking with no migration and no Production write. The API
  returns `linkProvenance: 'derived'` and the UI states it in prose, so a reader
  never mistakes the link for a stored fact.
- **Matching is deterministic and fails closed.** Names are never matched — two
  people share a name far more often than a phone number, and a bad merge joins one
  person's payment history to another's. When email and phone resolve to DIFFERENT
  customers the result is `conflict`: surfaced for manual review, excluded from
  totals, attributed to neither side. (`customers.findCustomerId` returns the email
  match first and stops; that is right for claiming one identity on upsert and
  wrong for reporting the truth, so the resolver is separate.) A booking with
  neither identifier is explicitly `unlinked`, never guessed.
- **Incompleteness is reported.** There is no per-customer booking index, so the
  timeline scans the booking index under a bound. A truncated scan or an unreadable
  record sets `scan.complete: false` and the UI says the totals are a floor — "no
  history" and "we stopped looking" stay distinguishable.
- **Authorization.** New `customers:view` (admin + manager). The booking audit
  section is separately gated on `audit:view`, which `rbac.ts` keeps admin-only, and
  is omitted server-side rather than hidden in the UI. Tenant-scoped throughout;
  the same identity in two tenants is two records.

**Deferred out of Sprint 5, deliberately and not silently:**

1. **B2B invoice history.** `route-invoices.ts` keys invoices to `businessName` and
   `claims.ts` keys claims to `businessKey`/`routeToken`. Neither carries a booking
   or retail-customer reference, so joining them here would mean inventing a
   relationship the data model does not have. A B2B client timeline is its own
   increment.
2. **A durable `customerId` on `Booking`.** The derived join is correct and
   migration-free, but it is recomputed on every read and cannot attribute a
   booking that has no email and no phone. Stamping `customerId` at write time (plus
   a backfill) would make the link durable. Not required for this sprint, and not
   started — it is a Production data migration and needs its own approval.

## Sprint 6 — AI latency optimization

**Objective:** Reduce the approximately 30-second photo-estimate latency without changing schema, deterministic pricing, confidence, or manual-review behavior.

**Affected files/components:**

- AI provider/model routing
- prompt registry and A/B configuration
- estimation telemetry and comparison reports
- Preview-only flags for LAT-002

**Dependencies:** Sprint 4 correctness baseline and representative photo fixtures.

**Verification:** isolated A/B test comparing latency, output tokens, model cost, quote parity, confidence parity, review rate, and schema validation; controlled provider integration run only when credentials are available.

**Difficulty:** Medium-high.

**Status — the LAT-002 harness is built.** `/admin/operations/ai/lat002` reports
paired A/B runs across all seven dimensions the verification list names.

- **LAT-002 is an EXPERIMENT IDENTIFIER, not a service level objective.** No latency
  threshold existed anywhere in this repo, and inventing one would create a
  Production SLO nobody agreed to — a build that fails because a provider had a slow
  afternoon. It is defined the way the codebase already defines its other
  comparison (`image-opt-eval.ts`): a paired measurement with a verdict.
- **The asymmetry is the design.** Latency, output tokens and model cost are
  MEASURED and never fail a run — a slower candidate is a result, reported as a
  signed negative so "no change" and "half as fast" cannot render identically.
  Quote parity, confidence parity, review rate and schema validity are GUARDRAILS:
  breaching any one is `parity_regression` and is never promotable, however large
  the speed win. That is what makes the objective — reduce latency *without*
  changing schema, pricing, confidence or manual-review behaviour — enforceable.
- **Schema validity is absolute, not a rate.** One invalid candidate response is a
  regression, because the sprint objective says the schema does not change.
- **Sample-size honesty.** Below `minPairs` the verdict is `insufficient_samples`,
  decided before the guardrails so a tiny flattering sample can never read as safe.
- **Runs are evidence.** The pairs are stored with the report, and the report is
  RECOMPUTED from the stored pairs on save, so a stored verdict cannot disagree
  with its own inputs. Re-recording the same `runId` replaces it, so a retry after
  an unknown response is safe.
- **Flag + authorization.** `LAT002_EXPERIMENT_ENABLED` (default OFF everywhere,
  Preview-only by intent) gates RECORDING; reading is always available so evidence
  outlives the flag. Reading takes `ai:analytics` (admin + manager); recording takes
  `ai:prompts:manage` (admin only — recording is what decides promotability).
  Tenant-scoped throughout; runs in one tenant are invisible to another.
- Percentiles come from `ai/analytics.latencyStats`, now exported, so LAT-002 and
  the AI Control Center cannot disagree about what p95 means.

**Deferred:** the controlled live-provider integration run. The harness accepts
paired samples from any source and the evaluator is pure, so a live run is a matter
of feeding it real arms with credentials present — it is not performed here, and no
run has been recorded in Production.

## Sprint 7 — Production readiness and Supercharged parity

**Objective:** Prove daily operation for both businesses, then release only the business-appropriate surfaces.

**Affected files/components:**

- release runbooks and gates
- Product Sync manifests and managed-target boundary enforcement
- J KISS and Supercharged Preview/Production configuration
- monitoring, rate limits, backups, and rollback evidence

**Dependencies:** Sprints 1–6; dedicated Supercharged Preview Redis and Blob isolation; control-plane files excluded from managed-target transfers.

**Verification:** full typecheck/lint/tests/build/AI regression; security and role matrix; real Preview workflow for both businesses; deployment/rollback canary; production smoke tests; one-week operational gap log.

**Difficulty:** High.

## `BOOKING_ASSIGNMENT_ENABLED` — Production activation decision

### Current state

**Production ON, independently verified on 2026-07-29 through the route-gate probe.**

**Owner decision, 2026-07-30: the 2026-07-26 activation was INTENTIONAL, and
`BOOKING_ASSIGNMENT_ENABLED` remains ON unless an explicit rollback criterion below is
met.** Keep-on criterion 1 is therefore satisfied. This closes the question of whether the
flag was set by accident; it does not pre-authorize any future change, which still requires
owner approval.

- The Production variable was created **2026-07-26 23:28:22 UTC** by the **account owner**
  (Vercel `OWNER` role), typed `sensitive`. `updatedAt` equals `createdAt` and `updatedBy`
  is null, so it has **never been modified since creation** — activation happened at
  creation, not by a later flip. The Preview variable was created ~3h48m earlier the same
  day, consistent with a deliberate Preview-then-Production sequence.
- The first Production deployment after the variable existed was **2026-07-27 00:13:25 UTC**
  (`11a7a9d`); the deployment before it predates the variable by ~10 minutes. The surface
  has therefore been serving for roughly **73 hours** as of this audit.
- Current Production deployment: `dpl_DNUCzre3V7LEJJvCCTdYykdUtzGr` (merge commit
  `7f0ecd2`, PR #132). `/api/health` returns `healthy` with a matching `build` field.

**How the probe proves it.** In `app/api/portal/jobs/[id]/route.ts` and
`app/api/portal/jobs/route.ts` the flag gate runs *before* `requireCrew`, and
`withTenantRoute` performs no authentication of its own. `scripts/booking-assignment-flag-off.test.ts`
pins that ordering: with the flag off an anonymous probe must get `404` — *"not 401 — the
surface is absent, not protected."* An unauthenticated `GET /api/portal/jobs/<dummy>` on
`www.jkissllc.com` returns **`401 {"error":"unauthorized"}`**, so the gate was passed and
the flag is enabled. A genuinely absent route (`/api/definitely-not-a-route`) returns the
HTML 404 page, which distinguishes all three states. The secret value is never read; only
the flag's *effect* is observed. Note `jkissllc.com` 308-redirects to `www.jkissllc.com`.

### Evidence of usage

**Crew Activity (`/admin/operations/crew-activity`) now answers this from inside the app.**
A read-only admin page and `GET /api/admin/booking-assignment-activity`, gated on
`audit:view` (admin only — the narrowest fitting capability, since `time:view`,
`routes:view` and `reports:view` all also reach manager), aggregate the assignment audit
ledger that `pushBookingEvent` was already writing. Nothing was instrumented, migrated, or
backfilled.

It reports counts for accepted / declined / clock-in / clock-out / completion-recorded,
first and most recent event, total events, distinct crew as a COUNT, and a completion
idempotency split (with request id / distinct / duplicate / legacy-without-request-id).
Default range seven days, bounded to 90. Counts, booleans and dates only — no customer,
crew-identity, token, pay, note, photo, or per-booking data.

**Crew Activity is deliberately NOT gated on `BOOKING_ASSIGNMENT_ENABLED`.** Every other
booking-crew surface 404s when that flag is off; this one stays readable, on purpose. It is
an audit view, and the moment the assignment history matters most is **during or after a
rollback** — to see what crew members did while the feature was live, reconcile timeclock
and pay against it, and decide whether to re-enable. Gating it would erase the evidence
exactly when it is needed, and would make "no activity" ambiguous between *nothing
happened* and *the surface is switched off*. Access is still restricted to `audit:view`
(admin only) and scoped to the active tenant. A test asserts the handler never reads the
flag, so a future edit cannot quietly reintroduce a gate.

**Coverage is proven, not assumed.** The scan takes the authoritative index size (ZCARD)
first, pages the index, dedupes tokens, and compares. If the traversal falls short for any
reason — page ceiling, an indexed record that is gone, concurrent index churn — it returns
`scanComplete: false` and the page refuses to present authoritative totals, labelling them
lower bounds behind a warning instead.

**Remaining limitation.** Each booking keeps at most 200 audit events
(`BOOKING_MAX_EVENTS`), so a booking sitting at that cap may already have dropped older
events; the page reports how many bookings are at the cap and states that their counts are
a lower bound. The surface also cannot see anything outside the retained ledger, so it
characterizes the ledger, not all history. Below is what was attempted BEFORE this existed,
kept because it explains why external verification is not an option:

- **Booking audit events** (`assignment.accepted` / `.declined` / `.clock_in` / `.clock_out`
  / `.completion_recorded`) live in Production KV. Every Production KV credential —
  including `KV_REST_API_READ_ONLY_TOKEN` — returns the literal placeholder `[SENSITIVE]`
  from the CLI, so the ledger could not be read. `.env.local` points at a local Redis
  (`127.0.0.1:6390`), not Production.
- **Vercel runtime logs** are retained only for the current deployment (~1h at time of
  audit); older Production deployments return empty. In that window the only
  `/api/portal/*` requests were this audit's own probes, alongside cron traffic and one
  `GET /`. That window is far too short to characterize 73 hours.
- **Vercel usage API** reports team-level cost by service with no per-route breakdown.

Consequence: this cannot be answered from OUTSIDE Production, which is why the answer now
lives inside the app as an authenticated admin surface rather than as an external probe.

### Keep-on criteria

1. ~~Owner confirms the 2026-07-26 activation was **intentional**.~~ **SATISFIED
   2026-07-30** — the owner confirmed the activation was intentional.
2. An authenticated admin review of the booking audit ledger shows assignment/clock/
   completion events are well-formed and free of duplicates — the exactly-once property
   PR #132 hardened, observed on real data rather than fixtures.
3. No customer-visible defect attributable to the crew surface (stale crew names on the
   confirmation page, wrong crew on a booking, pay/timeclock discrepancies).
4. Pay statements sourced from bookings reconcile against the timeclock for the activation
   window.

### Rollback criteria

Disable if any of the following holds:

1. The activation was **not** intentional and no crew member has used the surface.
2. Duplicate completion events, duplicate punches, or duplicate pay lines are observed on
   real Production data.
3. Any cross-tenant or cross-crew data exposure is found on the portal surface.
4. Customer-facing booking data is being corrupted by crew-side writes.

### Rollback procedure

Disabling is **not** risk-free and is not the default safe action. With the flag off, the
whole crew surface returns `404`: assigned jobs disappear from `/portal/jobs`, and an
in-progress shift cannot be clocked out from the portal. Any crew member mid-job would be
stranded with an open punch. Sequence:

1. Confirm with the owner, and confirm no crew member is mid-shift (no assignee with
   `clockInAt` set and `clockOutAt` unset).
2. Set `BOOKING_ASSIGNMENT_ENABLED=false` in Production (or remove it — an absent flag
   equals an explicit off, per `FLAG_DEFAULTS`).
3. Redeploy Production, since the flag is read from the function environment.
4. Verify: an unauthenticated `GET /api/portal/jobs/<dummy>` on `www.jkissllc.com` returns
   **`404`**, not `401`.
5. Verify `/api/health` still returns `healthy` and the `build` field matches the new
   deployment.
6. No data is deleted by disabling — assignment records, punches, and completion proof
   persist and reappear if the flag is re-enabled.

### Owner approval

**Any change to `BOOKING_ASSIGNMENT_ENABLED` — enable, disable, or remove — requires
explicit owner approval.** This audit is read-only and changed nothing. Updating this
document does not authorize a flag change.

## Immediate next action

1. ~~Owner: confirm whether the 2026-07-26 Production activation was intentional.~~
   **Done 2026-07-30 — intentional; the flag stays on absent a rollback criterion.**
2. Review Crew Activity (`/admin/operations/crew-activity`) in Production over the
   activation window and record the aggregate counts, so the usage question has a dated
   answer rather than an open one.
3. Read the completion idempotency panel on real Production records: **zero duplicate
   request IDs** is the confirmation that the exactly-once property PR #132 hardened holds
   outside fixtures. Legacy events without request IDs are outside that check and prove
   nothing either way.
4. Run the authenticated Preview mobile interruption/reconnect flow at 320/375/390/430 px
   and inspect audit history for exactly-once events.
5. ~~Resolve or retire the legacy public route-confirmation split.~~ **Decided: retain
   and harden** — see the Sprint 3 section. The connection treatment is applied; the two
   remaining divergences (`hasOtherOpenPunch`, duplicated punch logic) are scoped there
   and each need owner approval because they change live contractor write behaviour.
6. Keep route auto-cancellation unscheduled and flag-off pending tenant fan-out and
   Preview dry reports.
7. Make no `BOOKING_ASSIGNMENT_ENABLED` change without owner approval.
