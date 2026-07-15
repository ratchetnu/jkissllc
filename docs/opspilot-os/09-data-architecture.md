# 09 — Data Architecture (Phase 8) — Operion Platform

> Cited to `file:line` on `~/jkissllc@main`. Current model = **FACT**.
> Target = **RECOMMENDATION**.
> _(Updated 2026-07-14: platform is now branded **Operion** — `PLATFORM.name='Operion'`,
> `app/lib/company.ts:105`. The `opspilot:*` Redis family, the `docs/opspilot-os/`
> directory, and every `app/lib/platform/*` path are preserved verbatim as **legacy
> internal identifiers** for compatibility. The tenant-isolation chokepoint described
> below is now **built and enforced in code** (see §1, §4a); the data migration itself
> is still **authored-but-not-run** — DARK-LAUNCH READY, activation still BLOCKED.)_

## 1. The current data model is Redis, not SQL (FACT)

There is no relational database. Upstash Redis via `app/lib/redis.ts` holds every
entity as a JSON string at `prefix:{id}`, with a sorted-set index (`*:index`,
score = timestamp) for listing. Files live in Vercel Blob. Consequences that
shape the whole plan:

- **"Tables" are key namespaces** (~50 key families). "Foreign keys" are
  ids/tokens/names embedded in JSON — not enforced by any engine.
- **`app/lib/redis.ts` is now the single enforced isolation chokepoint** — every
  key passed to any method is routed through `scopeKey()`
  (`app/lib/platform/tenancy/keys.ts`). With `TENANCY_ENABLED=false` the key is
  returned **byte-identical** to today; with the flag on it is namespaced
  `t:{tenantId}:{key}` for tenant-owned families and **throws (fail-closed)** when a
  tenant-owned key is accessed with no tenant context — never a silent global
  read/write. The two historical bypass paths (`app/api/track`,
  `app/api/admin/analytics`) now go through the wrapper too. Direct
  `KV_REST_API_*` use outside this file + the migration script is forbidden and
  policed by a **blocking CI gate**, `scripts/bypass-detection.test.ts`.
  _(Updated 2026-07-14: previously "all keys global / two files bypass"; the
  chokepoint is now wired and enforced.)_
- **No SCAN/KEYS** on the wrapper → any backfill/migration script talks to
  Upstash directly (the one allowed bypass), not through this client.
- **No transactions across keys** → atomicity is per-key + app-level mutexes
  (`route-mutex.ts`, `claim-mutex.ts`).
- **No schema/constraints/indexes** beyond the hand-maintained `*:index` zsets.

## 2. Namespace inventory (FACT — condensed; full in `02`/`04`)

~50 key families:
`bk:*` bookings · `rt:*` routes · `rt:tpl:*` templates · `rt:inv:*` route
invoices · `rt:client:*` client portals · `clm:*` claims · `app:*` applicants ·
`msg:*` messages · `staff:*` staff · `user:*` users · `biz:*` businesses ·
`promo:*` promos · `ship:*` shipments · `rv:*` reviews · `policy:*` · `cfg:*`
config · `settings:*` · `learn:*` AI calibration · `crewavail:*` · `timeoff:*` ·
`uniform:*` · `rem:*`/`rsend:*` reminders · `paystmt:*` · `audit:*` · `ai:*` ·
`sms:optout:*` · `rl:*` rate-limit · `pv:*`/`uv:*` analytics · `opspilot:*`
platform waitlist.

_(Updated 2026-07-14: the family set is now formally split by the isolation
chokepoint. `scopeKey()` treats an explicit **allowlist** — `PLATFORM_GLOBAL_PREFIXES`
in `app/lib/platform/tenancy/keys.ts:18`: `opspilot:` (legacy internal identifier —
early-access waitlist, platform not tenant), `platform:` (tenant records + platform
billing/analytics), and `ai:` (AI prompts/telemetry/cost) — as **never-prefixed
platform-global**; every other family is tenant-owned and gets `t:{tenantId}:`.
Note that `ai:*` and `opspilot:*` staying global is deliberate today but the `ai:*`
prompts/telemetry being shared across tenants is an **activation blocker** — see §4b
and `10-security-risk-register.md`. **Vercel Blob object paths are NOT yet tenant-scoped**
— e.g. `quote-photos/{uuid}` in `app/api/upload/route.ts:27` is a single global
namespace with no `t/{tid}/` prefix; scoping blob paths is another activation blocker.)_

