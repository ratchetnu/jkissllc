# 00 — Executive Summary

> Evidence-based. Cited to `file:line` on `~/jkissllc@main`.
> Baseline recon 2026-07-12; **_(Updated 2026-07-14)_** to reflect the shipped
> Operion platform foundation and S1 tenant-context wiring.
> Facts are code-verified; Assumptions are labeled.
> **Product = Operion** (`PLATFORM.name='Operion'`, `app/lib/company.ts:105`;
> public page `/operion`, legacy `/opspilot`→301). Internal identifiers keep the
> legacy `opspilot` slug for compatibility: this doc folder `docs/opspilot-os/`,
> the `opspilot:` Redis prefix, `/api/opspilot/*` routes, and `OpsPilotMark`-style
> component names are unchanged.

## Executive conclusion

Operion (the platform powering the J KISS LLC application; legacy internal slug
`opspilot`) is a **mature, coherent, single-tenant-in-behavior field-service
operations platform** — richer than its "internal tool" framing suggests. It has
a full sales-to-cash spine (bookings, dynamic pricing, payments, invoices, pay
statements), a complete contractor-dispatch domain (routes, multi-assignee
confirmation, clock-in, pay), a rich ATS with encrypted identity documents, and a
**governed AI subsystem** (versioned prompts, per-tenant cost metering, telemetry,
quality scoring, A/B testing, a pre-deploy regression gate) that is well ahead of
typical products this size.

The gap between what it is and what it needs to become — a **multi-tenant AI
Business Operating System** — has **narrowed materially**. _(Updated 2026-07-14:
the tenancy foundation is no longer just latent scaffolding.)_ A dedicated
platform foundation now exists under `app/lib/platform/*` (tenancy, capabilities,
workspaces, industry-packs, AI-workers, events, approvals, intelligence,
observability), and **S1 Tenant Context Wiring has SHIPPED**: `withTenantRoute`
establishes a per-request tenant context on **104 request handlers**, plus **3
crons + 3 webhooks** run under explicit per-tenant context
(`withBackgroundTenant`). Sessions now carry a `tid` claim. The Redis chokepoint
(`app/lib/redis.ts` → `scopeKey()`) **fails closed** when the tenancy flag is on
without a context, guarded by a **blocking** `scripts/bypass-detection.test.ts` CI
gate. Because `TENANCY_ENABLED=false`, all of this is a **live no-op
(byte-identical to prior behavior)** — the system is still single-tenant IN
BEHAVIOR, but the context plumbing and fail-closed chokepoint now **EXIST**.

What remains for true multi-tenancy is **data-level isolation and identity**, not
plumbing: Blob paths are still global, `ai:*` prompts/telemetry are still
platform-global (shared), some keys are name-derived (`businesses.ts` bizKey →
payroll, `job-learning.ts`), the tenant data migration has not run, and there is
still a **single shared owner identity** (one `ADMIN_PASSWORD`, one global
`ADMIN_SESSION_SECRET`). The two hardest things to retrofit — data isolation and
authorization — each still funnel through a **single chokepoint**
(`app/lib/redis.ts` `call()`/`scopeKey()`, and the session guards in
`app/api/admin/_lib/session.ts`), which is exactly what has made the migration a
sequence of mechanical steps rather than a rewrite.

**Recommendation: proceed, in the documented phase order, on the current stack.**
Do not swap Redis for Postgres to "get multi-tenancy" — isolation via key prefix
plus an `AsyncLocalStorage` tenant context is the right first move and preserves
production continuity. Reserve a relational store for the places that genuinely
need it later (billing ledger, cross-tenant analytics).

## Current architecture classification

**Single-company, single-tenant-in-behavior — with an ACTIVE (context-wired)
multi-tenant foundation, dark-launch ready but not data-active.**
_(Updated 2026-07-14.)_ (Detail: `05-multi-tenant-architecture.md`.)

- It is now more than "latent scaffolding": every request carries a tenant
  context. `withTenantRoute` (`app/lib/platform/tenancy/with-tenant-route.ts`)
  wraps **104 handlers**; sessions carry a `tid` claim; the Redis key chokepoint
  resolves the active tenant via `scopeKey()` and **fails closed** if the flag is
  on without a context. `activeTenantIds()`
  (`app/lib/platform/tenancy/tenant-store.ts`) enumerates known tenants.
- Still single-tenant IN BEHAVIOR: `TENANCY_ENABLED=false` makes the wiring a
  byte-identical no-op that resolves to the single reference tenant `t:jkiss`,
  and no record is yet org-scoped at the data level. Legacy `tenantId()`
  (`app/lib/tenant.ts`) still derives a string for AI telemetry; it is now
  complemented by the platform tenancy module, not the sole mechanism.
- Remaining foundation-to-active gap: an **isolated dark-launch Preview**
  (separate Upstash `OperionPreview` + `operion-preview-blob`, Preview-only
  `TENANCY_DARK_LAUNCH=true`) exists but its **telemetry has not yet been
  exercised** — status = DARK-LAUNCH READY, NOT YET VERIFIED.
