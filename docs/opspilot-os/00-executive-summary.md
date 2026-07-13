# 00 — Executive Summary

> Evidence-based. Cited to `file:line` on `~/jkissllc@main`, 2026-07-12.
> Facts are code-verified; Assumptions are labeled.

## Executive conclusion

OpsPilot (the J KISS LLC application) is a **mature, coherent, single-tenant
field-service operations platform** — richer than its "internal tool" framing
suggests. It has a full sales-to-cash spine (bookings, dynamic pricing, payments,
invoices, pay statements), a complete contractor-dispatch domain (routes,
multi-assignee confirmation, clock-in, pay), a rich ATS with encrypted identity
documents, and a **governed AI subsystem** (versioned prompts, per-tenant cost
metering, telemetry, quality scoring, A/B testing, a pre-deploy regression gate)
that is well ahead of typical products this size.

The gap between what it is and what it needs to become — a **multi-tenant AI
Business Operating System** — is **narrow in leverage but wide in surface area**.
There is no tenant model, no organization boundary on any record, and every one
of ~34 Redis key namespaces is global. But the two hardest things to retrofit —
data isolation and authorization — each already funnel through a **single
chokepoint** (`app/lib/redis.ts` `call()`, and `getPrincipal()` in
`app/api/admin/_lib/session.ts`), which is exactly what makes this migration a
sequence of mechanical steps rather than a rewrite.

**Recommendation: proceed, in the documented phase order, on the current stack.**
Do not swap Redis for Postgres to "get multi-tenancy" — isolation via key prefix
plus an `AsyncLocalStorage` tenant context is the right first move and preserves
production continuity. Reserve a relational store for the places that genuinely
need it later (billing ledger, cross-tenant analytics).

## Current architecture classification

**Single-company, single-tenant-per-deployment — with latent multi-tenant
scaffolding.** (Detail: `05-multi-tenant-architecture.md`.)

- Not "loosely multi-company" and not "partially multi-tenant": there is no
  tenant/org record anywhere, and no request carries a tenant identity
  (`app/lib/tenant.ts:8-12` derives a string only to stamp AI telemetry).
- The scaffolding that exists: a centralized identity object
  (`app/lib/company.ts`), a `TENANT_ID` env primitive (`app/lib/tenant.ts`),
  per-tenant-keyed AI cost metering (`app/lib/ai/budget.ts:11`), and explicit
  in-code TODOs at the isolation chokepoint (`app/lib/redis.ts:4-12`).
- The sister deployment (`~/supercharged`, out of scope for this engagement) is a
  hand-forked reskin, which confirms the current productization model is
  **fork-and-reskin**, not runtime tenancy.

## Top 10 findings (facts)

1. **Data layer is Redis, not SQL.** Upstash Redis via a thin REST wrapper
   (`app/lib/redis.ts`) + Vercel Blob for files. Every entity = one JSON blob at
   `prefix:{id}` plus a sorted-set index. No SCAN/KEYS exposed
   (`app/lib/redis.ts:36-77`). This shapes the entire migration.
2. **Isolation has a single chokepoint.** Prefixing keys inside `call()` covers
   all 21 lib modules that import the client — but **two files bypass it** with
   their own inline fetch (`app/api/track/route.ts`,
   `app/api/admin/analytics/route.ts`) and must be hand-migrated.
3. **Authorization is multi-user, not multi-org.** RBAC is live — signed token
   carries `{sub, role, staffId}`, 3 roles, ~50 permissions
   (`app/lib/rbac.ts`), 36+ routes gated. But the session has **no `tenantId`**,
   and the RBAC matrix is only **partially enforced**: ~65 admin routes use the
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
10. **CI does not gate deploys.** One GitHub workflow (`ai-regression.yml`) runs
    typecheck + AI tests on push/PR but is advisory; `predeploy`
    (`package.json:14`) is a local guard. Vercel auto-deploys on push to `main`
    independent of CI status. No feature-flag system exists (gating is ad hoc).

## Top 10 risks

| # | Risk | Sev | Blocks commercialization? |
|---|---|---|---|
| R1 | **No tenant isolation** — all Redis keys global; a second tenant on shared infra = cross-tenant data access | Critical | **Yes** |
| R2 | **Name-derived keys collide across tenants** — `biz:{name}`, `promo:{code}`, `ship:{bol}`, `msg:phone:{e164}`, and global `learn:*` pricing calibration cross-train/leak | Critical | **Yes** |
| R3 | **Session carries no tenant; cookie + HMAC secret are global** — a token minted for tenant A is byte-identical to tenant B's on a shared domain | Critical | **Yes** |
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

## Recommended first implementation sprint (one line)

**Foundational, not flashy:** land the `Tenant` + `User` seed with a
tenant-aware `Principal`, thread an `AsyncLocalStorage` tenant context, and
prefix Redis inside `call()` behind a dark-launched flag with `t:jkiss` seeded
byte-identical to today — plus close the RBAC enforcement drift and the two
fail-open webhook/cron gates. Nothing user-visible changes. Detail:
`16-first-sprint-plan.md`.

## Items requiring owner decisions

See `18-architecture-decisions-needed.md`. The critical five:
1. **Tenant routing model** — subdomain (`acme.opspilot.app`) vs custom domain vs both.
2. **Stripe Connect model** — Standard vs Express vs Custom (affects onboarding UX and liability).
3. **When (if ever) to introduce Postgres** — Redis-only vs hybrid for billing/analytics.
4. **Data-residency & retention policy** — needed before selling to enterprise buyers.
5. **Industry-pack sequencing** — which vertical after box-truck hauling (moving? cleaning? trades?).

## Confirmation

**No production schema migrations, data mutations, or destructive changes were
performed.** This engagement was read-only reconnaissance plus documentation
authored under `docs/opspilot-os/`. The working tree's only change is the
addition of these documents.

## The exact next prompt to begin the approved first sprint

> "Approved. Begin OpsPilot First Sprint **Phase 0 + Phase 1a** per
> `docs/opspilot-os/16-first-sprint-plan.md`, on a new branch `opspilot/tenancy-foundation`,
> jkissllc only. Scope: (1) add `docs/adr/` with the first 3 ADRs; (2) introduce
> `Tenant` and `User` seed types + a `getTenant()`/`requireTenantSession()`
> returning a `{tenantId, userId, role}` principal, with `t:jkiss` seeded
> byte-identical to today and a dark `TENANCY_ENABLED` flag defaulting off; (3) do
> NOT prefix Redis writes yet and do NOT change the DB. Add tests for the new
> principal and tenant seed. Typecheck + full test suite must stay green. Show me
> the diff before committing; do not deploy."
