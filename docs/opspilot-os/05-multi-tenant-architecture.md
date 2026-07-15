# 05 — Multi-Tenant SaaS Assessment (Phase 4)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12; **tenancy status
> re-verified 2026-07-14** (branch `redesign/book-now-dashboard` = `main`
> `9b0ce99`). The platform is branded **Operion**; the internal `opspilot:`
> Redis prefix, `/api/opspilot/*` routes, and `app/lib/platform/` paths are
> preserved verbatim as **legacy internal ids**.

## 1. Classification (FACT) — _(Updated 2026-07-14: this is now the "S1" state)_

**Single-company / single-tenant-per-deployment at the DATA level, but with the
tenant CONTEXT layer now IMPLEMENTED and dormant (fail-closed) behind a flag.**
The 2026-07-12 statement that "no request carries a tenant identity" is **stale**.
Classify precisely:

- **IMPLEMENTED (context wiring, on `main` + prod).** A per-request tenant
  context is established by `withTenantRoute` (`app/lib/platform/tenancy/with-tenant-route.ts`)
  on **104 API handlers**, and by `withBackgroundTenant` on **3 crons + 3
  webhooks** (`api/cron/{daily,reminders,ai-jobs}`, `api/webhooks/{email,twilio/sms,twilio/status}`).
  Every Redis key now routes through `scopeKey()` in `app/lib/redis.ts:53`, which
  **fails closed** (throws) if the flag is on without a resolvable context.
  Resolution is trusted-source-only (signed session, never a header/body). A
  blocking CI gate (`scripts/bypass-detection.test.ts`) forbids any second path
  to the raw KV credentials or a hand-built prefix.
- **Live no-op today.** `TENANCY_ENABLED=false` (`platform/flags.ts:29`) so
  `scopeKey()` returns the key **unchanged** — wrapping is **byte-identical** to
  the pre-2026-07-14 behavior. Data is still one global namespace.
- **DARK-LAUNCH READY / NOT YET VERIFIED.** An isolated dark-launch **Preview**
  environment is provisioned — a separate Upstash Redis (`OperionPreview`) + Blob
  (`operion-preview-blob`), with Preview-only `TENANCY_ENABLED=false` +
  `TENANCY_DARK_LAUNCH=true`, data-isolated from Production. The shadow-compare
  path (`platform/tenancy/dark-launch.ts`, `keys.ts` `compareLegacyAndTenantKey`)
  exists but has **not been exercised** end-to-end — no browser walkthrough has
  been run to inspect `tenancy:dark-launch-mismatch`. So this is **ready, not yet
  verified**; that walkthrough is the next verified step.
- **Still absent (PROPOSED).** There is **no tenant/organization *record*** yet;
  `tenantId()` (`app/lib/tenant.ts:8-12`) still only stamps AI telemetry/cost and
  does not select any per-tenant credential. Fork-and-reskin remains today's
  productization path — the sister deployment (`~/supercharged`, out of scope) is
  a hand-forked clone with `company.ts` re-valued and brand recolored.
- **BLOCKED (activation).** Flipping `TENANCY_ENABLED=true` is gated on the
  blockers in §5a below.

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
| Database filters | _(Updated 2026-07-14)_ `scopeKey()` chokepoint now WIRED but **dormant** (`TENANCY_ENABLED=false` → keys unchanged) | activation = flip flag after §5a blockers |
| Storage paths | Blob paths not tenant-prefixed | Medium |
| Env vars (credentials) | all read from `process.env` in shared modules | **High** (needs request context) |
| Hardcoded IDs | owner default email `timmothy@jkissllc.com` (`owner-alerts.ts:29`) | Low |
| Admin privileges | shared `ADMIN_PASSWORD` owner path | Medium (replace w/ per-user) |

## 3. The two chokepoints that make this tractable (FACT — now wired)

| Surface | Chokepoint | Status (2026-07-14) |
|---|---|---|
| **Data isolation** | `scopeKey()` on every op in `app/lib/redis.ts:53` (was `call()`) | ✅ **WIRED, dormant.** All keys pass through `scopeKey()`; prefixes when `TENANCY_ENABLED=true` + context present, else returns unchanged. Fails closed on flag-without-context |
| **Authorization** | tenant context via `withTenantContextFromRequest` / `withTenantRoute` (signed session) | ✅ **WIRED** on 104 handlers. The session `tid` claim + context replace the old "add `tenantId` to the principal" plan |

