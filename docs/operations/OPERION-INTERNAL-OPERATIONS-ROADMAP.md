# Operion Internal Operations Completion Roadmap

**Updated:** 2026-07-26
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
- Full suite: **2195/2195 passing**. AI regression: **2/2 passing**. TypeScript, ESLint on
  changed files, and the production build pass (170/170 pages).
- `BOOKING_ASSIGNMENT_ENABLED` is **enabled in Production** (2026-07-26) and verified reading
  ON in the running app via Release Center → System Details → Feature controls. Sprint 1 is
  serving. Rollback is removing the Production env var and redeploying.
- Closure reversal: a closed booking can be recovered through an explicit, audited `reopen`
  action with its own UI control, so a mis-clicked Mark complete / Cancel is not permanent.

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

**In service since 2026-07-26.** The flag is enabled in Production and was verified on a real
booking: the Lead/Helper assignment controls render, and the reopen control appears on a closed
record. Production currently holds very little booking data, so the feature is live but has not
yet been exercised by a real job end to end — the next confirmed booking is the true test.

**Verification:** assignment and conflict tests; authorization tests; duplicate-action idempotency; real mobile crew flow; mixed route/booking pay statement fixture; Preview data inspection.

**Difficulty:** Medium.

## Sprint 2 — Finish admin operations dashboard

**Objective:** Give dispatch one simple daily view for bookings, routes, crew, equipment, conflicts, and work requiring attention.

**Affected files/components:**

- `app/admin/operations/page.tsx`
- `app/admin/operations/schedule/page.tsx`
- `app/admin/operations/book-now/*`
- `app/components/admin/OperationsShell.tsx`
- `app/lib/schedule/*`
- admin schedule, booking, staff, and equipment APIs

**Dependencies:** Sprint 1 lifecycle and assignment source of truth.

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

Sprint 1 is code-complete. The two previously listed actions are done: the pay-snapshot
connection shipped, and Supercharged's Preview Redis was separated in Sprint 0 (recorded in
the baseline above).

Activation is done: Sprint 1 is enabled and verified in Production.

The open question is now **usage, not construction**. Production holds one completed booking
and two unprocessed requests, so the operational surfaces built so far have almost no live data
flowing through them. Sprint 2 (dispatch dashboard) is a view over bookings, routes, crew and
conflicts — with the current data it would render largely empty.

Recommended: run real work through Sprint 1 first and let the gaps surface, rather than
building Sprint 2 ahead of demand. That is the same judgement applied to the Operion release
control plane, which is complete and deliberately dormant.
