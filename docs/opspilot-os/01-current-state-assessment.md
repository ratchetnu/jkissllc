# 01 — Current-State Assessment (Phase 1)

> Cited to `file:line` on `~/jkissllc@main`. Baseline recon 2026-07-12;
> **_(Updated 2026-07-14)_** for the shipped **Operion** platform foundation, S1
> tenant-context wiring, hardened CI, isolated dark-launch preview, and the Book
> Now admin redesign. **FACT** = code-verified; **ASSUMPTION** = inference not
> fully confirmed.
> Product brand = **Operion** (`PLATFORM.name`, `app/lib/company.ts:105`).
> Internal identifiers keep the legacy `opspilot` slug for compatibility (this
> doc folder, the `opspilot:` Redis prefix, `/api/opspilot/*`, `OpsPilotMark`).

## 0. How this corrects the prior roadmap

`docs/opspilot-multi-tenant-roadmap.md` (2026-07-08) is a good artifact but is
now **stale**. Corrections established by this assessment:

| Prior roadmap claim | Reality now (cited) |
|---|---|
| "No central `company.ts` exists" (§6) | **`app/lib/company.ts` exists** — identity centralized in a `COMPANY` object |
| `SessionPayload = {iat,exp,idleExp}`, no principal (§4.1) | **RBAC shipped** — payload carries `{sub, role, staffId}`; `getPrincipal()` returns a `Principal` (`app/api/admin/_lib/session.ts:17-38`) |
| `middleware.ts:9-12` apex redirect | File is now **`proxy.ts`** (Next 16 rename); apex→www at `proxy.ts:13-17` |
| §1.1–1.4 pre-existing defects "to fix first" | **All four FIXED** (see `10-security-risk-register.md` §9) |
| Duplicate `JK-INV-` counters (§1.1) | **Resolved** — route invoices mint `JK-RI-` (`app/lib/route-invoices.ts:66-69`) |

Where this blueprint and the old roadmap conflict, **this blueprint wins**.

## 1. Platform & runtime (FACT)

| Facet | Finding | Evidence |
|---|---|---|
| Framework | Next.js **16.2.2**, App Router | `package.json:24` |
| UI runtime | React **19.2.4**, React-DOM 19.2.4 | `package.json:25-26` |
| Language | TypeScript ^5, strict typecheck in `predeploy` | `package.json:14,37` |
| Package manager | **npm** (only `package-lock.json`; CI uses `npm ci`) | `.github/workflows/ai-regression.yml:26` |
| Styling | **Tailwind v4** (CSS-first, no `tailwind.config`), `@tailwindcss/postcss` | `app/globals.css:1`, `postcss.config.mjs:3` |
| Fonts | `next/font/google`: Inter, Space Grotesk, JetBrains Mono | `app/layout.tsx:4,19-21` |
| Icons | `lucide-react` ^1.17 | `package.json:22` |
| Config | `next.config.ts` near-empty, wrapped by `withBotId(...)` | `next.config.ts:2,9` |
| Middleware | **`proxy.ts`** (Next 16 name) — apex→www + RBAC gate + sliding session | `proxy.ts:13-59` |

## 2. Data & storage (FACT)

- **Primary store: Upstash Redis** via a hand-written REST wrapper
  (`app/lib/redis.ts`). Exposes only `GET/SET/DEL/ZADD/ZREVRANGE/ZREM/INCR/
  PEXPIRE/ZCARD/ZRANGE/SET-NX-PX/EVAL` — **no SCAN/KEYS** (`app/lib/redis.ts:36-77`).
- **No SQL database.** No Postgres, no Supabase, no ORM anywhere. Every module
  keys into Redis. Convention: entity JSON at `prefix:{id}` + a sorted-set index
  (`*:index`, score = timestamp), read via `zrevrange` → per-key `get`.
- **Files: Vercel Blob** (`@vercel/blob`). Store is **public**; identity
  documents are protected by **encryption**, not ACL (`app/lib/doc-crypto.ts`).
  _(Updated 2026-07-14: there are now **two Blob stores** — prod
  `jkiss-invoice-photos` and the isolated preview `operion-preview-blob`. Blob
  paths are still **globally namespaced** (not tenant-scoped) — a named S2
  activation blocker.)_
- **Atomicity**: per-entity mutexes built on `SET NX PX` + Lua compare-and-delete
  (`app/lib/route-mutex.ts`, `app/lib/redis.ts:69-76`).
- **Tenant chokepoint _(Updated 2026-07-14)_:** every key now routes through
  `scopeKey()` in `app/lib/redis.ts`; with `TENANCY_ENABLED=true` and no resolved
  context it **throws (fail-closed)**, and a **blocking**
  `scripts/bypass-detection.test.ts` CI gate forbids any Redis access outside the
  chokepoint. With the flag OFF (today) it is a byte-identical no-op.

## 3. Providers & integrations (FACT — names only, no secrets read)