_(Updated 2026-07-14)_ **The two former bypass files are now migrated.**
`app/api/track/route.ts` and `app/api/admin/analytics/route.ts` previously used
their own inline fetch; both now import `redis` and are wrapped in
`withTenantRoute`. The `bypass-detection` CI test asserts exactly this — `lib/redis.ts`
is the **only** file allowed to touch the raw KV credentials, `platform/tenancy/keys.ts`
is the **only** file allowed to build a tenant prefix, and both former bypass
files must import the wrapper.

## 4. Recommended tenancy model — _(Updated 2026-07-14: ADOPTED, context layer built)_

**Pooled multi-tenancy on shared Redis, isolated by key prefix `t:{tenantId}:`,
with a request-scoped `AsyncLocalStorage` tenant context.** This is no longer
just a recommendation — the **context layer is built** (`platform/tenancy/context.ts`
`AsyncLocalStorage`, `keys.ts` prefix, `with-tenant-route.ts`) and the reference
tenant resolves **byte-identical to today** while the flag is off. Not
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

_(Updated 2026-07-14: the "Row-level security" and "Server-side authz" rows are
now **wired but dormant** — see §1/§3. The remaining rows, especially Storage
isolation, AI context isolation, and per-tenant credentials, are the §5a
activation blockers.)_

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

## 5a. Activation blockers — before flipping `TENANCY_ENABLED=true` (FACT)

> **Update 2026-07-15** (branch `feat/operion-tenant-safe-boundaries`, dark-launch, not
> merged): most of these blockers now have their code boundaries built and inert
> (`TENANCY_ENABLED=false` → byte-identical). **Blob** paths → `scopeBlobPath` at 5 write
> sites (legacy objects still readable; bulk migration planned, not run —
> `tenant-isolation/08-blob-migration-plan.md`). **Stripe webhook** → `tenantId` in
> Checkout metadata + `resolveTenantFromStripe` + `withBackgroundTenant`. **Public token
> routes** → `resolveTenantFromResource` (representative set; rest enumerated). **AI audit
> read** → tenant-filtered when enabled (H-AI-2). **Name-derived keys** → `biz:*`/`learn:*`
> already isolated by the chokepoint; the residual `Staff.payByBusiness` value key remains
> MIGRATION-REQUIRED. New canonical primitives: `blob-keys.ts`, `tenant-resolve.ts`. See
> `CHANGELOG.md` (2026-07-15). What remains before a flip: execute the Blob + name-key
> migrations, finish the remaining public token routes, and pass dark-launch validation.

_(Added 2026-07-14.)_ The context layer is wired and dormant; **data-level
activation is BLOCKED** on the following, each of which would otherwise cause a
silent cross-tenant leak or a fail-closed outage:

1. **Blob paths not tenant-scoped.** File storage is one global namespace; Blob
   keys need a `t/{tid}/…` prefix + re-seal of legacy objects before activation.
2. **`ai:*` prompts + telemetry are platform-global (shared).** They sit on the
   platform-global allowlist (`platform/tenancy/keys.ts:18`) by design today, so
   prompts/telemetry are **not** tenant-isolated — must be split before per-tenant
   AI metering/retrieval is trustworthy.
3. **Name-derived key collisions.** `businesses.ts` derives `bizKey` from the
   business *name* and `staff.ts` uses it as a **map key** inside `payByBusiness`;
   `job-learning.ts` similarly keys global `learn:*` calibration. Prefixing the
   Redis key alone does **not** fix these embedded map keys (see doc 04 §2).
4. **Tenant data migration must run under `DARK_LAUNCH → DUAL_WRITE`.** Existing
   global keys must be copied into `t:{tid}:` scope with the shadow-compare
   (`TENANCY_DARK_LAUNCH`) validated first, then `TENANCY_DUAL_WRITE`, before the
   cutover — this is the **NOT YET VERIFIED** step from §1.
5. **Public routes need host-based resolution.** Pooled public (non-session)
   routes have no signed tenant to resolve from; they need host/subdomain →
   tenant resolution before they can run under a real tenant scope.

Until all five are closed, `TENANCY_ENABLED` stays `false` and the wiring remains
a no-op. Deep: `../opspilot-os/09-data-architecture.md` + the `tenant-isolation`
test suite.

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
