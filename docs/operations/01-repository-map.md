# 01 — Repository Map

Where things live. Complements `docs/opspilot-os/02-repository-map.md` (strategy-level);
this is the operator's quick lookup.

```
jkissllc/
├─ app/
│  ├─ (public routes)         quote/ booking/ book-now (see app/book…)/ careers/
│  │                          track/ reviews/ coi/ safety/ about/ terms/ privacy/
│  ├─ admin/                  Admin OS entry
│  │  ├─ AdminGate.tsx        thin wrapper → OperationsShell
│  │  ├─ useAdminSession.ts   client auth state (session check, login, idle logout)
│  │  ├─ layout.tsx           noindex metadata for the whole admin tree
│  │  └─ operations/          the OS surfaces (one folder per module)
│  │     ├─ OperationsShell.tsx   nav shell (desktop dock + mobile bottom nav + More)
│  │     ├─ nav-config.ts         PURE nav model (role-aware, unit-tested)
│  │     ├─ ui.tsx                shared design-language primitives (Stat, chips, styles)
│  │     ├─ page.tsx              Home
│  │     ├─ schedule/ book-now/ list/ messages/ communications/
│  │     ├─ employees/ businesses/ equipment/ claims/ pay-statements/
│  │     ├─ settings/ platform/ ai/            (settings/platform/ai are admin/owner)
│  │     └─ release/              ← Release Center (this sprint, read-only, admin-only)
│  ├─ api/
│  │  ├─ admin/                   admin-gated route handlers
│  │  │  ├─ _lib/session.ts       auth chokepoint (requireStaffSession/Admin/PlatformOwner)
│  │  │  ├─ platform/             owner Update Center API (updates, deployments, automation)
│  │  │  └─ release/              ← Release Center API (this sprint, GET-only)
│  │  ├─ cron/                    background workers (daily, reminders, ai-jobs, …)
│  │  ├─ book/ booking/ intake/   booking + Book Now intake
│  │  ├─ webhooks/                Stripe / Twilio / email inbound
│  │  └─ ai/ estimate/ quote/…    AI + pricing endpoints
│  ├─ lib/
│  │  ├─ company.ts               brand / contact constants
│  │  ├─ rbac.ts                  role → permission matrix
│  │  ├─ redis.ts                 KV/Redis client
│  │  ├─ bookings.ts routes… finance… claims… comms/… booking-notify.ts
│  │  ├─ book-now-ai.ts book-now-confirmation.ts   AI worker logic
│  │  ├─ platform/
│  │  │  ├─ flags.ts              ← feature-flag source of truth
│  │  │  ├─ tenancy/              tenant context (flag-gated)
│  │  │  └─ updates/              owner Update Center data model (types/store/policy)
│  │  └─ release/                 ← Release Center data service (this sprint)
│  ├─ components/                 shared React components
│  └─ globals.css                 design tokens + base styles
├─ scripts/                       *.test.ts (node:test via tsx) + eval/util scripts
├─ docs/
│  ├─ opspilot-os/                architecture strategy (authoritative)
│  └─ operations/                 ← this folder: operator manual + release docs
├─ public/                        static assets
├─ vercel.json                    cron schedule
├─ next.config.ts  proxy.ts  eslint.config.mjs  tsconfig.json
└─ package.json                   scripts: dev/build/lint/test/test:ai/predeploy
```

## Key conventions

- **Storage pattern**: records are a JSON blob at `prefix:{id}`, indexed in a zset
  `prefix:index`, with an `incr` counter for ids (see `app/lib/platform/updates/store.ts`,
  `bookings.ts`). No SQL; "migrations" are shape/version changes on these blobs
  (`recordVersion` fields) — see doc 07.
- **Auth**: never inline role-string checks. Route handlers call a guard from
  `app/api/admin/_lib/session.ts`; UI hiding is convenience only, the server gate is
  the control.
- **Design language**: import from `app/admin/operations/ui.tsx`; don't re-define
  colors/formatters locally. CSS variables come from `app/globals.css`.
- **Tests**: `scripts/*.test.ts` run under `node:test` via `tsx`. Pure modules
  (e.g. `nav-config.ts`, `flags.ts`) are unit-tested directly.