## 3. Weaknesses in the current model (FACT)

_(Updated 2026-07-14: the "No tenant boundary" row is now **partially addressed** —
the key-scoping mechanism exists and is enforced; what remains is running the data
migration and closing the blockers noted below.)_

| Weakness | Evidence | Impact |
|---|---|---|
| **Tenant boundary mechanism WIRED, not yet active** | `scopeKey()` chokepoint in `redis.ts` + `keys.ts`; flag-gated off | the core migration is now scaffolded (fail-closed), not merely "planned" |
| **Name/external-derived keys** | `biz:{name}` (`businesses.ts:41`), `promo:{code}`, `ship:{bol}`, `msg:phone:{e164}` | cross-tenant collision/leak; also embedded in `Staff.payByBusiness` map keys (`staff.ts:36`) |
| **Global pricing calibration** | `learn:jobs`/`learn:calibration` (`job-learning.ts:41-42`) | cross-tenant pricing leak |
| **Duplicate concepts** | two invoice systems, two "availability" concepts (`availability.ts` vs `crew-availability.ts`) | reconciliation gaps |
| **No consolidated ledger** | booking revenue absent from `computeFinance` (`finance.ts`) | can't produce company P&L |
| **Missing FKs (unenforced refs)** | `staffId`, `bizKey`, `bookingToken` are bare strings | dangling refs possible |
| **Linear scans** | booking↔SMS match (`twilio/sms:99`), `getUserByStaffId` (`users.ts:82`) | scaling risk |
| **No soft-delete / no immutable history** except where explicit | pay statements immutable (`pay-statements.ts`), claims ledger append-only (`claims.ts`) — good; most entities hard-delete | audit/recovery gaps |
| **PII at rest unencrypted** except identity docs | bookings/messages/GPS plaintext | privacy exposure |
| **No retention/TTL** | none | compliance blocker |

## 4. Target conceptual model (RECOMMENDATION)

### 4a. Tenant ownership (the invariant) — _partially IMPLEMENTED 2026-07-14_
Prefix **every tenant-owned key** with `t:{tenantId}:`. This is **now built**:
`scopeKey()` runs inside the `redis.ts` wrapper, fail-closed. Platform-scoped keys
(Tenant records, industry packs, the `opspilot:*` legacy waitlist family, `ai:*`,
platform billing/analytics) live on the `PLATFORM_GLOBAL_PREFIXES` allowlist and are
explicitly exempt (`keys.ts:18`). The **two former bypass files** (`app/api/track`,
`app/api/admin/analytics`) have been migrated onto the wrapper, so `pv:*`/`uv:*` now
cross the same boundary. Per-request tenant context is established by
`withTenantRoute` (`app/lib/platform/tenancy/with-tenant-route.ts`) on **104 request
handlers**, and by `withBackgroundTenant` on **3 crons + 3 webhooks**.
**Still outstanding before the invariant is real at the data level:** the data
migration must be run under `TENANCY_DARK_LAUNCH`→`TENANCY_DUAL_WRITE`, and the
name-derived keys (§4b) rewritten. The isolated dark-launch **Preview** (separate
`OperionPreview` Upstash Redis + `operion-preview-blob` Blob store, Preview-only flags)
is provisioned but its dark-launch telemetry has **not yet been exercised**.

