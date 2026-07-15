# 03 — Capability Matrix (Phase 2)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12; capability deltas
> re-verified 2026-07-14. Status legend:
> **Full** · **Partial** · **UI-only** · **Backend-only** · **Mocked** ·
> **Absent** (planned but not present) · **Duplicated** · **High-risk** ·
> **Unknown** (pending verification).
>
> _(Updated 2026-07-14: the platform is now branded **Operion** —
> `PLATFORM.name='Operion'` in `app/lib/company.ts:104`, public page `/operion`,
> `/opspilot`→301. Internal identifiers — the `opspilot:` Redis prefix,
> `/api/opspilot/*` routes, `app/lib/platform/` paths, `OpsPilotMark` component —
> are retained verbatim as **legacy internal ids** for compatibility.)_

## The 47-capability matrix

| # | Capability | Status | Evidence (file) | Note / gap |
|---|---|---|---|---|
| 1 | Authentication | **Full** | `app/api/admin/_lib/session.ts`, `app/api/auth/login/route.ts` | Dual-path; no MFA; no session revocation list |
| 2 | User profiles | **Full** | `app/lib/users.ts` | Distinct from Staff; owner is not a User row; no invite/verify flow |
| 3 | Organizations / tenancy | **Partial (context wired)** | `app/lib/platform/tenancy/with-tenant-route.ts`, `redis.ts:53`, `tenant.ts` | _(Updated 2026-07-14)_ No tenant/org **record** yet, but per-request tenant **context** is now wired: `withTenantRoute` on **104 API handlers** + `withBackgroundTenant` on **3 crons + 3 webhooks**; every Redis key routed via `scopeKey()` (fail-closed). Data-level isolation still **inactive** (`TENANCY_ENABLED=false` → live no-op). See doc 05 |
| 4 | Roles | **Full** | `app/lib/rbac.ts:10` | `admin/manager/crew` only |
| 5 | Permissions | **Partial (drift)** | `app/lib/rbac.ts:84-134` | Matrix defined; ~20 perms **never checked** (see §Enforcement) |
| 6 | Customers | **Absent** | `app/lib/bookings.ts:181-184` | Only denormalized name/phone/email on bookings; no entity/index/history |
| 7 | Leads | **Partial** | `app/api/quote/route.ts:250-311` | Emails ops; **not persisted** (no `lead:` store). The Operion early-access waitlist (legacy key prefix `opspilot:waitlist:*`) is a separate store |
| 8 | Quotes/estimates | **Partial** | `app/api/quote/route.ts`, `estimate/route.ts` | Compute + email only; **no persisted Quote object / lifecycle** |
| 9 | Bookings | **Full** | `app/lib/bookings.ts` | 17 statuses, idempotent online booking |
| 10 | Jobs/Routes | **Full** | `app/lib/routes.ts` | Contractor dispatch; multi-assignee |
| 11 | Scheduling | **Full** | `app/lib/availability.ts` | Capacity/blackout/deposit; auto-release abandoned holds |
| 12 | Crew assignments | **Full** | `app/lib/routes.ts:328-389` | Per-assignee tokens, snapshot pay |
| 13 | Route confirmation | **Full** | `app/lib/routes.ts:344-361`, `app/api/route/[token]/route.ts` | Link + verbal; disclaimer captured |
| 14 | Availability (crew) | **Full** | `app/lib/crew-availability.ts` | Weekly self-submit; feeds Crew Score |
| 15 | Time-off | **Full** | `app/lib/timeoff.ts` | Approve doesn't auto-unassign (by design) |
| 16 | Clock in/out | **Full** | `app/api/route/[token]/route.ts:116-149` | Per-assignee; **no timesheet aggregation** |
| 17 | GPS collection | **Backend-only** | `app/api/route/[token]/route.ts:129,137` | Collected & stored; **no verification/geofence** |
| 18 | Photo uploads | **Full** | `app/lib/uniform.ts`, `app/api/careers/upload/route.ts` | Uniform + completion + applicant docs |
| 19 | Equipment inventory | **Full (basic)** | `app/lib/equipment.ts` | Roster only |
| 20 | Equipment assignment | **Partial** | `app/lib/routes.ts:123-124` | Snapshot `equipmentId`; no double-book check; `equipment:assign` perm **declared-unused** |
| 21 | Messaging | **Full** | `app/lib/messages.ts`, `app/api/webhooks/twilio/sms/route.ts` | Inbound SMS, opt-out, dedup; booking-match is a 1000-row linear scan |
| 22 | Notifications | **Full (push degraded)** | `app/lib/notify.ts`, `crew-notify.ts:12-13` | `push` channel has no transport → falls back to in-app |
| 23 | Recurring reminders | **Full (SMS off)** | `app/lib/reminders.ts`, `app/api/cron/reminders/route.ts` | Engine complete; automated SMS suppressed |
| 24 | Customer status pages | **Full** | `app/booking/[token]/`, `app/track/`, `app/client/[token]/` | Three surfaces |
| 25 | Worker portals | **Full** | `app/portal/*` (7 tabs), `app/api/portal/*` | Crew + applicant portals |
| 26 | Invoices | **Duplicated** | `app/lib/bookings.ts:339`, `app/lib/route-invoices.ts` | Two systems (`JK-INV` booking + `JK-RI` route); booking "invoice" has no lifecycle object |
| 27 | Change orders | **Absent** | — | No change-order entity; nearest is booking continuation + editable amount |
| 28 | Payments | **Full** | `app/lib/payments.ts`, `stripe.ts`, `payment-proof.ts` | Stripe + Zelle sealed proof + manual |
| 29 | Contractor earnings | **Full** | `app/lib/staff.ts`, `finance.ts`, `route-pay.ts` | Snapshotted pay; claim-deduction integration |
| 30 | Pay statements | **Full** | `app/lib/pay-statements.ts` | Immutable `JK-PS`; void frees period |
| 31 | Tax / 1099 | **Partial** | `app/lib/tax-readiness.ts:5` | Readiness assessment only; **no form generation/e-file**; full TIN never stored |
| 32 | Expenses | **Absent** | — | No expense entity/ledger/receipt capture |
| 33 | Profitability | **Partial** | `app/lib/finance.ts:248-324` | **Route P&L only**; booking revenue excluded; no expenses |
| 34 | Reporting | **Partial** | `app/api/admin/finance/route.ts`, `analytics.ts` | Route finance + site analytics; no consolidated company P&L |
| 35 | Audit logs | **Full (narrow + coarse)** | `app/lib/audit.ts`, `routes.ts:301` | Central log covers comms/reminders only; per-record actor = literal `'admin'` |
| 36 | AI functions | **Full (governed)** | `app/lib/ai/service.ts` | 5 read-only/draft-only features; see doc 07 |
| 37 | File storage | **Full** | `@vercel/blob`, `doc-crypto.ts` | Public store; identity docs encrypted |
| 38 | Search | **Absent** | — | Client-side filtering only; several full-scan linear finds |
| 39 | Mobile responsiveness | **Full (uneven)** | `OperationsShell.tsx:130`, `PortalShell.tsx:96` | Bottom tab bars, safe-area; no global overflow guard |
| 40 | Accessibility | **Partial** | 113 `aria-*` app-wide (4 in crew portal) | No focus-trap on modals; 14 raw `<img>`; crew portal thin |
| 41 | Error handling | **Full (conventions)** | `session.ts:200-235` | Consistent fail-open/closed decisions; silent-catch masks some UI errors |
| 42 | Monitoring | **Partial (substrate scaffolded)** | `app/lib/platform/observability/`, `alerts.ts`, `ai/telemetry` | _(Updated 2026-07-14)_ Still no external Sentry/APM. A structured logger/redact/tenant-telemetry layer is now scaffolded under `platform/observability/` but **DORMANT (0 importers)** — runtime logging remains raw `console`. AI telemetry + `/api/health` are the live substrate |
| 43 | Data export | **Partial** | `app/api/admin/bookings/export/route.ts` | Bookings CSV + claims PDF only |
| 44 | Data retention | **Absent** | — | No TTL/retention policy on PII |
| 45 | Account deletion | **Absent** | `app/lib/users.ts:167` | Admin hard-delete CRUD only; no self-serve erasure |
| 46 | Tenant isolation | **Partial (chokepoint wired, dormant)** | `app/lib/redis.ts:53`, `platform/tenancy/keys.ts:18`, `scripts/bypass-detection.test.ts` | _(Updated 2026-07-14)_ The `scopeKey()` chokepoint + `AsyncLocalStorage` context + platform-global allowlist (`opspilot:`, `ai:`) are IMPLEMENTED and fail-closed, guarded by a blocking `bypass-detection` CI gate. But keys resolve **unchanged** while `TENANCY_ENABLED=false`, so **data-level isolation is inactive** — the activation migration (Blob scoping, `ai:*`/name-key fixes) is still the core remaining work. See doc 05 |
| 47 | (bonus) Careers/ATS | **Full** | `app/lib/applicants.ts`, `ats-scoring.ts` | Rich pipeline, encrypted identity docs |

