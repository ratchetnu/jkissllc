# OpsPilot — Technical Debt & Future Improvements

Prioritized roadmap for the feature-expansion request, grounded in the current
architecture. **Shipped** items are live on both jkissllc and Supercharged and
verified in production. **Planned** items are scoped here with the exact systems to
extend — no parallel systems, no placeholders.

Legend: 🟢 shipped · 🟡 next · 🔵 later · ⚫ needs infra decision

---

## ✅ Shipped this cycle (live + e2e-verified on both tenants)

- **Employees → Crew rename** (user-facing only; `Staff` model, `staff:*` keys,
  `/employees` route, `/api/admin/staff`, and PayKind `employee`/`contractor` values
  untouched). PayKind pill labels intentionally kept (tax classification, not the noun).
- **Global Last Login** — `lib/admin-login-log.ts` records current/previous
  `{at, device}` on real auth only; rendered atop every authed page in Central time;
  account-wide (single shared admin); no IP stored/returned; "First recorded login"
  fallback.
- **AI Command Palette** — NL layer on the existing ⌘K palette →
  `/api/admin/ai/command` (server-built target allowlist; the model only echoes a
  target id, so hallucinated URLs are impossible; answers strictly from a counts
  summary; fails soft). Reuses `lib/ai.aiText` + the Vercel AI Gateway.
- **Crew Applicant Portal core** — surfaced the existing ATS inside Crew (sub-nav
  Directory | Applicants + waiting-review badge); added statuses
  (information_requested / withdrawn / archived) + requested vocabulary; applicant
  **activity timeline** (`events[]` + `pushApplicantEvent`); **duplicate-safe
  approval** (dedup by applicantId/email/phone → link instead of duplicate) with
  email + badge photo + `applicantId` back-link carryover and an onboarding flag;
  `Request info` action.

---

## 🟡 Crew Compensation Center (request §2)

**Extend, don't rebuild.** The pay engines already exist:
`lib/finance.computeFinance` (per-crew/per-business rollups, filters) and
`lib/route-pay.computePay` (per-contractor pay over a window). Completed/approved
work = `RouteStatus === 'completed'` (already the invoice/finance definition).

Build a **Compensation section inside the crew profile** (the expanded
`EmployeeCard` in `app/admin/operations/employees/page.tsx`) rendering:
Total Paid / Outstanding / current period / YTD / completed routes / payment
history / assigned businesses & routes / default rate — **all derivable today** from
routes + `resolveCrewPay` + the claims deduction ledger (`lib/claim-payroll.ts`).

**Data-model gap (the real work):** pay is **flat per-route cents only** today
(`Staff.defaultPayCents` + `payByBusiness`). The requested structures — hourly,
daily, per-stop, percentage, mileage — require a **`payStructure` discriminated
union on `Staff`** plus a resolver that reads route facts (hours from the timeclock
punches already captured on the assignee; stops/mileage need new route fields).
Bonuses/reimbursements/deductions/adjustments should reuse the **claims ledger
pattern** (`LedgerEntry`, append-only, cents-exact) rather than a new store.
Effort: **L**. Do the read-only Compensation summary first (S), then the structure
expansion (L).

## 🟡 Pay Statement Generator (request §3) ⚫

Today's closest artifact: the print-CSS page at `app/admin/routes/pay/page.tsx`
("Print / Save PDF" via `window.print()`). **No PDF library is installed.**

Two viable paths — pick one:
1. **Print-CSS statement (no new dep, fastest):** a dedicated
   `/admin/operations/crew/[id]/statement` route rendered as a branded, print-ready
   HTML page (company header from `lib/company.ts`, gross/net/YTD, line items), using
   the existing `@media print` approach. Ships in days; "Download" = browser Save-as-PDF.
2. **True server PDF (`pdf-lib`, ~1 dep):** generate a stored PDF blob (Vercel Blob
   is already wired) for email/save-to-profile/regenerate. Needed for the "email a
   PDF" and "maintain history" requirements.

Either way, **persist statement records** (a new `pay-statements` Redis entity keyed
by crew+period with a counter, mirroring `route-invoices.ts`) so preview / regenerate
/ duplicate-prevention / history all work. Reuse `emailRaw` for delivery. Effort: **M–L**.

## 🟡 OpsPilot AI Pay Assistant (request §4)

Add `app/api/admin/ai/pay-statement/route.ts` modeled on the existing
`ai/message` + the new `ai/command` route. It should **gather** completed routes +
approved punches for the crew/period, **apply** the pay resolver, **detect**
duplicates/missing-rates/incomplete-approvals, and **draft** a summary — but the
statement totals come from the deterministic engine, never the model (the prompt
already forbids inventing numbers; enforce by passing computed figures in and having
the AI only narrate). Requires the Compensation engine above first. Effort: **M**.

## 🔵 Year-End 1099 Readiness (request §5)

