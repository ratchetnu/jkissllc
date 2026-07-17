# Operion Multi-Tenant Readiness Audit — 2026-07-17

> **Status: audit + verification only. No production behavior changed.**
> Branch `audit/multitenant-foundation`, worktree `/Users/nunubabymuzik/jkissllc-mt-audit`,
> based on `origin/main @ a7ac3f6`. Every claim below is cited to `file:line` and
> was verified by reading the code and running the gates (see §8), not inferred
> from prior docs. This audit **supersedes the top-level
> `docs/opspilot-multi-tenant-roadmap.md`** (dated 2026-07-08), whose "zero tenancy
> primitives" premise is now stale.

---

## 0. The honest summary (what changed since the 07-08 roadmap)

The 07-08 roadmap said the app had *"zero tenancy primitives … no tenant model, no
organization, no user record, no role, no permission."* **That is no longer true.**
Between then and now, the `opspilot/tenant-isolation` and platform-foundation sprints
landed and merged to `main`. Today the foundation is **built and pervasively wired,
but dormant behind `TENANCY_ENABLED=false`.** Enabling the flag is the remaining
program — not building the primitives.

What now exists and is verified present:

| Primitive | Where | State |
|---|---|---|
| Tenant / Membership / TenantPrincipal models | `app/lib/platform/tenancy/types.ts` | Built |
| Request-scoped tenant context (AsyncLocalStorage) | `app/lib/platform/tenancy/context.ts` | Built |
| **Redis key chokepoint** — every verb routes through `scopeKey()` | `app/lib/redis.ts:60-131` | **Wired**, no-op while flag off |
| **Blob path chokepoint** — `scopeBlobPath()` | `app/lib/platform/tenancy/blob-keys.ts` | Built + used at 6 sites |
| Per-handler wrapper `withTenantRoute` | `app/lib/platform/tenancy/with-tenant-route.ts` | **Applied to 138 of 169 route exports** |
| Background/cron/webhook context | `request-context.ts` (`withBackgroundTenant`) | Applied to cron + webhooks |
| RBAC matrix `can(role, permission)` | `app/lib/rbac.ts` | Built, enforced |
| Identity in the session token (`sub`/`role`/`staffId`/`tid`) | `app/api/admin/_lib/session.ts:19-27` | Built |
| Real per-user credential model | `app/lib/users.ts` | Built (pbkdf2) |
| Tenant seed from J KISS identity | `app/lib/platform/tenancy/jkiss.ts`, `app/lib/company.ts` | Built (not persisted) |
| Dark-launch / dual-write migration tooling | `dark-launch.ts`, `scripts/tenant-migration/` | Built |
| Tenant resolvers (session / host / resource / Stripe) | `tenant-resolve.ts` | Built |

**Behavioral impact of all of it, today: none.** `scopeKey()` returns keys
byte-identical while the flag is off (`keys.ts:63-64`); the wrappers resolve to the
reference tenant; dark-launch/dual-write are off. J KISS behaves exactly as before.

The leverage the 07-08 roadmap identified was correct — the migration funnels through
`redis.ts::call()` and `requireSession`. Both chokepoints are now real and covered.
What remains is a small, well-bounded set of items that **key-prefixing alone does
not fix** (§3), plus the per-tenant *credential/edition* layer that only matters when
a second tenant actually onboards (§5–§6).

---

## 1. Verification method

- Read the isolation-critical modules end to end: `redis.ts`, `platform/tenancy/*`,
  `rbac.ts`, `session.ts`, `platform/flags.ts`.
- Four parallel domain sweeps (data-isolation, auth/routes, AI/analytics/comms/cron,
  storage/branding/env/flags) cross-checked against code.
- Ran the gates in the isolated worktree (§8): `tsc --noEmit`, the full `node --test`
  suite, `eslint`, and the new static diagnostic.
- Added one inert diagnostic, `scripts/tenant-readiness-audit.mjs`, that reproduces
  the route-coverage / derived-key / un-scoped-blob findings on demand.

---

## 2. Current-state tenant map (every domain classified)

