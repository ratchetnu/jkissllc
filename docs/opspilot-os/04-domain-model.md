# 04 — Domain Model (Phase 3)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12. Current domains are
> **FACT**; the target model is **RECOMMENDATION**.

## 1. Current domains (as built)

The code already clusters into recognizable domains, but with **improper
coupling** at four seams (below). Current bounded contexts:

| Domain | Modules | Redis namespace |
|---|---|---|
| Sales/Booking | `bookings.ts`, `services.ts`, `promo.ts` | `bk:*`, `promo:*` |
| Pricing | `disposal.ts`, `job-learning.ts` | `cfg:disposal`, `learn:*` |
| Dispatch/Routes | `routes.ts`, `route-templates.ts`, `route-mutex.ts` | `rt:*`, `rt:tpl:*` |
| Scheduling | `availability.ts` | `cfg:blackout/capacity/deposit` |
| Accounts (B2B) | `businesses.ts`, `client-portal.ts` | `biz:*`, `rt:client:*` |
| Workforce | `staff.ts`, `users.ts`, `crew-availability.ts`, `timeoff.ts`, `uniform.ts` | `staff:*`, `user:*`, `crewavail:*`, `timeoff:*`, `uniform:*` |
| Hiring/ATS | `applicants.ts`, `ats-*.ts` | `app:*` |
| Compensation | `finance.ts`, `route-pay.ts`, `pay-statements.ts`, `pay-corrections.ts` | `paystmt:*`, `settings:finance` |
| Invoicing | `route-invoices.ts` (+ booking invoice fields) | `rt:inv:*`, `bk:invcounter` |
| Payments | `stripe.ts`, `payments.ts`, `payment-proof.ts`, `record-payment.ts` | embedded in booking/invoice |
| Claims | `claims.ts`, `claim-mutex.ts`, `claims-report.ts` | `clm:*` |
| Equipment | `equipment.ts` | `equipment:*` |
| Comms | `messages.ts`, `reminders.ts`, `notify.ts`, `sms.ts`, `booking-emails.ts` | `msg:*`, `rem:*`, `sms:optout:*` |
| Governance | `rbac.ts`, `audit.ts`, `doc-crypto.ts`, `rate-limit.ts` | `audit:*`, `rl:*` |
| Identity/Config | `tenant.ts`, `company.ts`, `policy.ts` | `policy:*` |
| AI | `ai/*` | `ai:*` |

## 2. Improper coupling (the four seams to break) — FACT

1. **Pricing ↔ tenancy (global learning).** `job-learning.ts:41-42` keeps
   calibration in global `learn:*` keys. Under multi-tenant this cross-trains
   pricing between companies. Must become tenant-scoped.
2. **Accounts ↔ Workforce (name-keyed pay).** `businesses.ts:41` derives
   `bizKey` from the business name; `staff.ts:36` uses `bizKey` as a **map key**
   inside `payByBusiness`. So the account identity leaks into the payroll data
   shape — prefixing the Redis key alone does not fix the embedded map keys.
3. **Claims ↔ Compensation (product coupling).** `route-pay.ts` imports claim
   recovery to deduct from contractor pay — a live coupling between ClaimGuard
   and OpsPilot payroll. Keep, but make the boundary explicit and event-driven.
4. **Payments ↔ ClaimGuard (shared Stripe key).** `stripe.ts:3` — one Stripe
   account for two products. Blocks SaaS billing; forces Stripe Connect.

Plus a structural gap: **retail Bookings and contract Routes are two money
domains that never reconcile** — a consolidated ledger is a target requirement.

## 3. Target domain model (RECOMMENDATION)

Organized as **Platform Core** (industry-neutral) vs **Industry-flavored**
domains. Each domain lists Purpose · Entities · Key relationships · Events
produced · Permissions · Tenant-isolation. (Events cross-reference
`08-event-and-workflow-architecture.md`.)

### Identity & Tenancy (Core)
- **Purpose:** who you are, which org, what you may do.
- **Entities:** `Tenant`, `User`, `Membership` (User×Tenant×Role), `Role`,
  `Permission`, `ApiKey`.
- **Relationships:** every other tenant-owned entity references `tenantId`.
- **Produces:** `TenantProvisioned`, `UserInvited`, `MembershipChanged`.
- **Isolation:** the root of isolation — the tenant boundary.
- **Reuse:** `rbac.ts`, `users.ts`, `session.ts` — extend, don't replace.

