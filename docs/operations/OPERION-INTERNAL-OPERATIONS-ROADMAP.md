# Operion Internal Operations Completion Roadmap

**Updated:** 2026-07-29
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
- Current PR #128 candidate: **2856/2856 tests passing**; TypeScript passes; ESLint has
  zero errors and one pre-existing warning in untouched `pay-statements.ts`. Exact-SHA
  CI and Preview provenance remain required before merge.
- `BOOKING_ASSIGNMENT_ENABLED` is **false in Production**. The whole Sprint 1 feature set is
  merged and Preview-validated but not yet serving; enabling it is a separate owner decision.

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

**Status:** Complete (code); awaiting Production activation.

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

**Remaining before this sprint is in service:** enable `BOOKING_ASSIGNMENT_ENABLED` in
Production. That is an owner decision and is deliberately not part of the closeout.

**Verification:** assignment and conflict tests; authorization tests; duplicate-action idempotency; real mobile crew flow; mixed route/booking pay statement fixture; Preview data inspection.

**Difficulty:** Medium.

## Sprint 2 — Finish admin operations dashboard

**Objective:** Give dispatch one simple daily view for bookings, routes, crew, equipment, conflicts, and work requiring attention.

**Status:** In progress. PR #128 is open and unmerged; automatic route cancellation
remains inactive.

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
- A protected route auto-cancel endpoint exists for routes that reach their Central-time
  route day with no crew. It is fail-closed on incomplete scans, rechecks full eligibility
  under the route lock, and records one attributed lifecycle event.
- `ROUTE_AUTO_CANCEL_ENABLED` defaults off. No Vercel cron schedules the endpoint, and
  merging PR #128 does not activate automatic cancellation or change Production data.
- Tenancy-enabled execution remains blocked until a complete tenant registry can be
  proven; the job will not sweep one tenant and claim platform-wide success.

**Remaining before Sprint 2 closes:**

- Independent delta review and merge decision for PR #128.
- Issue #129: make dispatch readiness an explicit workflow state instead of only a
  derived signal, then gate dispatch actions consistently.
- Add the owner-facing control for whether a route requires company vehicle/equipment.
- Design and verify complete tenant fan-out before scheduling the cancellation endpoint.
- Run Preview-only dry reports across representative route days before any separate
  activation proposal.

**Verification:** desktop and 320/375/390/430 px layouts; search/filter state; one-click navigation from alerts to records; no hidden conflicts; role checks for owner/admin/manager; empty/loading/error states.

**Difficulty:** Medium-high.

## Sprint 3 — Finish crew mobile workflow

**Objective:** Make the crew portal dependable in a truck or at a job site, including weak-network behavior.

**Affected files/components:**

- `app/portal/*`
- `app/api/portal/*`
- `app/lib/crew-timeclock.ts`
- completion-photo and document upload paths
- client-side pending-action storage/queue

**Dependencies:** Sprint 1 state matrix and Sprint 0 isolated upload transport.

**Verification:** iPhone and Android widths; accept/decline; clock in/out; retry after network interruption; duplicate taps; photo retry; assigned-only authorization; no pricing/internal-note leakage.

**Difficulty:** High — offline and retry behavior affects field reliability.

## Sprint 4 — Complete customer booking and AI quote experience

**Objective:** Make the existing customer pipeline understandable and dependable from photo selection through quote decision and OpsPilot visibility.

**Affected files/components:**

- `app/quote/*`
- `app/api/quote/*`
- `app/lib/estimation/*`
- `app/lib/pricing/*`
- `app/lib/book-now-ai.ts`
- booking detail AI estimate panels and analytics events

**Dependencies:** Stable booking lifecycle from Sprint 1; no pricing-rule changes without explicit approval.

**Verification:** zero/one/six photos; remove/change photos invalidates stale analysis; provider failure saves manual-review booking; quote/range/manual-review outcomes; mobile photo previews; duplicate submission; OpsPilot read-back.

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

## Immediate next action

Finish Sprint 2 safely before opening a broad Sprint 3 implementation:

1. Complete the independent delta review of PR #128 and merge only if its exact head,
   CI, and Preview provenance remain clean.
2. Implement issue #129's explicit dispatch-readiness state and the owner-facing
   vehicle/equipment requirement control.
3. Keep route auto-cancellation unscheduled and flag-off until complete tenant fan-out
   and multiple Preview dry reports are approved.
4. Make the separate owner decision on `BOOKING_ASSIGNMENT_ENABLED`; updating this
   roadmap or merging Sprint 2 work does not authorize Production activation.

Once those Sprint 2 gates are closed, Sprint 3's crew mobile reliability work is the next
construction milestone.
