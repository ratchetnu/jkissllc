# 02 — Repository Map (Phase 1)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12.

## Top-level layout (FACT)

```
~/jkissllc/
├── proxy.ts                 # Next 16 middleware: apex→www, RBAC edge gate, sliding session
├── next.config.ts           # near-empty; withBotId() wrapper
├── vercel.json              # cron defs only (daily, reminders)
├── package.json             # scripts: dev/build/lint/test:*/predeploy
├── .github/workflows/
│   └── ai-regression.yml     # the only CI workflow (advisory)
├── app/
│   ├── layout.tsx            # fonts, <Analytics/>, BotID PROTECTED_ROUTES
│   ├── globals.css           # design tokens (:root), .btn/.os-card/.glass-card, OS token layer
│   ├── lib/                  # ~60 domain + infra modules (the real backend)
│   │   └── ai/               # governed AI subsystem (11 modules)
│   ├── api/                  # route handlers (REST-ish)
│   │   ├── admin/            # operator API (guarded)
│   │   ├── portal/           # crew API (requireCrew)
│   │   ├── webhooks/         # stripe, twilio/sms, email
│   │   ├── cron/             # daily, reminders
│   │   └── (public)/         # book, quote, estimate, availability, ack, upload, ...
│   ├── admin/                # operator UI
│   │   └── operations/       # the "OpsPilot OS" shell + modules
│   ├── portal/               # crew UI (7-tab shell)
│   ├── booking/[token]/      # customer booking portal
│   ├── client/[token]/       # B2B client portal
│   ├── route/[token]/        # contractor route-confirm page
│   ├── quote/                # 969-line customer quote wizard
│   └── (marketing pages)/    # home, cities, careers, start-your-carrier, ...
├── scripts/                  # *.test.ts (23 files) + utilities
└── docs/
    ├── opspilot-multi-tenant-roadmap.md   # prior (stale) roadmap
    ├── opspilot-future-improvements.md
    └── opspilot-os/          # THIS blueprint
```

## Major backend modules (`app/lib/`) by domain (FACT)

**Sales & money**
- `bookings.ts` — richest module; Booking aggregate, 17 statuses, payments[],
  audit, notification ledger, `nextInvoiceNumber()` (`JK-INV`), `customerView()`
- `services.ts` — service catalog (icons are compile-time imports)
- `disposal.ts` — dynamic pricing engine (truck-fill → loads → margin gross-up)
- `job-learning.ts` — EWMA price calibration (`learn:jobs`, `learn:calibration`) **global**
- `promo.ts` — promo codes (`promo:{code}`)
- `stripe.ts` — Stripe client + fee gross-up; **shared key w/ ClaimGuard** (`:3`)
- `payments.ts` — provider registry (stripe/zelle)
- `payment-proof.ts`, `record-payment.ts` — Zelle sealed proof, idempotent recording
- `route-invoices.ts` — contract-client invoices (`JK-RI`), lifecycle object
- `finance.ts` — route P&L (`computeFinance`), pay resolution/snapshot
- `pay-statements.ts` — immutable statements (`JK-PS`), void/re-issue
- `pay-corrections.ts`, `route-pay.ts`, `route-reprice.ts`, `route-stats.ts`
- `tax-readiness.ts` — 1099 readiness assessment (no form generation)

**Operations & dispatch**
- `routes.ts` — RouteRecord aggregate; multi-assignee, confirm tokens, clock GPS,
  `CONFIRM_DISCLAIMER`, `pushAudit` (actor = coarse `'admin'`)
- `route-templates.ts`, `route-mutex.ts`, `route-notify.ts`
- `availability.ts` — public booking calendar (blackout/capacity/deposit)
- `client-portal.ts` — B2B client portal projections (heavily scrubbed)
- `businesses.ts` — contract clients; **`bizKey` name-derived** (collision risk)
- `equipment.ts` — equipment roster

**Workforce**
- `staff.ts` — Staff roster, `payByBusiness` map keyed by `bizKey`, W-9 (last4 only)
- `users.ts` — login identity (distinct from Staff), linked via `staffId`
- `crew-availability.ts`, `timeoff.ts`, `uniform.ts`
- `applicants.ts`, `ats-config.ts`, `ats-scoring.ts` — ATS
- `crew-comp.ts`, `crew-notify.ts`

**Comms**
- `messages.ts` — unified message store (inbound SMS, dedup, opt-out)
- `reminders.ts`, `reminder-engine.ts`, `reminder-templates.ts`, `reminder-segments.ts`
- `notify.ts`, `owner-alerts.ts`, `sms.ts`, `booking-emails.ts`

**Claims (ClaimGuard coupling)**
- `claims.ts`, `claim-mutex.ts`, `claims-report.ts` — damage claims → crew
  responsibility → payroll deduction (feeds `route-pay.ts`)

