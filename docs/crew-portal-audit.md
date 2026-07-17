# Crew Portal & Workforce Operations — Audit

_Branch: `feat/crew-portal-workforce` · Session 3 (Crew Portal / Workforce)_

This is the Phase-1 audit that precedes the Crew Portal build. The headline
finding: **the crew portal already exists and is substantially complete.** This
work is therefore *audit → complete the real gaps → harden → polish*, not a
greenfield build. We consume the existing job/route model through adapters and
never redesign the canonical Operations schema (owned by other sessions).

## Identity & data foundation

| Concept | Type / file | Redis key | Role |
| --- | --- | --- | --- |
| **Staff** | `Staff` (`app/lib/staff.ts`) | `staff:{id}` | The canonical worker/roster record (name, pay, W-9, timeclock opt-in). |
| **User** | `User` (`app/lib/users.ts`) | `user:{id}` | The login identity. A crew User links to its Staff via `staffId`; admin/manager Users have no `staffId`. |
| **Route** | `RouteRecord` (`app/lib/routes.ts`) | `rt:{token}` | The job. `assignees: Assignee[]` is the crew assignment; each Assignee carries clock/GPS fields inline. |

**Terminology:** the same worker is called `Staff` (data), "crew" (user-facing
labels + portal), and "employee" (only the admin `/employees` route folder,
whose nav label is nonetheless "Crew"). Pay classification is **1099
contractor** by default — copy uses "contractor / payment / settlement
statement", never "employee payroll". New crew code follows: **`Staff`/`staffId`
for data, "crew" for labels, "contractor" for pay.**

### Storage patterns to follow
- **Redis** via `app/lib/redis.ts` only (direct `KV_REST_API` is forbidden and
  test-enforced). Pattern: `KEY(id)` builder consts → JSON blob per record →
  `zadd` index scored by time/`YYYYMMDD` → `persist()` helper stamps
  `updatedAt` → hydrate via `zrevrange` + `Promise.all(get)` + `JSON.parse`
  with try/catch filtering. Every key auto-scoped for tenancy by `scopeKey()`.
- **Vercel Blob** for bytes; Redis stores the pointer. Paths go through
  `scopeBlobPath()` + `sanitizeBlobSegment()` (`app/lib/platform/tenancy/blob-keys.ts`).
  Sensitive docs are AES-256-GCM sealed with `sealDoc`/`openDoc`
  (`app/lib/doc-crypto.ts`) before upload and served decrypted only to the owner.

## Authentication & authorization

- One HMAC-signed cookie `jk_admin_session` (`app/api/admin/_lib/session.ts`)
  carries `{sub, role, staffId, tid}`. Tamper-evident — crew cannot self-promote.
  2h absolute + 10m idle TTL, slid forward in `proxy.ts`.
- `proxy.ts` is the RBAC choke point: crew principals are blocked from
  `/admin` + `/api/admin` at the door (redirect / 403).
- **Every portal API funnels through `requireCrew(req)`**
  (`app/api/portal/_lib/crew.ts`) → returns `Principal & { staffId }` or a 401/403
  `NextResponse`. Handlers scope every read/write to `who.staffId`; an id is
  never trusted from the request body/query. All portal routes wrap in
  `withTenantRoute`. **New crew endpoints must do the same.**
- Login is the shared `POST /api/auth/login` (rate-limited); crew are redirected
  to `/portal`, staff to `/admin/operations`.

## Existing crew portal surface (what already works)

**Pages** (`app/portal/`, all mobile-first, `.jkos`/`.os-*` design language,
`PortalShell` with mobile bottom nav + desktop dock):

| Route | State | Notes |
| --- | --- | --- |
| `/portal` (dashboard) | Complete | Greeting, `CrewTasks` feed, next route, pay tiles, quick links. |
| `/portal/routes` | Complete | Upcoming/Past route cards → `/route/{token}`. |
| `/portal/messages` | Complete | Dispatch chat thread + composer, read receipts. |
| `/portal/availability` | Complete | Weekly per-day toggles + time ranges, draft/submit, copy-last-week. |
| `/portal/timeoff` | Complete | Request form, 24h-late warning, status list, cancel. |
| `/portal/pay` | Complete | Pay tiles (gated), earnings, statements list, correction requests. |
| `/portal/pay/statement/[id]` | Complete | Print/Save-PDF statement view (`window.print()`). |
| `/portal/profile` | Complete | Read-only contact, change-password. |

**APIs** (`app/api/portal/*`): `me, routes, pay, pay-statements[/id],
pay-correction, tasks, ack, uniform, messages, timeoff, availability, password`.

**Libs:** `crew-availability`, `crew-comp` (live pay calc), `crew-notify`
(in-app + SMS + email fan-out), `timeoff`, `uniform`, `pay-statements`,
`pay-corrections`, `route-pay`, `claim-payroll`, `pay-statement-view`,
`tax-readiness`, `reminders`/`reminder-engine`.

## Gaps this branch closes

1. **Clock in/out & GPS are not reachable from the authenticated portal.**
   The only write path is the **public token** endpoint
   `app/api/route/[token]/route.ts` (the token *is* the credential). The portal
   only *reads* `clockInAt`/`clockOutAt`. Punching requires opening the route
   link. → Add a session-authed `POST /api/portal/clock` (feature-gated on
   `staffUsesTimeclock`) that finds today's confirmed route for `who.staffId`
   and writes clock/GPS to that Assignee **through the existing
   `mutateByConfirmToken` lock** — no schema change. Plus a portal Clock surface.

2. **Crew has no Documents section — none at all.** No page, nav entry, API, or
   store serves documents to crew. → Add `app/lib/crew-documents.ts` (library +
   per-staff docs; sealed when sensitive), `GET /api/portal/documents` (+ `[id]`
   serve), a `/portal/documents` page, and a minimal admin API to publish/assign
   crew documents (crew documents are in-boundary). Issued pay statements and
   tax-readiness surface here too.

3. **Uniform photo is a one-per-day check-in with no review/resubmit.**
   `UniformPhoto` has no status; a new upload silently overwrites the day. →
   Extend the record with `status` (`submitted|approved|rejected`) + review
   metadata (backward-compatible default `submitted`), surface status + submitted
   time + resubmit-if-rejected in the portal, and add an admin review API.

4. **Dashboard is a feed, not a "today" command center.** Enrich `/portal` with
   today's jobs (arrival time, address + navigation link, assigned crew,
   equipment/vehicle, dispatch instructions), a missing-required-actions
   checklist (confirm / uniform / clock), and a pay-period summary — all from
   fields the existing `/api/portal/routes` + `/tasks` already expose.

### Non-goals / boundaries
- Do **not** modify `app/lib/routes.ts` schema, the unified Operations calendar,
  Book Now, AI Command Center, or the customer booking flow.
- Clock/GPS reuse the Assignee fields already on `RouteRecord` via
  `mutateByConfirmToken` — consuming the interface, not redesigning it.
- No web-push transport exists (`crew-notify` degrades push → in-app); reminders
  stay in-app + SMS + email. Out of scope to add push here.
- Pay is computed live (no stored ledger); the portal pay view depends on
  admin-issued statements — unchanged.

## Test landscape
Node `node:test` suites in `scripts/*.test.ts`. Existing crew coverage:
`crew-comp`, `pay-statement-view`, `blob-tenant-paths`, `nav-config`, `rbac`,
`reminders`, `phaseb`/`phasec`. **No** tests today for `timeoff` rules,
`crew-availability` normalization, or clock/GPS. New suites: crew clock/GPS,
crew documents authorization, uniform review/resubmit, and a portal
authorization matrix.