## Status roll-up

- _(Updated 2026-07-14)_ **Full: 24** · **Partial: 12** · **Backend-only: 1** ·
  **Duplicated: 1** · **Absent: 8** · (Enforcement-drift flagged on Permissions).
  Three capabilities moved **Absent → Partial** as the platform scaffolding
  landed: **#3 Organizations/tenancy** (context wired), **#42 Monitoring**
  (observability substrate scaffolded but dormant), **#46 Tenant isolation**
  (chokepoint wired, dormant).
- The remaining absences still cluster into three product gaps: **(a) CRM spine**
  (Customer, Lead, Quote, Change-Order, Expense entities), **(b) SaaS spine**
  (Tenant/Org *record* + billing + activation of the wired isolation),
  **(c) compliance spine** (retention, export, erasure).

## Admin operations UI — Book Now dashboard (SHIPPED) — FACT

_(Updated 2026-07-14: `/admin/operations/book-now` was rebuilt from a 20-pill
queue into an **enterprise operations dashboard** — commit `9b0ce99`.)_ It adds a
**KPI overview row** (New, Awaiting AI, Quote Ready, Pending Payment, Booked
Today, Pending Revenue — each click-to-filter), a **toolbar** (search / Filter /
Sort / Table↔Cards toggle / Refresh), **grouped-accordion filters** (Services /
AI Status / Sales Pipeline, with live counts), a **full-width request table**
(Customer, Service, Location, Created, AI, Quote, Payment, Crew, Priority; sticky
header, column sort, bulk select), and a **slide-over request drawer** (customer,
photos, AI analysis + confidence + estimate breakdown, quote/payment, notes, plus
quick Call/Email/Mark-read and "Open full detail"). This is **UI-only**: `GET
/api/admin/book-now`, `matchesBookNowFilter`, the `?filter=` deep-link, 15s AI
polling, the unread model, and all **12 PATCH mutating actions** on the
`[token]` detail page are preserved unchanged. Maturity: **Production Functional**
(no schema/API change).

