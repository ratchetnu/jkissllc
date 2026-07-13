# 01 — Current-State Assessment (Phase 1)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12. **FACT** = code-verified;
> **ASSUMPTION** = inference not fully confirmed.

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
- **Files: Vercel Blob** (`@vercel/blob` ^2.5). Store is **public**; identity
  documents are protected by **encryption**, not ACL (`app/lib/doc-crypto.ts`).
- **Atomicity**: per-entity mutexes built on `SET NX PX` + Lua compare-and-delete
  (`app/lib/route-mutex.ts`, `app/lib/redis.ts:69-76`).

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
- **Tenancy: none modeled.** `tenantId()` (`app/lib/tenant.ts:8-12`) returns
  `TENANT_ID` or apex host, used only to stamp AI telemetry/cost. No tenant
  record, no org boundary on any entity.

## 5. Background jobs, cron, webhooks (FACT)

- **Cron** (`vercel.json:3-6`): `/api/cron/daily` at `0 14 * * *` (9am Central),
  `/api/cron/reminders` every 5 min. Both run inside `withSmsSuppressed` — **all
  automated SMS disabled** by design; email + housekeeping still fire
  (`app/api/cron/daily/route.ts:218-221`). Daily sweep: booking reminders,
  recurring-template materialization, route dispatch automation, abandoned-hold
  cleanup, weekly claim payroll accrual.
- **Cron guard fails OPEN if `CRON_SECRET` unset** (`app/api/cron/daily/route.ts:207-211`).
- **Webhooks (3):** Stripe (`app/api/webhooks/stripe/route.ts` — verified,
  hard-fails without secret), Twilio inbound SMS (`app/api/webhooks/twilio/sms/route.ts`
  — HMAC-SHA1, **fails open** if secret unset), inbound email
  (`app/api/webhooks/email/route.ts` — shared secret, **fails open** if unset).

## 6. Testing & CI/CD (FACT)

- **Runner:** Node `--test` via `tsx@4`. No Jest/Vitest. **23 `scripts/*.test.ts`,
  ~220 test cases.** Largest: `claims.test.ts` (~40), `finance.test.ts` (18),
  `doc-crypto.test.ts` (16), `booking-payments.test.ts` (15).
- **CI:** one workflow `.github/workflows/ai-regression.yml` — push to `main`
  + all PRs → `npm ci` → `tsc --noEmit` → `test:ai` → `test:ai:regression`.
  **Advisory only** (does not block Vercel deploys unless branch protection is
  enabled — `ai-regression.yml:6-10`).
- **`predeploy`** (`package.json:14`) = `tsc --noEmit && test:ai:regression` —
  local guard, not wired into Vercel's build.

## 7. Feature flags & configuration (FACT)

- **No dedicated feature-flag system** (no LaunchDarkly/Vercel Flags, no
  `flags.ts`). Gating is ad hoc via: `withSmsSuppressed()` context kill-switch
  (`app/lib/sms.ts:21`), Redis-backed automation booleans
  (`app/lib/automation-settings.ts`), the AI daily cost cap
  (`app/lib/ai/budget.ts`), per-feature AI model routing
  (`app/lib/ai/routing.ts`), and the BotID `PROTECTED_ROUTES` list
  (`app/layout.tsx:10-18`).

## 8. Observability (FACT)

- **No third-party error monitoring / APM / structured logging** (grep for
  sentry/datadog/pino/opentelemetry = zero). Error handling is `console.error`
  + fail-soft `try/catch`.
- **The exception:** a custom, Redis-backed **AI observability substrate**
  (`app/lib/ai/telemetry.ts`, `analytics.ts`, `budget.ts`, `quality.ts`) — every
  AI call recorded with actor/tenant/model/latency/tokens/cost/outcome. This is
  domain-specific LLMOps, not app-wide APM.
- Owner alerting exists (SMS/email via `app/lib/owner-alerts.ts`) but is
  event-driven, not health/uptime monitoring.

## 9. Deployment (FACT)

- **Vercel, git-push auto-deploy** (`origin = github.com/ratchetnu/jkissllc`,
  `.vercel/` link dir present). `vercel.json` contains **only** the two cron
  defs — no regions/functions/headers/rewrites overrides. Build = default
  `next build`.

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