Classification legend: **AWARE** = tenant boundary enforced or enforceable via the
chokepoint with no residual coupling · **AWARE\*** = flows through the chokepoint but
has a residual within-value or resolution gap · **GLOBAL** = platform-global by
design (allowlisted) · **SINGLE** = still single-tenant, needs work before a 2nd
tenant · **UNSAFE** = would leak/collide across tenants if the flag were flipped as-is.

| Domain | Class | Basis (file:line) |
|---|---|---|
| Authentication (session token) | AWARE | `session.ts:19-27` token carries `tid/sub/role/staffId`; HMAC-signed |
| User identity / credentials | AWARE | `users.ts` real `User` + pbkdf2; owner is legacy shared-password (`admin/auth/route.ts:96`) |
| Authorization (RBAC) | AWARE | `rbac.ts` central matrix; 138 routes wrapped, near-total guard coverage |
| Roles (global vs tenant) | AWARE\* | `rbac.ts:10` roles are tenant-scoped; platform owner is a separate tier (`session.ts:270`) |
| Bookings | AWARE | `bookings.ts` `bk:*` CSPRNG token + INCR counter; chokepoint-scoped |
| Routes | AWARE | `routes.ts` `rt:*` CSPRNG tokens; chokepoint-scoped |
| Route invoices | AWARE | `route-invoices.ts` `rt:inv:*`; token CSPRNG |
| Client portals | AWARE | `client-portal.ts` `rt:client:{token}` CSPRNG |
| Claims | AWARE\* | `claims.ts` `clm:*` safe keys; but `businessKey` frozen in the snapshot value |
| Applicants | AWARE | `applicants.ts` `app:*` CSPRNG id + INCR |
| Crews / staff | AWARE\* | `staff.ts` `staff:*` safe keys; but `Staff.payByBusiness` is a name-keyed map in the value |
| Payroll / pay | AWARE\* | pay statements keyed by internal id; inherits the `payByBusiness` name coupling (`finance.ts:85`) |
| Equipment | AWARE | `equipment.ts` internal ids |
| Businesses | **UNSAFE** | `businesses.ts:55` `biz:{bizKey(name)}` — key is the business **name** |
| Promos | **UNSAFE** | `promo.ts:21` `promo:{code}` — user-typed code; loyalty code only 5 hex chars (`promo.ts:73`) |
| Shipments | **UNSAFE** | `shipments.ts:22` `ship:{bol}` — external BOL/PO as the primary key |
| Customers (identity index) | **UNSAFE** | `customers.ts:42-43` `cust:email:{email}`, `cust:phone:{phone}` |
| Messaging / comms | AWARE\* | `msg:*` are tenant-owned, but inbound webhook does not map `To`→tenant (§3.2) |
| SMS opt-out | AWARE\* | `sms.ts:101` / `comms/optout.ts:14` `sms:optout:{e164}` — phone-keyed |
| AI jobs / telemetry | GLOBAL | `ai:*` allowlisted (`keys.ts:21`); record embeds `tenantId`, read-filtered by `scopeAiRecords` |
| Analytics (pageviews) | AWARE | `track/route.ts` + `admin/analytics/route.ts` now on the chokepoint; `pv:*/uv:*` tenant-owned |
| Documents (blob) | AWARE\* | 6 write sites scoped via `*BlobPath`; **2 bypasses remain** (§3.3) |
| Audit logs | AWARE\* | keys tenant-owned, but `AuditEntry` has no `tenantId` field; many `pushAudit` sites log `'admin'/'system'` |
| Feature flags | GLOBAL | `flags.ts` env-driven, per-deployment; no tenant dimension |
| Capabilities / editions | SINGLE | `capabilities/index.ts:34-38` hardcodes `jkiss`-only; other tenants → false |
| Industry packs | SINGLE | layered resolver exists (`industry-packs/config.ts`) but no per-tenant source |
| Env / credentials | SINGLE | Stripe/Twilio/Resend/Blob/Upstash all single-set from `process.env` |
| Branding / identity literals | AWARE\* | `company.ts` centralizes (62 importers); ~51 files still hold raw `J KISS` literals |
| Tenant settings/branding store | SINGLE | only global `settings:*` / `cfg:*` singletons; no `Tenant` persistence |
| Storage/blob path convention | AWARE | `tenants/{id}/…` convention built (`blob-keys.ts:21`) |
| Background jobs (cron) | AWARE | `cron/daily/route.ts:228-247` fan-out per `activeTenantIds()` in `withBackgroundTenant` |
| Public-token routes ([token]) | SINGLE | tenant can't be resolved before the record read; resolver staged, index not built (§3.1) |
| Row-level security | GLOBAL | Redis has none; isolation is key-prefix + app-layer, by design |