## RBAC enforcement drift (the most important "Partial") — FACT

The matrix in `app/lib/rbac.ts:84-134` declares ~50 permissions, but a route
census found **~65 admin routes gated only by the coarse `requireSession`**
(any admin OR manager) while ~40 use granular `requirePermission`. Permissions
**declared but never checked** include: `equipment:manage`, `equipment:assign`,
`businesses:manage`, `routes:manage`, `crew:manage`, `crew:assign`,
`applicants:review`, `applicants:decide`, `claims:manage`, `settings:manage`
(partially), `reports:view`, `profitability:view`.

**Consequence:** a `manager` reaches `app/api/admin/reports`, `disposal`, and
`claims` despite the matrix not granting the corresponding permission. Finance is
correctly `requireAdmin` (`app/api/admin/finance/route.ts:17`). **ASSUMPTION:**
practical exposure is limited today because managers already hold most
operational perms — but the matrix ≠ the gate, and under multi-tenant, per-plan,
or least-privilege enterprise requirements this becomes a real defect. Closing it
is in the first sprint.

## Assumptions in this matrix

- Page **existence** is confirmed by directory listing; some page *behavior* is
  inferred from the lib/API modules they consume (the source of truth for logic).
- `app/api/estimate/route.ts` internals were not fully opened; assumed a lighter
  variant of `/api/quote`.
- "Search = client-side only" and "GPS non-verification is intentional" are
  inferences from the lib layer, not runtime-confirmed.
