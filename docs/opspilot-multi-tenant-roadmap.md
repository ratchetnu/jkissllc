# OpsPilot — Multi-Tenant SaaS Roadmap

> ⚠️ **SUPERSEDED (2026-07-17).** This document reflects the codebase as of
> **2026-07-08**, when it had *"zero tenancy primitives."* That premise is now
> **out of date**: the tenancy foundation has since been built and merged to `main`
> (Redis + Blob chokepoints wired, RBAC matrix, session-carried tenant identity, 138
> `withTenantRoute`-wrapped routes) and sits dormant behind `TENANCY_ENABLED=false`.
> For the **current** verified state, the domain classification, the highest-risk
> remaining items, and the phased plan, read
> **`docs/opspilot-os/tenant-isolation/audits/2026-07-17-multitenant-readiness-audit.md`**.
> The analysis below is retained for its still-accurate key inventory and rationale,
> but its "nothing exists yet" framing no longer holds.

> **Status: planning only. No migration has been performed.**
> This document exists so that when the migration does happen, nobody has to
> rediscover where the landmines are. Every claim below is cited to `file:line`
> against the codebase as of 2026-07-08. Nothing here changes runtime behavior.

J KISS LLC is tenant #0. It is also, today, a hard-coded assumption in roughly
thirty files. This document catalogs exactly where, so the migration is a
sequence of mechanical steps rather than an archaeology project.

---

## 0. The honest summary

The application has **zero tenancy primitives**. There is no tenant model, no
organization, no user record, no role, no permission, no subscription. Auth is a
single shared password compared against an env var. All ~34 Redis key namespaces
are global.

The good news is that the blast radius is concentrated:

| Surface | Where it funnels through | Migration leverage |
|---|---|---|
| Data isolation | `app/lib/redis.ts` `call()` | **High** — one wrapper covers 21 lib files |
| Authorization | `requireSession()` in `app/api/admin/_lib/session.ts` | **High** — 36 of 38 admin routes call it |
| Identity/branding | ~30 files, string literals | **Low** — mechanical but wide |
| Credentials | `process.env.*` read at call time inside shared modules | **Low** — needs request context |

Two of those are single chokepoints. That is the whole reason this migration is
tractable.

---

## 1. Pre-existing defects to fix *before* multi-tenancy

These are bugs **today**, with one tenant. Multi-tenancy makes each of them
dramatically worse. Fix them first; they are independently worth doing.

### 1.1 Duplicate human-readable invoice IDs
Two independent counters both mint the `JK-INV-` prefix:
- `app/lib/bookings.ts:271` — `nextInvoiceNumber()` off `bk:invcounter`
- `app/lib/route-invoices.ts:57` — `nextInvoiceNumber()` off `rt:inv:counter`

A booking invoice and a route invoice can carry the identical human ID. Two
functions, same name, same prefix, different sequences.

### 1.2 The ID-generation fallback destroys uniqueness
All six generators share this pattern:
```ts
try { n = await redis.incr(KEY_COUNTER) } catch { n = Date.now() % 100000 }
```
`app/lib/bookings.ts:266`, `app/lib/routes.ts:199`, `app/lib/route-invoices.ts:58`,
`app/lib/claims.ts:620`, `app/lib/applicants.ts:91`.

On a Redis hiccup this yields a number that can collide with an existing
sequential ID, and the caller then silently overwrites the `bk:num:{dup}` → token
mapping (`app/lib/bookings.ts:300`). Under multi-tenant load, far likelier.

### 1.3 Non-constant-time password comparison
`app/api/admin/auth/route.ts:70`:
```ts
if (password !== process.env.ADMIN_PASSWORD) {
```
A plain `!==` on a secret. The HMAC path immediately adjacent does this correctly
with `timingSafeEqual` (`app/api/admin/_lib/session.ts:48`). This disappears
entirely once auth becomes per-user hashed credentials (§4), but it should not
wait for that.