### Customers & CRM (Core — NEW)
- **Purpose:** first-class people/orgs you sell to (fills the #6 gap).
- **Entities:** `Customer` (person/org), `Contact`, `Lead`, `LeadSource`.
- **Relationships:** `Booking.customerId`, `Quote.customerId`, `Message.customerId`.
- **Produces:** `LeadCreated`, `CustomerCreated`, `CustomerMerged`.
- **Migration:** backfill from existing booking name/phone/email; dedupe on phone.

### Sales — Quotes & Estimates (Core — NEW persistence)
- **Purpose:** persist the quote lifecycle (fills #8).
- **Entities:** `Quote` (number, status draft/sent/viewed/accepted/expired,
  line items, expiry), `Estimate`.
- **Relationships:** `Quote → Customer`, `Quote → Booking` (on accept).
- **Produces:** `QuoteRequested/Generated/Sent/Viewed/Accepted/Expired`.

### Services & Pricing (Core interface, Industry data)
- **Entities:** `Service` (catalog), `PricingModel`, `PricingCalibration`.
- **Relationships:** industry pack supplies catalog + pricing shape; tenant
  overrides values.
- **Reuse:** `services.ts`, `disposal.ts`, `job-learning.ts` — demote the
  hardcoded defaults to per-industry/per-tenant seeds; scope `learn:*` by tenant.

### Bookings & Jobs (Core)
- **Entities:** `Booking`, `Job` (unify retail booking + the "route" job),
  `ChangeOrder` (NEW — fills #27).
- **Relationships:** `Job → Customer`, `Job → Crew`, `Job → Equipment`.
- **Produces:** `BookingCreated`, `JobScheduled`, `ChangeOrderCreated/Approved`,
  `JobStarted/Delayed/Completed`.
- **Note:** the biggest modeling decision — whether retail Booking and contract
  Route converge into one `Job` aggregate. See `18-...` decision D6.

### Routes & Scheduling (Core, Industry-flavored)
- **Entities:** `Route`/`Dispatch`, `Assignment`, `Availability`, `TimeOff`,
  `Capacity`, `Blackout`.
- **Reuse:** `routes.ts`, `availability.ts`, `crew-availability.ts`, `timeoff.ts`.

### Workforce & Compliance Evidence (Core)
- **Entities:** `Worker`/`Staff`, `TimeEntry` (NEW aggregation over clock
  events), `ComplianceEvidence` (uniform photo, GPS punch, signed disclaimer),
  `Document` (W-9, license — encrypted).
- **Reuse:** `staff.ts`, `uniform.ts`, clock fields on `routes.ts`,
  `doc-crypto.ts`. Add a real `TimeEntry` read-model (fills #16 gap).

### Equipment & Fleet (Core, Industry-flavored)
- **Entities:** `Equipment`/`Asset`, `AssetAssignment`, `MaintenanceSchedule` (NEW).
- **Reuse:** `equipment.ts`; add reverse index + double-book check + enforce
  `equipment:assign`.

### Invoicing, Payments, Compensation, Expenses, Accounting (Core)
- **Entities:** `Invoice` (unify booking + route invoices under one lifecycle),
  `Payment`, `PayStatement`, `PayCorrection`, `Expense` (NEW — fills #32),
  `LedgerEntry` (NEW — the consolidated money truth), `TaxProfile`.
- **Relationships:** `LedgerEntry` reconciles booking + route revenue − expenses
  − payouts (fixes the two-money-domains gap).
- **Produces:** `InvoiceIssued`, `PaymentReceived`, `ExpenseRecorded`,
  `ProfitabilityThresholdBreached`, `PayStatementIssued`.
- **Reuse:** all of the compensation/invoicing/payment modules; add `Expense`
  and a ledger read-model.

### Messaging, Notifications, Documents (Core)
- **Entities:** `Message`, `Thread`, `Reminder`, `NotificationPreference`,
  `Document`.
- **Reuse:** `messages.ts`, `reminders.ts`, `notify.ts`. Fix `msg:phone:{e164}`
  tenant-scoping (cross-tenant thread-merge risk).

### Analytics & Reporting (Core, read-model)
- **Entities:** `MetricSnapshot`, `Report`. Build a per-tenant read model;
  migrate the two wrapper-bypassing analytics paths.

### Automation & AI Intelligence (Core)
- **Entities:** `Automation` (rule), `AiTask`, `AiRecommendation`,
  `ApprovalRequest`, `AiActionLog`, `PromptVersion`, `AiTelemetry`.
- **Reuse:** the entire `ai/*` subsystem — extend from advisory to the
  Level 0–5 action model in `07-ai-operating-layer.md`.

### Audit & Governance (Core)
- **Entities:** `AuditEvent` (attributed to `userId`, not `'admin'`),
  `RetentionPolicy`, `DataExportRequest`, `ErasureRequest`.
- **Reuse:** `audit.ts` — widen coverage + attribute to `Principal.sub`.

### Industry Configuration & Tenant Configuration (Core — NEW)
- **Entities:** `IndustryPack`, `TenantConfig` (branding, services, prices,
  policies, required evidence, roles, templates, automation limits).
- See `06-industry-module-strategy.md`.

## 4. Ownership boundaries & isolation requirement (RECOMMENDATION)

**Every tenant-owned record carries an explicit `tenantId`** (via key prefix in
the Redis model — see `09-data-architecture.md`), with exactly these documented
exceptions:
- Platform-scoped: `Tenant`, `IndustryPack`, `opspilot:waitlist:*`, platform
  billing, cross-tenant platform analytics, the global AI prompt built-ins.
- Everything else — bookings, routes, staff, claims, messages, invoices,
  pay, equipment, calibration, reminders, audit — is tenant-owned.
