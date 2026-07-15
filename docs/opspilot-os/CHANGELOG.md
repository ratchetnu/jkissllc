# Operion Enterprise Blueprint — Changelog

This blueprint is a **living document**. It is reconciled against the actual
`~/jkissllc` repository as the platform evolves. Each entry records what changed
in the codebase, which blueprint documents were updated, which roadmap items
closed, which maturity scores moved, and which risks opened or closed.

The directory remains `docs/opspilot-os/` (legacy name, kept for link stability);
the product is **Operion**. See `README.md` for the naming/source-of-truth note.

---

## 2026-07-15 — Vision estimation engine reconciled onto main (shadow, Claude — no OpenAI)

Shipped the deterministic vision-estimation engine onto `main` (now with the tenant-boundary
work the other session merged). Cherry-isolated the engine (tenant-independent) and re-applied
onto current production. **Keeps** Vercel AI Gateway + Claude Sonnet vision, Upstash Redis,
Vercel Blob, existing `priceJob` pricing, HEIC, AI-job lifecycle. **No OpenAI, no Supabase, no
second pipeline, no new secrets.**

- `estimation/*` (10 modules): all photos analyzed together + cross-photo dedup → volume/weight/
  complexity bands → `pricing-explain` transforms the EXISTING `priceJob` breakdown (**model
  never sets a price**). + `photo-quality-gate`, `outcome-capture` (learning loop), additive
  supersets of `flags` (VISION_ESTIMATION_SHADOW), `inventory-taxonomy` version, `job-learning`
  priceMape (tenant comment preserved), `disposal/outcomes` writer, `book-now-ai` shadow hook.
  Admin shadow-display on `/admin/bookings`.
- **Shadow only:** `VISION_ESTIMATION_SHADOW` defaults **off** → byte-identical; when on, runs
  parallel in the durable worker, stashes result for admin comparison, records
  `vision:shadow-comparison`. NEVER authoritative, never shown to customer. Not promoted.
- Gates: tsc 0 · npm test PENDING · next build PENDING. Backward compatible; TENANCY_ENABLED stays false.

## 2026-07-15 — Tenant-safe storage + public/webhook tenant resolution (dark-launch)

Built the multi-tenant boundaries that were the top remaining activation blockers, all
**inert while `TENANCY_ENABLED=false`** (byte-identical behavior today). Branch
`feat/operion-tenant-safe-boundaries`. No tenancy enablement, no UI redesign.

**New canonical primitives (IMPLEMENTED, unit-tested):**
- `app/lib/platform/tenancy/blob-keys.ts` — `scopeBlobPath()` (Blob analogue of `scopeKey`): legacy path when off, `tenants/{tid}/{path}` when on, fail-closed, traversal/name-derived guards.
- `app/lib/platform/tenancy/tenant-resolve.ts` — canonical session-less resolver with a documented trust model: `resolveTenantFromResource` (token routes), `resolveTenantFromHost` (domain map), `resolveTenantFromStripe` (verified metadata), `tenantIdForOutboundMetadata`.

**By blocker:**
- **Blob storage (IMPLEMENTED + LEGACY-COMPATIBLE):** 5 write sites (quote/admin/uniform/careers/payment-proof) route through `scopeBlobPath`; filenames sanitized. Reads/deletes use stored absolute URLs → legacy objects stay readable; **bulk migration MIGRATION-REQUIRED** (plan in `tenant-isolation/08-blob-migration-plan.md`, not executed).
- **Stripe webhook (IMPLEMENTED):** `tenantId` stamped into Checkout metadata at creation; webhook verifies signature → `resolveTenantFromStripe` → `withBackgroundTenant`; fail-closed + alert when unresolved; idempotency/dedup/200-contract preserved.
- **Public token routes (COMPLETE):** all customer-token routes now derive tenant from the resource the token binds to (never a client-supplied id) — `booking/[token]` (base + verify/cancel/confirm-return/confirmation/manual-payment/pay/promo/reschedule/review/stripe-return), `invoice/[token]` (+ stripe-return), `quote/status/[token]`. `booking/stripe-return` derives from the server-fetched Stripe session metadata (same authority as the webhook). `review` GET intentionally skipped (no booking/invoice record to bind to).
- **Dark-launch validation (COMPLETE):** owner click-through on the correct tenant-boundaries Preview (`dpl_7U8amgqh2z`, `fcf0736`); telemetry read from that deployment's runtime logs. **95 requests, zero 4xx/5xx, zero `tenancy:*` events, zero warnings/errors → no dangerous mismatches, no fail-closed, no cross-tenant, byte-identical while off.** Live coverage was the customer read paths + wizard; write/admin/payment boundaries (which dark-launch read-compare can't surface anyway) are covered by the 684-case suite. Full detail + honest scope in `tenant-isolation/09-dark-launch-validation.md`. **No fixes required.**
- **AI audit read (IMPLEMENTED):** `listAiCalls`/`computeAiAnalytics` now filter by tenant when enabled (H-AI-2), inert when off; `ai:cost:{tid}` already isolated; prompts intentionally global.
- **Name-derived keys (PARTIAL + MIGRATION-REQUIRED):** `biz:*`/`learn:*` Redis keys are already tenant-isolated by the chokepoint when enabled; the residual name-derived **value** key `Staff.payByBusiness` is migration-required (stable-id forward helpers added, inert; doc in `tenant-isolation/07-name-derived-key-migration.md`).