**Governance & infra**
- `rbac.ts` — roles + permission matrix
- `audit.ts` — central attributed audit (narrow coverage)
- `doc-crypto.ts` — AES-256-GCM identity-doc sealing
- `rate-limit.ts` — per-IP fixed-window (fail-open)
- `redis.ts` — the isolation chokepoint
- `tenant.ts`, `company.ts` — identity/tenancy scaffolding
- `analytics.ts`, `automation-settings.ts`, `policy.ts`, `botcheck.ts`, `password.ts`, `notify.ts`

**AI (`app/lib/ai/`)**
- `service.ts` (`runAiTask`), `ai.ts` (Gateway wrapper), `prompts.ts` +
  `prompt-store.ts` (versioned registry), `telemetry.ts`, `budget.ts`,
  `analytics.ts`, `quality.ts`, `eval.ts`, `registry.ts`, `routing.ts`, `schema.ts`

## Authentication / authorization boundaries (FACT)

1. **Edge** — `proxy.ts:34-46`: decodes signed token, blocks crew from
   `/admin` + `/api/admin`; slides idle window (`:52-59`).
2. **API guards** — `app/api/admin/_lib/session.ts:207-235`
   (`requirePermission`/`requireAdmin`/`requireStaffSession`/`requirePrincipal`).
   Every admin route calls one **except** `auth` + `logout` (correctly).
3. **Crew chokepoint** — `app/api/portal/_lib/crew.ts:8-15` (`requireCrew`),
   scopes to `who.staffId`, never trusts body ids.
4. **Public bearer tokens** — booking/route/invoice/portal/claim tokens are the
   sole capability for their login-less endpoints (CSPRNG, 256-bit).

## Notification / job-processing logic (FACT)

- **Outbound:** `notify.ts` (customer), `crew-notify.ts` (crew fan-out —
  `push` channel degrades to in-app), `owner-alerts.ts`, `route-notify.ts`.
- **Scheduled:** `app/api/cron/daily/route.ts`, `app/api/cron/reminders/route.ts`
  — both SMS-suppressed. Reminder engine in `reminders.ts`/`reminder-engine.ts`.

## Billing logic (FACT)

- **Only customer-facing.** Stripe = 6 call sites (3 Checkout, 2 retrieve, 1
  refund). Fee gross-up in `stripe.ts:39-43`. **No** subscriptions/plans/seats.

## AI logic (FACT)

- Single entry `runAiTask` (`app/lib/ai/service.ts:71`); 5 invocation sites
  (command palette, message draft, insights, review-reply, photo-estimate), all
  `writes:false` (`registry.ts`). See `07-ai-operating-layer.md`.

## High-risk coupling (FACT)

1. **Shared Stripe key** across J KISS + ClaimGuard (`stripe.ts:3`) — money-path coupling.
2. **Claim deductions flow into contractor pay** (`route-pay.ts` ← `claims.ts`).
3. **`bizKey` name-derivation** propagates into `Staff.payByBusiness` map keys
   (`businesses.ts:41`, `staff.ts:36`) — a data-shape coupling that blocks
   naive tenant-prefixing.
4. **Global pricing calibration** (`job-learning.ts:41-42`) — cross-tenant
   training risk.
5. **Two analytics/pageview paths bypass the redis wrapper** with inline fetch
   (`app/api/track/route.ts`, `app/api/admin/analytics/route.ts`) — will be
   missed by chokepoint prefixing.

## Dead / duplicate / to-refactor code (FACT)

- **Dead:** legacy `aiText()` (`app/lib/ai.ts:84-107`) — no callers.
- **Duplicate:** two invoice-number systems (now disambiguated by prefix but
  still independent counters); three route-status vocabularies
  (`app/admin/operations/ui.tsx` vs `app/portal/ui.ts` vs `app/client/[token]`);
  `Empty` component redefined per page; `OperationsShell.tsx:25-28` redefines an
  input style instead of importing the shared `osField`.
- **Empty shells:** top-level `app/admin/finance/` and `app/admin/pay-statements/`
  dirs are empty; the live pages are the `operations/*` variants (ASSUMPTION,
  inferred from dir listing).

## Likely production-critical paths (FACT — protect in every migration step)

1. `app/api/book/route.ts` → `bookings.ts` → payment (`/api/booking/[token]/pay`)
   → Stripe webhook → `record-payment.ts` (**revenue in**).
2. `app/api/route/[token]/route.ts` (crew confirm/clock) → `routes.ts` mutex
   (**dispatch integrity**).
3. `proxy.ts` + `session.ts` (**auth for the entire admin surface**).
4. `app/api/cron/daily/route.ts` (**reminders, route generation, claim accrual**).
5. `app/api/webhooks/stripe/route.ts` (**payment reconciliation**).