### 4b. Name-derived keys → id-based (data migration, not just prefix)
- `biz:{name}` → `biz:{bizId}`; keep a `t:{tid}:biz:byname:{norm}` lookup;
  rewrite `Staff.payByBusiness` maps from name-keyed to `bizId`-keyed. **This is
  a data migration** (`04-...` seam #2).
- `promo:{code}` → `t:{tid}:promo:{code}` (tenant prefix suffices; codes are
  tenant-unique after prefixing).
- `ship:{bol}`, `msg:phone:{e164}` → tenant-prefixed.
- `learn:*` → `t:{tid}:learn:*` (stops cross-tenant training).

### 4c. New entities (fill capability gaps)
`Customer`, `Lead`, `Quote`, `ChangeOrder`, `Expense`, `LedgerEntry`,
`TimeEntry`, `Membership`, `Tenant`, `TenantConfig`, `IndustryPack`,
`ApprovalRequest`, `AiActionLog`, `RetentionPolicy`, `DataExportRequest`,
`ErasureRequest`. Each Redis-native (JSON + index), each tenant-prefixed.

### 4d. Record lifecycle & history
- **Immutable-by-design (keep):** pay statements, claims ledger, payments.
- **Add soft-delete + status history** to Customer, Job, Invoice, Staff (a
  `statusHistory[]` + `deletedAt`), so nothing is silently lost and audit can
  reconstruct state.
- **Outbox** (`t:{tid}:outbox`) per `08-...` for durable side-effects.

### 4e. File metadata & document versioning
Blob objects currently carry no metadata record. Add a `Document` entity
(tenant-prefixed) with `{ kind, blobPath, sealed, contentType, size, uploadedBy,
version, supersedes }`, reusing `doc-crypto.ts` sealing. Re-seal the residual
plaintext identity docs (roadmap §1.4) and tenant-prefix blob paths (`t/{tid}/`).
_(Updated 2026-07-14: blob paths remain **un-tenant-scoped** — `quote-photos/{uuid}`
etc. sit in one global namespace, `app/api/upload/route.ts:27`. This is a confirmed
tenancy **activation blocker**: the Redis chokepoint scopes keys, but Blob does not.)_

### 4f. Financial ledger boundary
Introduce `LedgerEntry` as the single source of money truth: booking revenue,
route revenue, refunds, payouts, expenses, claim recoveries all post here. P&L
and profitability read from the ledger, not from scattered per-domain math —
this closes the two-money-domains gap without disturbing the existing
booking/route flows (they emit ledger entries via the outbox).

### 4g. Analytics read model
Per-tenant `t:{tid}:pv:*`/`uv:*`; migrate the two inline-fetch paths onto the
wrapper (or an explicit tenant-aware analytics client) so pageview/visitor data
stops commingling.

## 5. Should you move to Postgres? (RECOMMENDATION)

**Not for tenancy, and not now.** Key-prefix isolation on Redis is sufficient and
preserves continuity. Introduce a relational store **later, narrowly**, for the
two workloads Redis serves poorly:
1. **Billing/ledger** — needs multi-row consistency, reporting, and dispute-grade
   integrity → Postgres (Neon on Vercel Marketplace is the low-friction choice).
2. **Cross-tenant platform analytics** — aggregate queries across tenants.

Everything operational (bookings/routes/staff/messages/claims) stays on Redis.
This hybrid is the target in `14-...`; the trigger to build it is "first paying
external tenant + billing," not "we might need SQL someday."

## 6. PII / financial / audit classification (FACT → drives retention policy)

- **Highest sensitivity:** applicant identity docs (SSN card, DL, ID) —
  **encrypted** (`doc-crypto.ts`), fail-closed. Keep + add re-seal of legacy.
- **PII plaintext:** booking customer name/phone/email/address, message bodies,
  **crew GPS coordinates** (`route/[token]:129,137`). Candidates for encryption
  and/or short TTL.
- **Financial:** claims ledgers, invoices, `staff.payByBusiness`, pay statements
  — integer cents, plaintext; need audit + retention.
- **Retention (NEW):** define per-entity TTL/retention (e.g. GPS punches 90 days,
  messages per tenant policy, applicant docs per hiring policy) and an erasure
  workflow — required for enterprise procurement and privacy law.