| Concern | Provider | Evidence |
|---|---|---|
| Payments | **Stripe** ^21 — Checkout Sessions (`mode:'payment'`) + one refund; **key shared with ClaimGuard** | `app/lib/stripe.ts:3,14-18` |
| Email | **Resend** ^6 | `app/lib/booking-emails.ts` |
| SMS | **Twilio** (raw REST — no SDK dep) | `app/lib/sms.ts` |
| AI | **Vercel AI Gateway** via `ai` SDK ^7; default model `anthropic/claude-sonnet-4-6` | `app/lib/ai.ts:1,8` |
| Bot defense | **Vercel BotID** (`botid`), invisible challenge on protected POSTs | `next.config.ts:2`, `app/lib/botcheck.ts`, `app/layout.tsx:10-18` |
| Web analytics | `@vercel/analytics` (one `<Analytics/>`) | `app/layout.tsx:2,115` |
| Reviews | Google Places API | env `GOOGLE_PLACES_API_KEY`, `GOOGLE_PLACE_ID` |
| Maps | `maplibre-gl` ^5 | `package.json:23` |

## 4. Auth, authorization, tenancy (FACT)

- **Auth (dual-path, one cookie `jk_admin_session`):** legacy shared-password
  owner login (`app/api/admin/auth/route.ts`, constant-time `secretsMatch`) and
  named-user login (`app/api/auth/login/route.ts`, pbkdf2 `verifyPassword`).
  HMAC-SHA256 signed token; **absolute 2h TTL + 10-min sliding idle**
  (`app/api/admin/_lib/session.ts:5-6`).