- The sister deployment (`~/supercharged`, out of scope for this engagement) is a
  hand-forked reskin, which confirms the *shipped* productization model is still
  **fork-and-reskin**; runtime tenancy is wired but not yet activated.

## Top 10 findings (facts)

1. **Data layer is Redis, not SQL.** Upstash Redis via a thin REST wrapper
   (`app/lib/redis.ts`) + Vercel Blob for files. Every entity = one JSON blob at
   `prefix:{id}` plus a sorted-set index. No SCAN/KEYS exposed
   (`app/lib/redis.ts:36-77`). This shapes the entire migration.
2. **Isolation has a single chokepoint, now enforced.** Every key routes through
   `scopeKey()` inside `app/lib/redis.ts`. _(Updated 2026-07-14: the two former
   inline-fetch bypasses have been folded in, and a **blocking**
   `scripts/bypass-detection.test.ts` CI gate now fails the build if any module
   reaches Redis outside the chokepoint.)_ The chokepoint **fails closed** when
   `TENANCY_ENABLED` is on without a resolved context.
3. **Authorization is multi-user, not multi-org.** RBAC is live — signed token
   carries `{sub, role, staffId}`, 3 roles, ~60 permissions
   (`app/lib/rbac.ts`), routes gated. _(Updated 2026-07-14: the session now also
   carries a `tid` tenant claim, so it is no longer tenant-blind; but there is
   still a single shared owner identity, and)_ the RBAC matrix is only
   **partially enforced**: ~65 admin routes use the
   coarse `requireSession` (admin-or-manager) and ~20 declared permissions
   (`equipment:assign`, `businesses:manage`, `routes:manage`, `crew:assign`,
   `applicants:*`, `reports:view`…) are **never checked**.
4. **The AI layer is a real asset, not a liability.** `runAiTask`
   (`app/lib/ai/service.ts:71`) is a governed pipeline: RBAC → budget → versioned
   prompt → model routing → retries → cost reconciliation → schema validation →
   quality score → full telemetry. All 5 AI features are **read-only or
   draft-only** by typed invariant (`writes:false`, `app/lib/ai/registry.ts`).
5. **All four roadmap §1 pre-existing defects are FIXED** (duplicate `JK-INV`
   counters → now `JK-RI-`; `Date.now()%100000` fallback removed; password
   compare now constant-time `secretsMatch`; applicant PII AES-256-GCM sealed).
   Verified in `10-security-risk-register.md`. Residual: pre-fix blob docs and
   quote photos remain plaintext-public.
6. **No first-class Customer, Quote, Change-Order, or Expense entity.** Customers
   exist only as denormalized fields on bookings
   (`app/lib/bookings.ts:181-184`); quotes are ephemeral (compute + ops email,
   never persisted); change orders and expenses do not exist.
7. **Two money domains never reconcile.** Retail **bookings** (`bk:*`, `JK-INV`)
   and contract **routes** (`JK-R`, `rt:inv:*`/`JK-RI`) are parallel worlds;
   `computeFinance()` (`app/lib/finance.ts`) reports route P&L only — booking
   revenue is invisible to it.
8. **No general observability.** No Sentry/APM/structured logging (grep: zero).
   `console.error` + fail-soft only. The one exception is the **custom AI
   telemetry** substrate — domain-specific, not app-wide.
9. **The design system is a status+format module, not a component library.**
   `app/admin/operations/ui.tsx` exports 6 small components; there is **no
   Button/Card/Modal/Input/Table**, so those are re-implemented ad hoc — yielding
   a half-inline-style / half-Tailwind split, 3 separate route-status
   vocabularies, and unstable core nouns (route/operation/assignment/job;
   crew/staff/employee/contractor; business/client/customer).
10. **CI is now a blocking verify gate.** _(Updated 2026-07-14.)_
    `.github/workflows/ai-regression.yml` runs **tsc → full `npm test`
    (586 cases across 75 files — tenant-isolation, bypass-detection, rbac,
    authorization-coverage, security-hardening, AI regression) → `next build`** on
    Node 24 (pinned via `engines` + `.nvmrc`), **blocking on push/PR** (test count
    grew 220 → 586). Vercel still auto-deploys `main`, so the gate protects `main`
    via required-check branch protection rather than the deploy step itself.
    A **real feature-flag layer now exists** (`app/lib/platform/flags.ts`:
    `TENANCY_ENABLED`, `TENANCY_DARK_LAUNCH`, `CAPABILITY_REGISTRY_ENABLED=true`,
    etc.) — all flags OFF except the inert capability registry.

## Top 10 risks