**Status legend:** IMPLEMENTED (code + tests, inert off) · LEGACY-COMPATIBLE (old data still works) · PARTIAL (representative set done, rest enumerated) · MIGRATION-REQUIRED (planned, not executed) · DARK-LAUNCHED (Preview validation pending) · NOT-ENABLED (`TENANCY_ENABLED` stays false).

**Gates:** `tsc` 0 · `npm test` **684/684** (+55) · `next build` OK · no new lint in changed files.

## 2026-07-15 — Production release of the hardening sprint 🚀

The Production Hardening sprint (below) was merged to `main` and **deployed to Production**
after Preview click-through approval.

- **Merge:** `fix/operion-production-hardening` (`b7c3809`) → `main` via `--no-ff` release
  merge `ddd7d3c` ("feat(operion): harden authorization, AI recovery, alerts, KPIs, and
  accessibility"); brought the hardening + the Operion blueprint reconciliation + the
  enterprise-readiness audit onto `main` (the single source of truth). No conflicts.
- **Production deployment:** `dpl_7EpbqahqnEsqrk9XYvTP6c1D4Hr4`, commit `ddd7d3c`, `target: production`, state `READY`, build clean (0 errors, 44s). Serves `jkissllc.com` / `www.jkissllc.com`.
- **Verification:** `/api/health` → `{"status":"healthy","build":"dpl_7Epb…"}` (KV reachable, new build live); `/quote` renders 200; no runtime errors attributed to the new deployment. Pre-merge gates: `tsc` 0 · `npm test` **629/629** · `next build` OK.
- **Shipped fixes:** authorization tightening (38 routes), AI stale-job recovery + call timeout, alert Slack→email→console fallback, KPI accuracy (Awaiting-AI parity, Booked-Today via `confirmedAt`+Central), Book Now wizard accessibility.
- **Safety:** `TENANCY_ENABLED` remained `false`; no Production env/secret changed for this release (Production `ADMIN_SESSION_SECRET`/`ADMIN_PASSWORD`/`DOC_ENCRYPTION_KEY` untouched); no customer/payment/job/message data altered.
- **Next:** highest remaining enterprise blocker = tenant-safe Blob storage + public-route/Stripe-webhook tenant resolution (see the audit's §21/§22) — the recommended next sprint once this release is confirmed stable.

## 2026-07-14 — Production Hardening sprint (auth, worker recovery, failure visibility)

Resolved the audit's live-and-near-term HIGH/MEDIUM issues on branch
`fix/operion-production-hardening` (from the audit base `8b36a4d`). Code changed; **no
schema, no auth re-architecture, no tenancy enablement** (`TENANCY_ENABLED` stayed `false`);
not merged, not deployed.

- **Gates:** `tsc` 0 errors · `npm test` **629/629 pass** (was 586; +43 new) · `next build` OK · no new lint errors in changed files.
- **Authorization (H-SEC-1):** all **38** coarse `requireSession` admin routes → `requirePermission`/`requireStaffSession`/`requireAdmin` per a documented route-permission matrix; managers denied admin-only pay/invoices/profitability/settings/promos/waitlist and decrypted applicant docs (`careers/doc`→admin) at the API. Existing per-action `can()` checks preserved. Tests: new `manager-authz.test.ts`, hardened `authorization-coverage.test.ts`.
- **AI recovery (H-AI-1) + timeout (M-AI-3):** lease-based stale-`processing` reaper (`AI_PROCESSING_LEASE_MS`, idempotent under write-lock, attempts preserved, terminal at MAX, never resurrects failed/manual_review); `AbortSignal.timeout` (`AI_CALL_TIMEOUT_MS`) classified transient. Tests: `ai-reaper.test.ts`, `ai-timeout.test.ts`.
- **Failure visibility (M-OBS-1/2, M-MSG-1):** `alert()` added to Stripe-webhook + daily/reminders cron catches; alert **email fallback wired** (Slack→email→console) with truthful `alertProviderStatus()`, env/correlation-id/timestamp in payload, redaction + dedup kept. Test: `alerts-delivery.test.ts`.
- **KPI accuracy (M-ADM-1/2/3):** shared `AWAITING_AI_STAGES` predicate (count == filter), "Booked Today" via `confirmedAt`+`centralToday()`, `refreshing`-vs-`loading` split. Test: `book-now-kpi.test.ts`.
- **Wizard a11y (M-A11Y-1):** `htmlFor`/`id`, `aria-required`, group `aria-labelledby`/`aria-pressed`, upload `aria-live`; strictly additive. Test: `wizard-a11y.test.ts`.
- **Env vars added (names only):** `AI_PROCESSING_LEASE_MS`, `AI_CALL_TIMEOUT_MS`, `ALERT_EMAIL_TO` (optional; falls back to `OWNER_EMAIL`).
- **Still open:** tenant-activation blockers (Blob/`ai:*`/name-keys/public-route + Stripe-webhook tenant context), logger adoption (M-OBS-3), CSP (M-SEC-2), and the remaining MEDIUM/LOW items — deferred to their own sprints.

## 2026-07-14 — Enterprise readiness audit

Ran an evidence-based end-to-end validation of the platform (customer intake → completed
operations) via nine parallel read-only reviewers + the project's own quality gates. Result:
[`audits/2026-07-14-operion-enterprise-readiness.md`](audits/2026-07-14-operion-enterprise-readiness.md).

- **Quality gates (executed):** `tsc` 0 errors · `npm test` **586/586 pass** · `next build` OK.
- **Overall:** **PARTIALLY READY** — production-solid for the single J KISS tenant; NOT READY for multi-tenant activation.
- **No live CRITICAL.** HIGH (7): manager over-privilege on ~31 admin routes (`requireSession` vs `requirePermission`); durable AI job can strand in `processing` (no reaper); global `ai:` audit-read (cross-tenant on activation); un-tenanted Stripe webhook; Blob paths not tenant-scoped; name-derived `bizKey`→payroll collision; global job-learning model.
- **Analytics confirmed real** (computed from live data, not placeholders). **Dark-launch mismatch count = NOT VERIFIED** (BLOCKED — needs a browser against Preview).
- **Recommended next sprint:** *Production Hardening — Auth Tightening, Worker Recovery & Failure Visibility* (no schema / no auth-rearchitecture / no tenancy).
- Audit branch `audit/operion-enterprise-readiness`; documentation-only; no app code, env, deploy, or `TENANCY_ENABLED` change.

## 2026-07-14 — Reconciliation with shipped work (Operion rebrand + S1 tenancy foundation)

**Trigger:** the 2026-07-12 baseline assessment had gone stale in several
material ways after real work shipped to `main`/Production. This pass compared
every blueprint document against current repository evidence and updated the
underlying sections (not just top-notes), applying the Operion branding rules
(product/brand → Operion; internal identifiers preserved as legacy).

### What changed in the codebase (evidence)

| Area | Change | Evidence |
|---|---|---|
| **Brand** | Platform renamed OpsPilot → **Operion** at the product layer | `PLATFORM.name = 'Operion'`; public page `/operion`; `/opspilot` → 301. Internal `opspilot:` Redis prefix, `/api/opspilot/*`, `app/lib/platform/*`, component/env names **unchanged** (legacy compatibility). |
| **Tenant Context Wiring (S1)** | The recommended tenancy foundation **shipped** and is on `main`/prod | `withTenantRoute` establishes per-request tenant context on **104 request handlers**; `withBackgroundTenant` on **3 crons + 3 webhooks**; central `app/lib/platform/tenancy/with-tenant-route.ts` + `activeTenantIds()`. `TENANCY_ENABLED=false` ⇒ **live no-op (byte-identical)**. |
| **Redis chokepoint** | Every key routed through `scopeKey()`, **fails closed** if flag flips without context | `app/lib/redis.ts`; enforced by blocking `scripts/bypass-detection.test.ts`. |
| **Dark-launch Preview** | Isolated Preview data provisioned | separate Upstash Redis `OperionPreview` + Blob `operion-preview-blob`; Preview-only flags `TENANCY_ENABLED=false` + `TENANCY_DARK_LAUNCH=true`. Data-isolated from Production. |
| **CI hardened** | AI-only workflow → **blocking full gate** | `.github/workflows/ai-regression.yml` now runs tsc → full `npm test` → `next build` on Node 24 (`engines` + `.nvmrc`). |
| **Test suite** | **296 → 586** cases across **75** `scripts/*.test.ts` | incl. tenant-isolation, bypass-detection, rbac, authorization-coverage, security-hardening, AI regression, workflow tests. |
| **Book Now admin** | Redesigned into an enterprise dashboard (**UI-only**) | `app/admin/operations/book-now/page.tsx` (231 → 568 lines): KPI row, toolbar, grouped-accordion filters, full-width table, slide-over drawer. All APIs/filters/actions preserved; detail page + 12 PATCH actions untouched. |
| **Admin auth** | Reconciled | `ADMIN_PASSWORD` unified from `.env.local`; too-short Production `ADMIN_SESSION_SECRET` rotated (min-16 check now enforced, `session.ts:67`); doc encryption unaffected (derives from `DOC_ENCRYPTION_KEY`). |

### Blueprint documents updated

- **README.md** — retitled to *Operion — Enterprise Architecture Blueprint*; added naming/source-of-truth note and legacy-directory rationale; corrected the one-paragraph conclusion; added a Status Update section; added table rows for 19/20/21 + this changelog.
- **00-executive-summary.md** — corrected "single-tenant / no tenant model / session carries no tenant" and risk R3 to reflect S1; updated the "next sprint" (tenant-context wiring is DONE → next is dark-launch validation).
- **01-current-state-assessment.md** — added platform foundation, S1 wiring, hardened CI, isolated Preview, Book Now redesign; refreshed inventory.
- **02-repository-map.md** — added `with-tenant-route.ts`, `activeTenantIds`, bypass-detection test; refreshed counts (128 API routes, 101 lib modules, 10 platform modules, 75 test files).
- **03-capability-matrix.md** — "Organizations/tenancy Absent" corrected to context-wiring IMPLEMENTED (data isolation still inactive); Book Now dashboard marked shipped.
- **04-domain-model.md** — noted platform domains scaffolded in `app/lib/platform/*`.
- **05-multi-tenant-architecture.md** — the core doc: documented the S1 model with IMPLEMENTED / DARK-LAUNCH READY / NOT YET VERIFIED / BLOCKED / PROPOSED classification; kept activation blockers.
- **06/07/08** — industry-packs + capabilities registry; runAiTask/AI Gateway/prompt-store/registry + Book Now AI chain + `ai:*` global note; 39 versioned events + outbox scaffolding.
- **09/10/11** — Redis chokepoint enforcement + still-global `ai:*`/`opspilot:*` + Blob-scoping blocker; security register (C2/R3 partially resolved, remaining opens); Book Now design-system example.
- **12/13/14** — dormant structured logger + no APM (honest); test 296→586 + blocking CI; transitional architecture partly realized.
- **15/16** — roadmap: Phase 0 + tenant identity/context marked COMPLETE; **first-sprint doc reframed from "recommended, not yet executed" to DONE (S1)**; new next Stage-0 sprint = dark-launch validation.
- **17/18/19/20/21** — open questions/decisions refreshed; 19 re-verification pass dated 2026-07-14; 20 hardening items closed vs open; 21 still reference-only with Book Now as applied example.

### Roadmap items closed

- ✅ **Tenant Context Wiring** (the blueprint's recommended first sprint) — shipped as S1.
- ✅ **Redis access chokepoint + fail-closed enforcement** + bypass-detection CI gate.
- ✅ **Isolated dark-launch Preview environment** provisioned.
- ✅ **CI hardened** to blocking tsc + full test + build gate.
- ✅ **Min-16-char session-secret enforcement**.

### Maturity movements (evidence-backed, not inflated)

- Multi-tenancy: *Absent* → **context plumbing IMPLEMENTED, data isolation inactive** (still not activated).
- Testing/CI: raised (AI-only → blocking full gate; 296 → 586 cases).
- Book Now admin UX: raised (card wall → enterprise dashboard).
- Unchanged (deliberately not raised): identity (single shared owner password), structured observability (logger still dormant, no external APM), data-level tenant isolation (flag off).

### Risks — closed / partial / still open

- **Partially resolved:** "session carries no tenant" (C2 / R3) — sessions now carry `tid`; 104 handlers establish context.
- **Still open:** single global `ADMIN_SESSION_SECRET` (HMAC); single shared owner `ADMIN_PASSWORD` (no per-owner identity); name-derived Redis key collisions (`businesses.ts` bizKey→payroll, `job-learning.ts`); Blob paths not tenant-scoped; `ai:*` prompts/telemetry platform-global.

### Recommended next implementation sprint

**Stage 0 — Dark-launch validation** (Tenant Context Wiring is already done):
exercise real J KISS workflows against the isolated Preview with
`TENANCY_DARK_LAUNCH=true`, then inspect `tenancy:dark-launch-mismatch` telemetry
for any key that would resolve differently under tenancy. Only after a clean
dark-launch report proceed to **S2**: Blob path scoping, `ai:*` prompt/telemetry
scoping, name-derived key-collision fixes, the tenant data migration
(`DARK_LAUNCH → DUAL_WRITE`), and host-based public-route tenant resolution.

---

## 2026-07-12 — Initial blueprint

Original evidence-based Enterprise Architecture Blueprint (docs 00–21 + diagrams),
cited to `~/jkissllc@main`. See `README.md` and each document's header.