### 1.4 Applicant PII in a public blob store — FIXED on `hardening`
The ATS requires a `ss_card` document (`app/lib/ats-config.ts:69`, *"Used for
onboarding and payroll if hired"*), alongside `drivers_license` and `id`. These were
written to Vercel Blob with `access: 'public'`.

Two corrections to an earlier draft of this section, both worth recording because
they changed the severity:
- The paths were **not** guessable. `app/api/careers/upload/route.ts` uses
  `driver-docs/${kind}/${crypto.randomUUID()}.${ext}`.
- The `upload(file.name, …)` at `app/admin/bookings/page.tsx:1045` is **admin invoice
  photos**, not applicant documents, and its token broker sets `addRandomSuffix: true`
  behind `requireSession`. That path was never the problem.

The real exposure was narrower but real: a Social Security card image, permanently
readable by anyone who ever obtained the URL — a forwarded email, a browser history,
a log line. No auth, no expiry.

**Fixed** by sealing identity documents with AES-256-GCM before upload
(`app/lib/doc-crypto.ts`); the object at its public URL is ciphertext, and only
`/api/admin/careers/doc` decrypts, for a signed-in admin. Note `put(..., { access:
'private' })` is *rejected* on this store ("Cannot use private access on a public
store"), which is why encryption rather than a private blob.

Still outstanding:
- Documents uploaded **before** that change are plaintext at public URLs and need a
  one-time re-seal.
- The store should still be reconfigured for private access, as a second layer.
- `app/api/upload/route.ts` (customer quote photos) remains public and unsealed —
  intentional, but revisit if quote photos ever capture documents.
- Blob paths are not tenant-prefixed, so this is a cross-tenant surface after
  migration as well as a per-tenant one.

---

## 2. Data isolation — the Redis key inventory

**None of the following are tenant-scoped.** The full inventory, because
tenant-prefixing these *is* the core migration.

| Namespace | Key patterns | Defined at |
|---|---|---|
| Bookings | `bk:{token}`, `bk:num:{N}`, `bk:index`, `bk:counter`, `bk:invcounter` | `app/lib/bookings.ts:249-253` |
| Routes | `rt:{token}`, `rt:num:{N}`, `rt:index`, `rt:counter`, `rt:atok:{t}` | `app/lib/routes.ts:185-189` |
| Route templates | `rt:tpl:{id}`, `rt:tpl:index` | `app/lib/route-templates.ts:82-83` |
| Route invoices | `rt:inv:{token}`, `rt:inv:num:{N}`, `rt:inv:index`, `rt:inv:counter` | `app/lib/route-invoices.ts:47-50` |
| Client portals | `rt:client:{token}`, `rt:client:index` | `app/lib/client-portal.ts:26-27` |
| Claims | `clm:{id}`, `clm:num:{N}`, `clm:index`, `clm:counter` | `app/lib/claims.ts:610-613` |
| Applicants | `app:{id}`, `app:num:{N}`, `app:index`, `app:counter` | `app/lib/applicants.ts:78-81` |
| Messages | `msg:{id}`, `msg:index`, `msg:unread`, `msg:booking:{t}`, `msg:phone:{e164}`, `msg:pid:{id}` | `app/lib/messages.ts:56-61` |
| Staff | `staff:{id}`, `staff:index` | `app/lib/staff.ts:46-47` |
| Businesses | `biz:{bizKey}`, `biz:index` | `app/lib/businesses.ts:41-43` |
| Promos | `promo:{code}`, `promo:index` | `app/lib/promo.ts:21-22` |
| Shipments | `ship:{bol}`, `ship:index` | `app/lib/shipments.ts:18-19` |
| Site reviews | `rv:{token}`, `rv:index` | `app/lib/site-reviews.ts:16-17` |
| Policy | `policy:current`, `policy:v:{n}` | `app/lib/policy.ts:13-14` |
| Config | `cfg:disposal`, `cfg:blackout`, `cfg:capacity`, `cfg:deposit` | `app/lib/disposal.ts:101`, `app/lib/availability.ts:26-28` |
| Settings | `settings:owner_alerts`, `settings:finance` | `app/lib/owner-alerts.ts:15`, `app/lib/finance.ts:46` |
| AI calibration | `learn:jobs`, `learn:calibration` | `app/lib/job-learning.ts:41-42` |
| SMS opt-out | `sms:optout:{e164}` | `app/lib/sms.ts:54` |
| Rate limit | `rl:{bucket}:{ip}`, `rl:adminfail:{ip}` | `app/lib/rate-limit.ts:29`, `app/api/admin/auth/route.ts:21` |
| Analytics | `pv:total`, `pv:day:{d}`, `pv:paths`, `pv:referrers`, `uv:total`, `uv:day:{d}` | `app/api/track/route.ts:28-38` |
| **OpsPilot platform** | `opspilot:waitlist:{email}`, `opspilot:waitlist:index` | `app/lib/opspilot-waitlist.ts:23-24` |

### 2.1 The leverage point
`app/lib/redis.ts:7-24` — `call()` is a raw passthrough that never rewrites the
key. Injecting a tenant prefix **inside `call()`** covers all 21 files that
`import { redis } from './redis'` in one change.

### 2.2 …and the two files that bypass it
`app/api/track/route.ts:3-9` and `app/api/admin/analytics/route.ts` each define
their **own** inline Upstash fetch helper. Wrapper-level prefixing will silently
miss them, and pageview/visitor data will stay commingled. **These must be
hand-migrated.**

### 2.3 Keys derived from user-supplied strings — the hard collisions
Prefixing fixes namespace hygiene. It does **not** fix these:

- **`biz:{bizKey}`** — `bizKey` is derived from the business *name*
  (`app/lib/businesses.ts:41`). Two tenants hauling for "Rooms To Go" write to
  the same key and overwrite each other's contract rates. Worse, `bizKey` is also
  used as a **map key inside persisted staff records** —
  `Staff.payByBusiness: Record<string, number>` (`app/lib/staff.ts:36`). Prefixing
  the Redis key does not fix the embedded map keys. **Requires a data migration.**
- **`promo:{code}`** — tenant A's `SAVE20` overwrites tenant B's.
- **`ship:{bol}`** — externally-supplied Bill of Lading numbers.
- **`msg:phone:{e164}`** — two tenants texting the same consumer number merge
  threads. A cross-tenant conversation leak.
- **`learn:jobs` / `learn:calibration`** (`app/lib/job-learning.ts:41-42`) — the
  pricing model's calibration state is global. **Tenant A's job outcomes would
  train tenant B's price estimator.** Data-leak *and* pricing-integrity defect.

### 2.4 Tokens are unscoped bearer credentials
`getBookingByToken` (`app/lib/bookings.ts:282`), `getRouteByToken`
(`app/lib/routes.ts:363`), `getInvoiceByToken` (`app/lib/route-invoices.ts:63`),
`getPortal` (`app/lib/client-portal.ts:36`) validate a regex and hit Redis
directly. Tokens are unguessable CSPRNG (fine), but with a shared Redis a valid
token resolves under *any* tenant's request context until the key itself is
prefixed.

### 2.5 No `SCAN`
`app/lib/redis.ts:26-57` exposes only `GET/SET/DEL/ZADD/ZREVRANGE/ZREM/INCR/
PEXPIRE/ZCARD/ZRANGE`. The backfill script that rewrites `bk:*` → `t:{tid}:bk:*`
**cannot be written against this client** and must go direct to Upstash.

---

## 3. The organization model (to be built)

Nothing below exists yet.

```
Tenant
  id                 stable, opaque, short  (the Redis prefix: t:{id}:)
  slug               subdomain / vanity
  displayName        "J KISS LLC"          → replaces every hardcoded literal (§6)
  legal              { dotNumber, mcNumber, address, phone, supportEmail }
  brand              { primaryColor, logoUrl, emailFromAddress }
  credentials        → §5
  plan               → §7
  createdAt, status  active | suspended | trialing
```

Seed `t:jkiss` from the current literals so tenant #0 is byte-identical to today.

---

## 4. Auth, users, roles, permissions (to be built)

### 4.1 What exists
`app/api/admin/_lib/session.ts:7` — the entire session payload:
```ts
type SessionPayload = { iat: number; exp: number; idleExp?: number }
```
No `sub`. No `userId`. No `tenantId`. No `role`. `createSessionToken()`
(`:82-85`) takes **no arguments**. `verifySessionToken()` (`:87-90`) returns a
`boolean`, not a principal. `requireSession(req)` (`:122-125`) returns
`Promise<boolean>` and is the *only* authorization primitive in the codebase.

The token proves exactly one thing: *someone knew the shared password recently.*

Consequences today:
- Every audit entry records the actor as the literal string `'admin'` —
  `app/lib/routes.ts:27` (`actor: string // 'admin' | 'contractor' | 'system'`),
  written at `app/lib/routes.ts:301` as `pushAudit(r, 'admin', …)`. There is no
  way to know *which* human did anything. A hard blocker for a multi-user tenant.
- `COOKIE_NAME = 'jk_admin_session'` (`session.ts:3`) is tenant-agnostic and would
  collide across tenants on a shared apex domain.
- `ADMIN_SESSION_SECRET` (`session.ts:29`) is one global HMAC key, so a token
  minted for tenant A is byte-identical to one for tenant B.

### 4.2 Target
```ts
// Replaces requireSession(). Returns the principal, never a bare boolean.
requireTenantSession(req): Promise<{ tenantId, userId, role } | null>
```
- `SessionPayload` gains `sub` (userId), `tid` (tenantId), `role`.
- `User` model: id, tenantId, email, passwordHash (argon2/bcrypt — **not** a
  plaintext env compare), status.
- Roles, minimum viable: `owner` | `dispatcher` | `viewer`.
  - `owner` — everything, incl. finance, payroll, settings, billing
  - `dispatcher` — routes, crew, messaging, claims; **no** finance/payroll
  - `viewer` — read-only
- Permissions: start with role checks at the route handler. Do not build a policy
  engine before there is a second tenant asking for one.
- `pushAudit(r, actor, …)` takes a real `userId`. Backfill existing `'admin'`
  entries as `'legacy:admin'` rather than pretending they resolve.

Because 36 of 38 admin routes already funnel through `requireSession`
(the only exceptions being `auth/route.ts` and `logout/route.ts`, correctly),
this is a **single-signature change plus 36 call-site updates**.

---

## 5. Credentials — per-deployment → per-tenant

Every credential is read at call time from `process.env` inside a shared module:
`getStripe()` (`app/lib/stripe.ts:6-10`), `authPair()` (`app/lib/sms.ts:11-19`),
`call()` (`app/lib/redis.ts:7-24`). **No request context is threaded through.**

That means per-tenant credentials require *either*:
- an `AsyncLocalStorage` tenant context established in middleware, **or**
- changing ~40 function signatures to accept a tenant/credentials param.

Recommend `AsyncLocalStorage` — it is the only option that doesn't rewrite every
lib call site.

| Env var | Disposition |
|---|---|
| `ADMIN_PASSWORD` | **Delete.** Replaced by per-user hashed credentials (§4). |
| `ADMIN_SESSION_SECRET` | Stays global (signing key); payload carries tenant. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | **Per-tenant** → Stripe Connect (§7). |
| `STRIPE_PERCENT_FEE` / `STRIPE_FIXED_FEE_CENTS` | **Per-tenant** — negotiated rates differ. |
| `RESEND_API_KEY` | Global key + **per-tenant verified sending domain**. |
| `TWILIO_*` (7 vars) | **Per-tenant** — subaccounts. Sending number is per-tenant. |
| `KV_REST_API_URL` / `_TOKEN` | Global; isolation via key prefix (§2). |
| `NEXT_PUBLIC_SITE_URL` | ⚠️ **Blocker.** See below. |
| `PUBLIC_BASE_URL` | Per-tenant (server-only, so straightforward). |
| `OWNER_SMS` / `OWNER_EMAIL` / `OWNER_ALERT_*` | Per-tenant; already Redis-overridable (`settings:owner_alerts`), env is only a default. |
| `COI_BROKER_EMAIL` | Per-tenant — each carrier has their own broker. |
| `GOOGLE_REVIEW_URL` / `GOOGLE_PLACE_ID` | Per-tenant. |
| `GOOGLE_PLACES_API_KEY` / `AI_GATEWAY_API_KEY` / `AI_MODEL` | Global (platform-owned). Per-tenant AI metering is a new requirement. |
| `CRON_SECRET` | Global — but see §8. |
| `EMAIL_WEBHOOK_SECRET` | Per-tenant, or add a tenant discriminator to the inbound URL. |
| `BLOB_READ_WRITE_TOKEN` | Global store. **Paths are not tenant-prefixed** — see §1.4. |

### 5.1 `NEXT_PUBLIC_SITE_URL` is a genuine blocker
Used at `app/lib/booking-emails.ts:12`, `app/lib/route-notify.ts:11`,
`app/api/careers/apply/route.ts:23`. The `NEXT_PUBLIC_` prefix means it is
**inlined into the client bundle at build time** and therefore cannot vary per
tenant at runtime. It must lose the prefix and become a server-side lookup before
tenant-specific URLs are possible.

Note also an existing inconsistency: `booking-emails.ts:12` defaults to
`https://www.jkissllc.com` while `route-notify.ts:11` defaults to
`https://jkissllc.com` (no `www`).

### 5.2 Capability flags become per-tenant
`smsConfigured()` (`app/lib/sms.ts:21-27`) and `stripeConfigured()`
(`app/lib/stripe.ts:12-14`) return global booleans, consumed by `hasSms()` /
`hasEmail()` (`app/lib/notify.ts:19-24`) and ~8 call sites that gate behavior.
Each becomes a per-tenant capability check.

---

## 6. Hardcoded J KISS identity

No central `company.ts` exists. The literals live in ~30 files. Highest-value
targets, because they run inside email and SMS:

- `app/lib/booking-emails.ts:7` — `const FROM = 'J Kiss LLC <info@jkissllc.com>'`
  (the Resend sender, frozen at module scope)
- `app/lib/booking-emails.ts:8` — `const OPS = ['info@jkissllc.com', 'timmothy@jkissllc.com']`
- `app/lib/booking-emails.ts:50` — email footer with phone + DOT/MC
- `app/lib/route-notify.ts:29,35,41` — three SMS bodies opening `J KISS LLC …`
- `app/lib/policy.ts:16,19` — `POLICY_TITLE` + `DEFAULT_POLICY_TEXT`. A new tenant
  with no `policy:v:1` would be served **J Kiss's cancellation policy verbatim.**
- `app/lib/routes.ts:485-488` — `CONFIRM_DISCLAIMER`, a legally-binding contractor
  disclaimer with the company name inline
- `app/lib/owner-alerts.ts:29` — `?? 'timmothy@jkissllc.com'`, a personal email as
  a code-level default
- `app/api/admin/messages/reply/route.ts:92` — signature appended to every
  outbound reply
- `app/admin/messaging.tsx:179-197` and `app/admin/bookings/page.tsx:621-631` —
  **16 canned SMS templates**, each hardcoding the company name
- `middleware.ts:9-12` — apex→www redirect keyed to `jkissllc.com`. This is where
  tenant resolution (subdomain or custom-domain lookup) must be introduced.

Also: DOT `3484556` / MC `01155352` appear as raw literals in **17 places**; the
phone `(817) 909-4312` in 12; the brand red `#E0002A` is re-hardcoded as a string
literal in **15+ TS/TSX files** despite `--red` existing in
`app/globals.css:13` — so per-tenant theming **cannot** be achieved by swapping
CSS variables alone.

And in `app/admin/operations/new/page.tsx:10`, a business-model assumption
compiled into the route-creation form:
```ts
const VEHICLE = 'Box truck' // J KISS is box-truck only — never asked, always this.
```

### 6.1 Business logic that assumes one company
- `app/lib/ats-config.ts` — **100% hardcoded, no Redis.** Driver `payPerDay: 175`,
  helper `150` (`:23-36`). `Position` is a **TS union type** (`:6`), so a tenant
  cannot add a third role without a redeploy. Requirements (`:41-58`) include
  *"Must be able to safely operate a 26' box truck."*
  (Note: these are ATS/marketing numbers. Real payroll comes from Redis
  `staff:{id}` — `app/lib/staff.ts:34-40`.)
- `app/lib/disposal.ts:66-99` — `DEFAULT_DISPOSAL` is one company's empirically
  calibrated pricing model (`:92` — *"calibrated from the brush job"*). Structurally
  the **closest to ready**: already a Redis settings blob with a defaults merge.
  Needs `cfg:disposal` → `t:{tid}:cfg:disposal`, and `DEFAULT_DISPOSAL` demoted to
  "seed values for a new tenant."
- `app/lib/services.ts` — hardcoded catalog; ids are coupled to the `/quote`
  wizard *and* to `SERVICE_LABELS` in `app/lib/bookings.ts`. Icons are compile-time
  imports, so a runtime catalog needs an icon-name → component registry.
- `app/lib/cities.ts` — DFW only, company-voiced copy, and it drives
  `generateStaticParams` for `/box-truck-delivery/[city]`. Per-tenant cities means
  **per-tenant static route generation** — a real Next.js architecture question.
- `app/lib/analytics.ts:9` — `const TZ = 'America/Chicago'`. Every analytics
  bucket assumes Central time.
- `app/lib/availability.ts:33-35` — `LOAD_UNITS`, hardcoded, encodes "how much of
  a day a job consumes" for a box-truck operator.

---

## 7. Billing (to be built — nothing exists)

**There is no subscription, plan, tier, seat, trial, or metering concept anywhere.**

Confirmed: Stripe is **entirely customer-facing**. The complete Stripe API surface
is six calls — three Checkout Sessions, all `mode: 'payment'`
(`app/api/book/route.ts:89-90`, `app/api/booking/[token]/pay/route.ts:51-52`,
`app/api/invoice/[token]/route.ts:51-52`), two session retrievals, and one refund
(`app/api/admin/bookings/[id]/route.ts:369`). No `stripe.subscriptions.*`,
`prices.*`, `products.*`, `customers.*`, or `billingPortal.*`.

The only Stripe business logic is a processing-fee gross-up so the operator nets
the invoice amount (`app/lib/stripe.ts:20-34`) — i.e. charging *J Kiss's customer*
so *J Kiss* nets full price. Unambiguously tenant revenue, not platform revenue.

⚠️ `app/lib/stripe.ts:3`:
> `// Single Stripe account shared with ClaimGuard (same company). Uses the same STRIPE_SECRET_KEY env var.`

The Stripe account is **already** shared across two products. Introducing SaaS
billing on the same key while tenants also collect customer payments through it
would commingle platform revenue with tenant revenue.

**Stripe Connect is effectively mandatory**, and it reshapes all six call sites
above (destination charges / `stripeAccount` header).

Plan model, when it comes:
```
Plan   free | starter | pro
Limits seats, routes/mo, SMS/mo, AI calls/mo
Gate   at requireTenantSession() → tenant.plan, not sprinkled through handlers
```

---

## 8. Cron

`app/api/cron/daily/route.ts` is a single-tenant sweep guarded by `CRON_SECRET`
(`:200`). It must become a per-tenant fan-out. Note Vercel's per-plan cron limits
before assuming one cron per tenant.

---

## 9. Suggested sequence

1. **Fix §1** — the four pre-existing defects. Especially §1.4 (public PII).
2. Extract identity → `lib/company.ts`, seeded from today's literals (§6).
   Zero behavior change; makes the diff in step 5 mechanical.
3. Introduce `Tenant` + `User` models; migrate auth to per-user hashed
   credentials; make `SessionPayload` carry `{ sub, tid, role }` (§4).
   Still one tenant. Still one row.
4. Establish tenant context via `AsyncLocalStorage` in middleware (§5).
5. Prefix Redis inside `call()` (§2.1). **Hand-migrate the two bypass files**
   (§2.2). Write the backfill against Upstash directly (§2.5).
6. Resolve the derived-key collisions (§2.3) — `bizKey` needs a data migration,
   not a prefix.
7. Per-tenant credentials + capability flags (§5).
8. Stripe Connect (§7).
9. Plans, limits, billing (§7).

Steps 1–3 are safe to do now and are worth doing regardless of whether OpsPilot
ever ships to a second customer.