| # | Risk | Sev | Blocks commercialization? |
|---|---|---|---|
| R1 | **Tenant isolation wired but not data-active** — key chokepoint + `withTenantRoute` on 104 handlers + fail-closed `scopeKey()` shipped, but `TENANCY_ENABLED=false` and Blob paths / `ai:*` remain global; activating a second tenant is still blocked until data scoping + migration land _(Updated 2026-07-14: was "no tenant isolation")_ | Critical | **Yes (until activated)** |
| R2 | **Name-derived keys collide across tenants** — `biz:{name}`, `promo:{code}`, `ship:{bol}`, `msg:phone:{e164}`, and global `learn:*` pricing calibration cross-train/leak (unchanged; a named S2 blocker) | Critical | **Yes** |
| R3 | **PARTIALLY RESOLVED — session now carries a `tid`, but owner identity/secret are still shared** — 104 handlers establish tenant context and sessions carry a `tid` claim, yet a single shared `ADMIN_PASSWORD` (no per-user owner identity) and a single global `ADMIN_SESSION_SECRET` HMAC key remain _(Updated 2026-07-14)_ | High | **Partially** |
| R4 | **Stripe key is shared with ClaimGuard and is 100% customer-facing** — adding SaaS billing on the same key commingles platform and tenant revenue; Connect is effectively mandatory | High | **Yes** |
| R5 | **RBAC enforcement drift** — ~20 permissions declared but never checked; managers reach reports/disposal/claims the matrix doesn't grant | High | Partially |
| R6 | **Audit attribution gap** — most operational mutations log actor as the literal `'admin'` (`app/lib/routes.ts:301`), not which named user | High | Partially |
| R7 | **Webhooks & cron fail OPEN if their secret env is unset** (Twilio/email/cron) | Medium | No (config-gated) |
| R8 | **Reminder ack bearer token uses `Math.random`** (`app/lib/reminders.ts:147`), a public login-less capability | Medium | No |
| R9 | **No PII redaction or prompt-injection defense** before model calls; free-text drafts forward untrusted review/message text into prompts | Medium | Partially |
| R10 | **No data retention / export / erasure** workflow; PII (SSN-card images, GPS, W-9) has no TTL — a GDPR/CCPA and enterprise-procurement blocker | Medium | **Yes (eventually)** |

## Recommended target architecture (one line)

**Modular monolith on Next.js 16 + Redis, with a request-scoped
`AsyncLocalStorage` tenant context, key-prefix data isolation, a tenant-aware
authorization principal, a durable outbox for business events, and a relational
store introduced only for billing and cross-tenant analytics.** Full detail and
diagrams: `14-target-architecture.md`.

## First implementation sprint — SHIPPED as S1 _(Updated 2026-07-14)_

**DONE.** The recommended "foundational, not flashy" first sprint has shipped as
**S1 Tenant Context Wiring**: an `AsyncLocalStorage` tenant context threaded
through `withTenantRoute` on **104 handlers** (+ 3 crons + 3 webhooks via
`withBackgroundTenant`), Redis keys routed through `scopeKey()` behind the
dark-launched `TENANCY_ENABLED` flag with `t:jkiss` seeded byte-identical to
today, a fail-closed chokepoint, and a blocking `bypass-detection` CI gate.
Nothing user-visible changed. Detail: `16-first-sprint-plan.md`.

**Next Stage-0 sprint = validate the dark-launch preview** (exercise real
workflows on the isolated `OperionPreview` Preview environment, then inspect the
`tenancy:dark-launch-mismatch` telemetry) — status today is DARK-LAUNCH READY,
NOT YET VERIFIED. After validation: S2 (Blob path scoping, `ai:*` scoping,
name-derived-key fixes, tenant data migration under DARK_LAUNCH→DUAL_WRITE,
host-based public-route resolution). Still-open identity work: per-user owner
identity to replace the single shared `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET`.

## Items requiring owner decisions

See `18-architecture-decisions-needed.md`. The critical five:
1. **Tenant routing model** — subdomain (`acme.operion.app`) vs custom domain vs both.
2. **Stripe Connect model** — Standard vs Express vs Custom (affects onboarding UX and liability).
3. **When (if ever) to introduce Postgres** — Redis-only vs hybrid for billing/analytics.
4. **Data-residency & retention policy** — needed before selling to enterprise buyers.
5. **Industry-pack sequencing** — which vertical after box-truck hauling (moving? cleaning? trades?).

## Confirmation

**No production schema migrations, data mutations, or destructive changes were
performed.** This engagement was read-only reconnaissance plus documentation
authored under `docs/opspilot-os/`. The working tree's only change is the
addition of these documents.

## The exact next prompt — S1 is DONE; next is dark-launch validation

_(Updated 2026-07-14: the original "begin first sprint" prompt has been executed —
`TENANCY_ENABLED` flag, tenant context on 104 handlers, `scopeKey()` chokepoint,
and `t:jkiss` byte-identical seed all shipped to `main`/prod. Do not re-run it.)_
The next action is to **validate the dark-launch preview**, not to build more
plumbing:

> "Validate the Operion tenancy dark-launch. On the isolated Preview environment
> (`OperionPreview` Redis + `operion-preview-blob`, `TENANCY_DARK_LAUNCH=true`),
> walk the production-critical workflows — book → pay, crew confirm/clock, admin
> mutations, cron sweep — then inspect the `tenancy:dark-launch-mismatch`
> telemetry for any divergence between shadow tenant-scoped keys and today's
> global keys. Report mismatches. Do NOT set `TENANCY_ENABLED=true` in Production
> and do NOT run the data migration yet."