---

## 3. Highest-risk remaining data-isolation issues (verified, ranked)

These are the items that **survive** the chokepoint — flipping `TENANCY_ENABLED`
does not make them safe. Ranked by blast radius for a hypothetical 2nd tenant.

### 3.1 Public-token routes cannot resolve their tenant *(HIGH — blocks public routes under tenancy)*
`getBookingByToken` (`bookings.ts:468`), `getRouteByToken` (`routes.ts:405`),
`getInvoiceByToken` (`route-invoices.ts:71`), `getClientPortal` (`client-portal.ts:34`)
resolve a record directly from Redis given only an unguessable token. Under tenancy,
the scoped read needs the tenant *before* it can fetch the record that would name the
tenant — a chicken-and-egg. A `resolveTenantFromResource` path exists
(`tenant-resolve.ts`, tested) but the **global `token → tenantId` index it needs is
not built.** Until it is, enabling the flag fails these routes closed (safe, but they
stop working on Preview).

### 3.2 Inbound SMS webhook does not map recipient number → tenant *(HIGH — cross-tenant misattribution)*
`app/api/webhooks/twilio/sms/route.ts:80` picks `activeTenantIds()[0]` and runs the
whole body under that tenant. The code comment acknowledges a pooled deployment "would
map the recipient number → tenant" — **that mapping is not implemented.** With >1
active tenant, every inbound SMS (and every `sms:optout:{e164}` write) is attributed
to the first tenant. Single-tenant today, so latent; a hard blocker for a 2nd tenant
that shares the Twilio surface.

### 3.3 Name/external-derived keys collide within a shared store *(HIGH — data merge/leak)*
Key-prefixing separates namespaces but not identities. These keys are the identity:
- `biz:{bizKey(name)}` — `businesses.ts:55` (two tenants hauling for "Rooms To Go" collide)
- `promo:{code}` — `promo.ts:21` (tenant A's `SAVE20` overwrites tenant B's)
- `ship:{bol}` — `shipments.ts:22` (external BOL as PK)
- `cust:email:{email}` / `cust:phone:{phone}` — `customers.ts:42-43` (cross-links people)
- `msg:phone:{e164}` — `messages.ts:78` · `sms:optout:{e164}` — `sms.ts:101`, `comms/optout.ts:14`

And the **value-embedded** name keys a Redis prefix physically cannot reach:
`Staff.payByBusiness` keyed by `bizKey(name)` (read in `finance.ts:85`, `staff.ts`).
These require an **entity-id data migration** (name → stable id), not a prefix. The
`businesses.ts` file already carries unwired `biz:id:{stableId}` scaffolding for this.

### 3.4 Two Blob writes bypass the blob chokepoint *(MEDIUM — shared-namespace object under tenancy)*
- `app/lib/image-convert.ts:77` — raw `put(\`quote-photos/${uuid}.jpg\`)` on the HEIC
  re-store path. The primary quote upload *is* scoped (`upload/route.ts`), so under
  tenancy the original and its converted copy would diverge (scoped vs shared).
- Client-upload token brokers `app/api/admin/blob-upload/route.ts` and
  `app/api/admin/claims/upload/route.ts` mint tokens on the raw client `file.name`
  without routing it through `scopeBlobPath` in `onBeforeGenerateToken`.