A read-only panel on the crew profile: YTD compensation (from the pay engine),
W-9 status + missing address/taxpayer-info flags. **Data-model gap:** `Staff` has no
W-9/TIN/address fields — add `w9: { status, addressComplete, tinOnFile }` (store the
TIN encrypted, reuse the applicant doc-sealing pattern in `lib/ats-config`/blob).
Explicitly **do not** generate 1099 forms until a tax module exists (per request).
Effort: **M**.

## 🔵 Operations redesigned by Business (request §6)

Operations is flat/time-based today (`operations/page.tsx`, `list/page.tsx` with 4
filter tabs). The data to group already lives on every route + in `useOps` stats.
Build a **business-grouped home**: aggregate `useOps().routes` by `businessName` into
per-business cards (upcoming/pending/confirmed/active/completed counts + claims +
assigned crew + next route + route value + alerts). Clicking → a **per-business
operations page** with Today/Tomorrow/Upcoming/Confirmed/Pending/Active/Completed/
Cancelled/Claims tabs (extend the existing filter model) + search. **No calendar view
exists** — that's the one net-new UI (a month grid over `routeDate`). Handle
one-time customers as an "Ad-hoc" group. Effort: **L**. No new data layer.

## 🔵 Business Detail page + Quick Actions (request §7)

Today's business "hub" (`operations/businesses/page.tsx`) is read-mostly expandable
cards with pricing/schedule/upcoming/invoices/claims. Promote to a **dedicated route**
`/admin/operations/businesses/[key]` adding: assigned crew (scan routes), assigned
equipment (scan `route.equipmentId` — no reverse index today), full route history,
payments, crew costs, profitability, documents, notes; quick actions (create route →
`/new` prefilled, assign crew, generate pay statement, open claim). Effort: **L**.

## 🔵 Business Financial Dashboard (request §10) ⚫

`computeFinance` already returns `byBusiness` revenue/payout/profit with date filters —
reuse it for a per-business dashboard with week/month/quarter/year/custom ranges.
**Two gaps:** (1) **cost model** — only crew payout is tracked; fuel/dump/equipment/
other-cost inputs must be added (a new `route-costs` or per-route cost fields) for
true gross-profit/margin; (2) **charts** — none installed. Prefer inline SVG/CSS
sparklines + bars (matches the hand-built finance tiles, zero deps) over a charting
lib; consult the `dataviz` skill for palette/accessibility. Effort: **L**.

## 🟡 ClaimGuard guided intake (request §8)

Mostly **already shipped** (Phase 1/2 of the prior cycle: `ClaimGuardAssist` +
context-aware deep-links + native `claim-documents`). Remaining: turn the `NewClaim`
sheet into a **guided step wizard** (business → route → date → type → description →
amount → photos/docs → reporter → deadline) that then routes to the Assist panel.
This is a UI refactor of the existing form — no new backend. Effort: **M**.

## 🟡 Security & Audit (request §12) ⚫

`requireSession` gates all admin APIs, but **there is no user identity** (single
shared admin — see the tenancy TODO in `_lib/session.ts`) and **no central audit
log** (only per-record `audit[]`/`events[]` arrays). To do compensation/statement/
rate-change/payment auditing *with attribution*, first add subject identity to the
session payload (the multi-tenant roadmap), then a `lib/audit.ts` Redis list. Until
then, record events on the record itself (as Phase 3 does for applicants). Restricting
compensation/pay/tax to specific roles also needs the identity/role work. Effort:
**L** (gated on tenancy). This is the highest-leverage foundational item.

## 🔵 Validation matrix (request §13)

Several already hold (cancelled routes excluded from money; multi-business pay via
`payByBusiness`; earnings-cap invariant in claims). Add explicit handling +
tests for: partial routes, missing rates (surface, don't silently $0 — already
warned in the builder), duplicate statements (the statement entity's dedup),
negative deductions (reject), inactive crew/business isolation. Fold into the
Compensation and Statement work.

---

## Advanced Applicant Portal items (request §2, beyond the shipped core)

🔵 Applicant-facing **secure re-upload link** for "Request Info" (tokenized page like
`/careers/continue/[token]`, mirroring the passwordless `/freight/status` token
pattern) · interview scheduling · onboarding checklist workflow · bulk actions ·
per-decision applicant notifications (reuse `notify.ts` `hasEmail`/`hasSms`) ·
full Applicant Profile page inside the shell (today it reuses the `/admin/careers`
review UI, which already runs in `OperationsShell` via `AdminGate`).

---

## Cross-cutting

- **Tenancy is the keystone.** Real per-user identity/roles (session `sub`/`tid`/
  `role`) unblocks: attributed audit, role-gated compensation/tax, per-user Last
  Login, and `bizKey` collision fixes. Prioritize before security-sensitive features.
- **Keep both tenants in lockstep.** Every change ports jkissllc→Supercharged via
  `git diff <lastSync> HEAD | git apply` (branding files diverge — hand-merge those),
  then `vercel --prod` on Supercharged (it does **not** auto-deploy).
