# 00 — System Architecture Overview

A 10-minute mental model. For depth, see [`../opspilot-os/`](../opspilot-os/)
(executive summary, domain model, target architecture).

## What Operion is

Operion is the operations OS behind J KISS Freight (a moving / box-truck-delivery
business) and its sibling deployments. It is a single **Next.js 16 (App Router)**
application on **Vercel**, written in TypeScript, React 19, Node ≥24. There is one
codebase; "businesses" (J KISS, Supercharged) are separate deployments of it.

```
                       ┌───────────────────────────────────────────────┐
   Public visitors ───▶│  Marketing + funnel (app/*: quote, booking,    │
                       │  book-now, careers, track, reviews, coi…)      │
                       └───────────────┬───────────────────────────────┘
                                       │ submits
                                       ▼
   Customers  ─ SMS/email ─▶  Communications layer (Twilio / Resend)
                                       ▲
                                       │ events
   ┌───────────────────────────────────┴───────────────────────────────┐
   │  Admin OS  —  "J KISS OS" / Operion  (app/admin/operations/*)       │
   │  Auth: HMAC-signed cookie session, RBAC (admin/manager/crew)        │
   │  Surfaces: Home, Schedule, Book Now, Operations, Messages, Crew,    │
   │            Businesses, Equipment, Claims, Pay, Settings,            │
   │            Platform (owner), AI Command Center (owner), Release     │
   └───────────────┬───────────────────────────────────────────────────┘
                   │ reads/writes
                   ▼
   Data: Vercel KV / Redis (app/lib/redis) · Vercel Blob (documents/photos)
   AI:  Vercel AI Gateway (all model calls, app/lib/*ai*)
   Pay: Stripe
```

## Layers

- **Public web** (`app/` top-level routes): quote flow, online booking ("Book Now"),
  careers, tracking, reviews, certificate-of-insurance, legal pages. Server + client
  components; some protected by BotID.
- **Admin OS** (`app/admin/operations/*`): the operator surface, rendered inside
  `OperationsShell` (floating dock on desktop, bottom nav on mobile). One design
  language lives in `app/admin/operations/ui.tsx` + `app/globals.css` (CSS variables
  `--card/--text/--muted/--line/--red`, `.os-card`, `.jkos`).
- **API** (`app/api/*`): route handlers. Admin routes gate through
  `app/api/admin/_lib/session.ts` (`requireStaffSession`, `requireAdmin`,
  `requirePlatformOwner`, `requirePermission`). RBAC matrix in `app/lib/rbac.ts`.
- **Domain libraries** (`app/lib/*`): bookings, routes, finance, comms, AI, claims,
  pay statements, tenancy, platform/updates.
- **Background workers** (`app/api/cron/*`): see below.
- **Persistence**: Vercel KV/Redis for records (JSON blob + zset index + counter
  pattern — no SQL, no schema migrations in the classic sense); Vercel Blob for files.

## Tenancy

A tenant-context layer exists (`app/lib/platform/tenancy/*`) and is **shipped flag-off**
in production (`TENANCY_ENABLED=false`). Today the app runs single-tenant against the
reference tenant; the tenancy layer shadow-reads/validates without changing live
responses. See doc 15 and `docs/opspilot-os/05-multi-tenant-architecture.md`.

## Background jobs (cron)

Declared in `vercel.json`; all protected by `CRON_SECRET`. Each advances durable,
lease-based work — safe to run every few minutes because jobs are idempotent.

| Path | Schedule (UTC) | Purpose | Runbook |
|------|----------------|---------|---------|
| `/api/cron/daily` | `0 14 * * *` | Daily housekeeping / digests | doc 08 |
| `/api/cron/reminders` | `*/5 * * * *` | Booking confirmation / morning reminders | doc 10, 11 |
| `/api/cron/ai-jobs` | `*/3 * * * *` | Book Now AI worker (analysis → pricing → quote) | doc 09 |
| `/api/cron/vision-shadow` | `*/10 * * * *` | Shadow vision-estimation jobs (non-authoritative) | doc 09 |
| `/api/cron/shadow-alerts` | `*/15 * * * *` | Read-only alerting over shadow jobs | doc 09 |
| `/api/cron/operion-reconcile` | `*/5 * * * *` | Reconcile platform deployment/update records | doc 16 |

## The two "Update Centers"

- **Platform console** (`/admin/operations/platform`, owner-only): the *write-capable*
  multi-tenant system-of-record (`app/lib/platform/updates/*`, Redis `platform:*`
  keys). Registers updates, tracks compatibility across businesses, records
  deployments. **Not** in this sprint's scope to change.
- **Release Center** (`/admin/operations/release`, admin-only): the *read-only*
  release/status view added by this sprint. Shows current build, flag states, and a
  curated release snapshot. It writes nothing and exposes no secrets.

## Deployment model

Git-push to Vercel builds a Preview per branch; production is a promotion of a
verified build. Rolling Releases are available on the platform. Deploy procedures are
docs 04–06. This documentation sprint performs **no** deploys.