### 3.5 Audit entries lack a tenant field and a real actor *(MEDIUM — observability/forensics)*
`AuditEntry` (`audit.ts:20-30`) has no `tenantId`, and `listAudit` has no
defense-in-depth tenant filter (unlike AI's `scopeAiRecords`). Many `pushAudit` sites
still record the literal `'admin'`/`'system'` actor; the attributed `pushAuditFor`
(`routes.ts:458`) exists but is adopted only at newer sites.

### 3.6 `toPrincipal` fail-*open* defaults *(LOW — depends on mint discipline)*
`session.ts:42` resolves a token with **no role** to `admin`, and **no tid** to the
reference tenant. Deliberate legacy continuity, but it means a malformed/rogue-minted
token missing the `role` claim becomes full admin. Safe only while every mint path
sets the claims (they do today). Worth a guard when a 2nd tenant lands.

### 3.7 15 route handlers are UNCLASSIFIED for tenant context *(LOW–MEDIUM — review list)*
The diagnostic flags 15 `route.ts` files that neither `withTenantRoute`-wrap nor use
background context nor are pre-auth-exempt. Most touch only `ai:` (allowlisted global)
or platform/Operion surfaces, but `app/api/upload/route.ts`, `app/api/intake/config/route.ts`,
`app/api/operion/demo/route.ts`, and `app/api/verify/[id]/route.ts` should be
individually confirmed before the flag flips. Run `node scripts/tenant-readiness-audit.mjs`.

---

## 4. Target domain model (as built — documented, not proposed)

The model already lives in `app/lib/platform/tenancy/types.ts`; this audit ratifies it.

```
Tenant        id (opaque, non-name-derived → the Redis prefix t:{id}:)
              slug, displayName, legal{dot,mc,address,phone,supportEmail},
              brand{primaryColor,logoUrl,emailFromAddress}, industryPackId,
              status: active|suspended|trialing, createdAt
Membership    id, tenantId, userId, role, status: active|invited|suspended
TenantPrincipal  sub, tenantId, membershipId?, role, permissions[],
              authSource: password|legacy-admin|system, staffId?, sessionId?
```

- **Tenant boundary is an opaque id, never a display name** (`keys.ts:33-40`
  rejects name-shaped ids). `jkiss` is the reference tenant.
- **Global platform-admin** is a tier above tenant admin: `isPlatformOwner`
  (`session.ts:270`), gated on `sub==='owner'` or `PLATFORM_OWNER_SUBS`.
- **Every authorization decision resolves through the RBAC matrix**, never an inline
  role-string check (`rbac.ts:131`).
- **Two isolation chokepoints, both fail-closed**: Redis keys (`scopeKey`) and Blob
  paths (`scopeBlobPath`). Platform-global families are an explicit allowlist
  (`keys.ts:18-23`).
- **Tenant is resolved from the authoritative signed session only** — never a header
  or body (`request-context.ts:22`).

---

## 5. Phased plan for the remaining work (stages 7→9)

Stages 1–6 (defects, identity extraction, session identity, context wiring, chokepoint,
initial resolvers) are **done**. What remains, each with a rollback point:

**Stage 7 — Enable isolation on Preview (dark-launch → dual-write → cutover).**
1. Turn on `TENANCY_DARK_LAUNCH` on Preview; watch `dark-launch` mismatch telemetry.
2. Build the **global `token → tenantId` index** (§3.1) so public `[token]` routes
   resolve their tenant before the scoped read. *Rollback:* index is additive; drop it.
3. Turn on `TENANCY_DUAL_WRITE`, run `scripts/tenant-migration` to backfill
   `t:jkiss:*`, validate parity. *Rollback:* legacy keys untouched; disable the flag.
4. Flip `TENANCY_ENABLED` on Preview only. *Rollback:* single env flip back.

**Stage 8 — Close the identity-key collisions (data migration, not a prefix).**
- Migrate `biz:{name}` → `biz:id:{stableId}` and remap `Staff.payByBusiness`,
  `ClaimSnapshot.businessKey` to stable ids (§3.3). Cautious, per-entity, dry-run first.
- Map the Twilio recipient number → tenant (§3.2). Scope `promo`/`ship`/`cust:*` by
  making the external string tenant-relative.
- Route the 2 blob bypasses through `scopeBlobPath` (§3.4); add `tenantId` to
  `AuditEntry` + a `listAudit` filter (§3.5).

**Stage 9 — Per-tenant credential & edition layer (only when a 2nd tenant onboards).**
- Persist `Tenant` records (`tenant-store.ts` is the single wiring point).
- Per-tenant credential resolution: Stripe Connect, Twilio subaccounts, Resend sending
  domain, per-tenant blob store or prefix. De-`NEXT_PUBLIC_`-ify the site URL.
- Per-tenant capability/edition config (replace the `jkiss`-only hardcode in
  `capabilities/index.ts:34`).

Do **not** convert production queries or flip the prod flag as part of this audit.

---

## 6. What a future implementation session must own

- `app/lib/platform/tenancy/tenant-store.ts` — the one place to source a real tenant
  registry (today returns `[jkiss]`).
- The **global token→tenant index** (new): `bookings.ts`, `routes.ts`,
  `route-invoices.ts`, `client-portal.ts` write sites + a platform-scoped index.
- `app/api/webhooks/twilio/sms/route.ts` — recipient-number → tenant mapping.
- `app/lib/businesses.ts`, `staff.ts`, `finance.ts`, `claims.ts` — the name→id
  migration (Stage 8), plus `scripts/tenant-migration/` extensions.
- `app/lib/image-convert.ts`, `app/api/admin/blob-upload/route.ts`,
  `app/api/admin/claims/upload/route.ts` — blob-path scoping.
- `app/lib/audit.ts` — `tenantId` field + read filter; `pushAudit`→`pushAuditFor` rollout.
- `app/lib/stripe.ts`, `sms.ts`, `company.ts`, `capabilities/index.ts` — Stage 9
  credential/edition layer.

---

## 7. Likely conflicts with parallel sessions

- **AI telemetry / queue-recovery** (`feat/ai-telemetry-foundation`,
  `feat/ai-job-recovery`): the `ai:*` keyspace is platform-global by design and owned
  by those sessions. This audit **did not touch** those files; Stage 8/9 should treat
  `ai:*` as global (per-tenant AI metering is a separate new requirement).
- **Comms layer** (`feat/customer-communications`): overlaps §3.2 (inbound SMS→tenant)
  and `comms/optout.ts`. Coordinate the recipient→tenant mapping there.
- **Unified Ops / Book Now** and **Crew Portal**: add new `route.ts` files; each new
  route should be `withTenantRoute`-wrapped (or background-context) so the diagnostic's
  UNCLASSIFIED count doesn't grow. No file-level conflict with this audit (docs + one
  new script only).
- This branch changes **no application source** — only `docs/` and one new
  `scripts/*.mjs`. Merge conflict surface is minimal.

---

## 8. Verification results (this branch, worktree `jkissllc-mt-audit @ a7ac3f6`)

- `node node_modules/typescript/bin/tsc --noEmit` — **clean (exit 0)**
- `npx tsx@4 --test scripts/*.test.ts` — **1254 pass / 0 fail**
- Tenancy subset (15 files incl. keys/isolation/wiring/blob/bypass/rbac/authz/dark-launch/
  migration/resolve/stripe) — **109 pass / 0 fail**
- `npx eslint` on the tenancy surface — **clean**
- `node scripts/tenant-readiness-audit.mjs` — report: 138 request-wrapped, 9
  background, 7 exempt, **15 unclassified**; 8 derived-key families + 3 value-embedded;
  **1 un-scoped blob write**
- `next build` — not run locally (pre-existing `next/font/google` env quirk noted in
  `13-results.md`; local gate = tsc + tests + eslint, matching `predeploy`).

**Behavioral impact of this branch: none.** Documentation and an inert, report-only
diagnostic. No flags changed, no source modified, nothing merged or deployed.