- **Authorization:** 3 roles `admin | manager | crew` (`app/lib/rbac.ts:10`),
  ~50 permissions in a static matrix. `proxy.ts:34-46` blocks crew from
  `/admin` + `/api/admin` at the edge; per-route guards
  (`requirePermission`/`requireAdmin`/`requireStaffSession`/`requireSession`).
  Crew portal scopes every call to `who.staffId` (`app/api/portal/_lib/crew.ts:8-15`).
  **Gap:** enforcement is partial (see `03-capability-matrix.md` #4).
- **Tenancy: foundation shipped, data-inactive** _(Updated 2026-07-14 — was
  "none modeled")_. A dedicated platform foundation lives under
  `app/lib/platform/*` (tenancy, capabilities, workspaces, industry-packs,
  ai-workers, events, approvals, intelligence, observability). **S1 Tenant
  Context Wiring is live on `main`/prod:** `withTenantRoute`
  (`app/lib/platform/tenancy/with-tenant-route.ts`) establishes a per-request
  `AsyncLocalStorage` tenant context on **104 request handlers**, and **3 crons +
  3 webhooks** run under explicit per-tenant context (`withBackgroundTenant`).
  Sessions now carry a `tid` claim; `activeTenantIds()`
  (`app/lib/platform/tenancy/tenant-store.ts`) enumerates known tenants. Because
  `TENANCY_ENABLED=false` this is a **byte-identical no-op** resolving to the
  single reference tenant `t:jkiss` — so there is still **no org boundary on any
  data record** and a **single shared owner identity**. Legacy `tenantId()`
  (`app/lib/tenant.ts`) still stamps AI telemetry and coexists with the platform
  module. Detail: `05-multi-tenant-architecture.md`.

## 5. Background jobs, cron, webhooks (FACT)

- **Cron** (`vercel.json`): `/api/cron/daily` at `0 14 * * *` (9am Central),
  `/api/cron/reminders` every 5 min, and `/api/cron/ai-jobs` every 3 min (drives
  the durable book-now-ai worker) _(Updated 2026-07-14: ai-jobs added; all 3
  crons now run under explicit per-tenant context via `withBackgroundTenant`)_.
  The customer-facing crons run inside `withSmsSuppressed` — **all
  automated SMS disabled** by design; email + housekeeping still fire
  (`app/api/cron/daily/route.ts:218-221`). Daily sweep: booking reminders,
  recurring-template materialization, route dispatch automation, abandoned-hold
  cleanup, weekly claim payroll accrual.
- **Cron guard fails OPEN if `CRON_SECRET` unset** (`app/api/cron/daily/route.ts:207-211`).
- **Webhooks (3):** Stripe (`app/api/webhooks/stripe/route.ts` — verified,
  hard-fails without secret), Twilio inbound SMS (`app/api/webhooks/twilio/sms/route.ts`
  — HMAC-SHA1, **fails open** if secret unset), inbound email
  (`app/api/webhooks/email/route.ts` — shared secret, **fails open** if unset).

## 6. Testing & CI/CD (FACT) _(Updated 2026-07-14)_

- **Runner:** Node `--test` via `tsx`. No Jest/Vitest. **75 `scripts/*.test.ts`,
  586 test cases** (grew from 23 files / ~220 cases at baseline). Suites now
  include `tenant-isolation`, `bypass-detection`, `rbac`, `authorization-coverage`,
  `security-hardening`, and the AI-regression suite.
- **CI:** one workflow `.github/workflows/ai-regression.yml` — push to `main`
  + all PRs → `npm ci` → **`tsc --noEmit` → full `npm test` (all 586 cases) →
  `next build`**, on **Node 24** (pinned via `engines` + `.nvmrc`). This is now a
  **blocking verify gate** (protects `main` via required-check branch protection),
  no longer advisory typecheck-plus-AI-tests only.
- **`predeploy`** (`package.json`) remains a local guard; the authoritative gate
  is the CI verify job above.

## 7. Feature flags & configuration (FACT) _(Updated 2026-07-14)_

- **A dedicated platform feature-flag module now exists:**
  `app/lib/platform/flags.ts` — `TENANCY_ENABLED`, `TENANCY_DARK_LAUNCH`,
  `TENANCY_DUAL_WRITE`, `AI_WORKFORCE_ENABLED`, `CAPABILITY_REGISTRY_ENABLED`
  (=true), `APPROVAL_QUEUE_ENABLED`, `INDUSTRY_PACKS_ENABLED`, `INSIGHTS_UI_ENABLED`,
  `DESIGN_SYSTEM_REFERENCE_ENABLED`, `INTAKE_WORKFLOW_ENABLED`. **All OFF except
  `CAPABILITY_REGISTRY_ENABLED`** (inert data only) — the tenancy foundation is
  wired but dormant. (Prior baseline claimed "no `flags.ts`" — now stale.)
- The older ad-hoc gates still coexist: `withSmsSuppressed()` context kill-switch
  (`app/lib/sms.ts:21`), Redis-backed automation booleans
  (`app/lib/automation-settings.ts`), the AI daily cost cap
  (`app/lib/ai/budget.ts`), per-feature AI model routing
  (`app/lib/ai/routing.ts`), and the BotID `PROTECTED_ROUTES` list
  (`app/layout.tsx:10-18`).

## 8. Observability (FACT)

- **No third-party error monitoring / APM** (grep for
  sentry/datadog/pino/opentelemetry = zero). Runtime error handling is
  `console.error` + fail-soft `try/catch`. _(Updated 2026-07-14: a first-party
  structured logger + redaction + tenant-telemetry now exists under
  `app/lib/platform/observability/`, but it is **DORMANT (0 importers)** — runtime
  logging is still raw console. Optional `ERROR_WEBHOOK_URL` alerting via
  `app/lib/alerts.ts`.)_
- **The exception:** a custom, Redis-backed **AI observability substrate**
  (`app/lib/ai/telemetry.ts`, `analytics.ts`, `budget.ts`, `quality.ts`) — every
  AI call recorded with actor/tenant/model/latency/tokens/cost/outcome. This is
  domain-specific LLMOps, not app-wide APM.
- Owner alerting exists (SMS/email via `app/lib/owner-alerts.ts`) but is
  event-driven, not health/uptime monitoring.

## 9. Deployment (FACT)

- **Vercel, git-push auto-deploy** (`origin = github.com/ratchetnu/jkissllc`,
  `.vercel/` link dir present) → `main` auto-deploys to Production (jkissllc.com).
  Build = default `next build`. `next.config.ts` now carries the `/opspilot`→
  `/operion` 301 (brand rename). _(Updated 2026-07-14.)_
- **Preview is data-isolated from Production:** Vercel Preview is backed by a
  separate Upstash Redis (`OperionPreview`) + Blob (`operion-preview-blob`) with
  Preview-only flags `TENANCY_ENABLED=false` + `TENANCY_DARK_LAUNCH=true`. This is
  the **dark-launch validation surface** — its `tenancy:dark-launch-mismatch`
  telemetry has **not yet been exercised** (DARK-LAUNCH READY, NOT YET VERIFIED).
- **Book Now admin redesign SHIPPED to prod:** `/admin/operations/book-now` is now
  an enterprise dashboard (KPI row, toolbar with search/filter/sort/view-toggle,
  grouped-accordion filters, full-width request table with sticky header + bulk
  select, slide-over request drawer). UI-only — every API, filter, and PATCH
  action is preserved; the detail page is unchanged.

## 10. Company-specific / single-tenant assumptions (FACT — summary)

Centralized where possible, scattered where not:
- **Centralized:** `app/lib/company.ts` (name, DOT/MC, phone, address, brand hex).
- **Scattered literals (per prior roadmap §6, still largely true):** brand red
  `#E0002A` re-hardcoded in 15+ TS/TSX files despite `--red` existing
  (`app/globals.css:15`); DOT/MC in ~17 places; phone in ~12; email FROM frozen
  at module scope (`app/lib/booking-emails.ts`); box-truck assumption compiled
  into `app/admin/operations/new/page.tsx:10` (`const VEHICLE = 'Box truck'`);
  ATS pay/role hardcoded as TS unions (`app/lib/ats-config.ts`); DFW-only cities
  drive static route generation (`app/lib/cities.ts`); analytics TZ hardcoded
  Central (`app/lib/analytics.ts`).

## 11. What is genuinely strong (FACT — don't disturb)

- Constant-time secret comparisons, CSPRNG bearer tokens (256-bit), AES-256-GCM
  identity-doc encryption (fail-closed), zero secret-logging, full admin-route
  authorization coverage.
- Idempotent payment recording, per-entity mutexes, immutable pay statements,
  snapshotted pay/financials so rate edits never rewrite history.
- The governed AI pipeline with a pre-deploy regression gate.

These are load-bearing and correct; the migration must preserve them.
