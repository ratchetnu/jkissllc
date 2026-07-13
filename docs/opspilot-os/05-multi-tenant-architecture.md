# 05 — Multi-Tenant SaaS Assessment (Phase 4)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12.

## 1. Classification (FACT)

**Single-company / single-tenant-per-deployment**, with latent scaffolding.

Not "loosely multi-company," not "partially multi-tenant": there is **no tenant
or organization record**, and **no request carries a tenant identity** that
scopes data or credentials. `tenantId()` (`app/lib/tenant.ts:8-12`) exists but
only stamps AI telemetry/cost — it does not prefix any Redis key or select any
credential.

Evidence of the current model being **fork-and-reskin**: the sister deployment
(`~/supercharged`, out of scope here) is a hand-forked clone with `company.ts`
re-valued and brand recolored. Productization today = copy the repo + stand up
new infra.

## 2. Where J KISS assumptions live (FACT — inventory)

| Assumption type | Location | Isolation difficulty |
|---|---|---|
| Company name / DOT / MC / phone / address | Centralized `app/lib/company.ts`; **but** DOT/MC in ~17 raw literals, phone in ~12 | Low (mechanical) |
| Branding color | `--red` at `app/globals.css:15` **and** `#E0002A` re-hardcoded in 15+ TS/TSX | Low-Medium (wide) |
| Email FROM / ops recipients | `app/lib/booking-emails.ts` (frozen at module scope) | Low |
| SMS bodies / 16 canned templates | `app/lib/route-notify.ts`, `app/admin/messaging.tsx`, `bookings/page.tsx` | Low-Medium |
| Cancellation policy default | `app/lib/policy.ts` — a new tenant would be served J Kiss's policy | Low |
| Contractor disclaimer | `app/lib/routes.ts` `CONFIRM_DISCLAIMER` (legally binding) | Low (but review legal per-tenant) |
| Service types / catalog | `app/lib/services.ts` (icons compile-time), `ats-config.ts` (TS unions) | **High** (compile-time coupling) |
| Prices / pay rates | `disposal.ts` `DEFAULT_DISPOSAL`, `ats-config.ts` payPerDay | Medium (Redis merge for disposal; hardcoded for ATS) |
| Vehicle assumption | `app/admin/operations/new/page.tsx:10` `const VEHICLE='Box truck'` | Low |
| Cities / service area | `app/lib/cities.ts` drives `generateStaticParams` | **High** (per-tenant static generation) |
| Timezone | `app/lib/analytics.ts` `TZ='America/Chicago'` | Low |
| Job statuses / load units | `bookings.ts` status set, `availability.ts` LOAD_UNITS | Medium |
| Route terminology | scattered (route/operation/assignment) | Low (UX) |
| Database filters | **none** — no tenant filter exists yet | (the migration) |
| Storage paths | Blob paths not tenant-prefixed | Medium |
| Env vars (credentials) | all read from `process.env` in shared modules | **High** (needs request context) |
| Hardcoded IDs | owner default email `timmothy@jkissllc.com` (`owner-alerts.ts:29`) | Low |
| Admin privileges | shared `ADMIN_PASSWORD` owner path | Medium (replace w/ per-user) |

## 3. The two chokepoints that make this tractable (FACT)

| Surface | Chokepoint | Leverage |
|---|---|---|
| **Data isolation** | `call()` in `app/lib/redis.ts:17-34` | Prefix keys here → covers all 21 lib modules in one change |
| **Authorization** | `getPrincipal()` in `app/api/admin/_lib/session.ts:140-145` | Add `tenantId` to the principal → all guards become tenant-aware |

**But two files bypass the Redis chokepoint** with their own inline fetch and
must be hand-migrated: `app/api/track/route.ts`, `app/api/admin/analytics/route.ts`.

## 4. Recommended tenancy model (RECOMMENDATION)

**Pooled multi-tenancy on shared Redis, isolated by key prefix `t:{tenantId}:`,
with a request-scoped `AsyncLocalStorage` tenant context.** Not
deployment-per-tenant (doesn't scale operationally), not a database-per-tenant
(Redis has no such notion here). Rationale:

- Preserves the current stack and the single chokepoint advantage.
- `AsyncLocalStorage` is the only option that avoids rewriting ~40 credential
  call-site signatures (`stripe.ts`, `sms.ts`, `redis.ts` all read `process.env`
  at call time with no request context today).
- Seed `t:jkiss` **byte-identical to today** so tenant #0 is unchanged.

### Tenant record (target)
```
Tenant {
  id            // opaque short — the Redis prefix
  slug          // subdomain / vanity
  displayName
  legal         { dotNumber, mcNumber, address, phone, supportEmail }
  brand         { primaryColor, logoUrl, emailFromAddress }
  industryPack  // ref → 06
  credentials   // per-tenant Stripe(Connect)/Twilio/Resend refs → §6
  plan          // → billing
  status        // trialing | active | suspended
}
```

### Role model (target — extends current 3 roles)
Current: `admin | manager | crew`. Target adds the roles the product vision
needs, mapped onto the existing matrix so today's behavior is preserved:

| Vision role | Maps to / adds |
|---|---|
| Platform owner | **NEW** — cross-tenant super-role (you) |
| Organization owner | `admin` (rename to `owner` internally) |
| Administrator | `admin` |
| Manager | `manager` |
| Dispatcher / ops | **NEW** split from manager (routes/crew/messaging, no finance) |
| Office staff | **NEW** (read + comms) |
| Crew member | `crew` |
| Independent contractor | `crew` (compensation-aware) |
| Customer | token-based (no session role) |
| Configurable roles | **NEW** — tenant-defined role → permission-set |

## 5. Isolation checklist (RECOMMENDATION — each maps to a migration step)

| Layer | Today | Target |
|---|---|---|
| Organization IDs | none | `Tenant.id` |
| Membership records | none | `Membership(User×Tenant×Role)` |
| Role assignment | on token | on membership, tenant-scoped |
| Permission evaluation | `can(role, perm)` | `can(membership.role, perm)` under tenant ctx |
| Row-level security | none (Redis) | key-prefix `t:{tid}:` in `call()` |
| Server-side authz | `requireSession` (partial) | `requireTenantSession` returns `{tenantId,userId,role}` |
| Storage isolation | Blob paths global | `t/{tid}/...` prefix + re-seal legacy |
| API isolation | shared | tenant resolved in `proxy.ts` → context |
| Webhook isolation | global secrets | per-tenant discriminator in inbound URL/secret |
| Background-job isolation | one cron | per-tenant fan-out (mind Vercel cron limits) |
| AI context isolation | tenant stamped, not filtered | tenant-scoped retrieval + prompt vars |
| Analytics isolation | global (`pv:*`/`uv:*`) | tenant-prefixed + migrate bypass files |
| Audit isolation | global `audit:*` | tenant-prefixed + attributed to `userId` |

## 6. Credentials plan (RECOMMENDATION)

| Env var | Disposition |
|---|---|
| `ADMIN_PASSWORD` | Retire → per-user hashed creds |
| `ADMIN_SESSION_SECRET` | Global signing key; payload carries tenant |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | **Per-tenant via Stripe Connect** (see `07`/`18`) |
| `STRIPE_PERCENT_FEE` / `STRIPE_FIXED_FEE_CENTS` | Per-tenant |
| `RESEND_API_KEY` | Global key + per-tenant verified sending domain |
| `TWILIO_*` (7) | Per-tenant subaccounts + sending number |
| `KV_REST_API_*` | Global; isolation via key prefix |
| `NEXT_PUBLIC_SITE_URL` | ⚠️ **Blocker** — build-time-inlined; drop the `NEXT_PUBLIC_` prefix → server lookup (`app/lib/booking-emails.ts:12`, `route-notify.ts:11`, `careers/apply`) |
| `PUBLIC_BASE_URL` | Per-tenant (server-only) |
| `OWNER_*` alerts | Per-tenant (already Redis-overridable via `settings:owner_alerts`) |
| `COI_BROKER_EMAIL`, `GOOGLE_*` | Per-tenant |
| `AI_GATEWAY_API_KEY` / `AI_MODEL` | Global platform-owned; add per-tenant AI metering |
| `CRON_SECRET`, `EMAIL_WEBHOOK_SECRET` | Global signing; tenant via URL discriminator |
| `BLOB_READ_WRITE_TOKEN` | Global store; tenant-prefix paths |

## 7. Do-not-rely-on-frontend-hiding (FACT — mostly honored already)

The current code already enforces server-side (`proxy.ts` edge gate + per-route
guards + `requireCrew`), and `OperationsShell.tsx:12-13` explicitly documents
that nav hiding is cosmetic and APIs are gated server-side. The one weakness is
the **enforcement drift** (§03) — some permissions are hidden in the UI but not
checked on the server. That must be closed as part of tenancy work.
