# 09 — Data Architecture (Phase 8)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12. Current model = **FACT**.
> Target = **RECOMMENDATION**. **No migration authored or run.**

## 1. The current data model is Redis, not SQL (FACT)

There is no relational database. Upstash Redis via `app/lib/redis.ts` holds every
entity as a JSON string at `prefix:{id}`, with a sorted-set index (`*:index`,
score = timestamp) for listing. Files live in Vercel Blob. Consequences that
shape the whole plan:

- **"Tables" are key namespaces.** "Foreign keys" are ids/tokens/names embedded
  in JSON — not enforced by any engine.
- **No SCAN/KEYS** (`redis.ts:36-77`) → any backfill/migration script must talk
  to Upstash directly, not through this client.
- **No transactions across keys** → atomicity is per-key + app-level mutexes
  (`route-mutex.ts`, `claim-mutex.ts`).
- **No schema/constraints/indexes** beyond the hand-maintained `*:index` zsets.

## 2. Namespace inventory (FACT — condensed; full in `02`/`04`)

`bk:*` bookings · `rt:*` routes · `rt:tpl:*` templates · `rt:inv:*` route
invoices · `rt:client:*` client portals · `clm:*` claims · `app:*` applicants ·
`msg:*` messages · `staff:*` staff · `user:*` users · `biz:*` businesses ·
`promo:*` promos · `ship:*` shipments · `rv:*` reviews · `policy:*` · `cfg:*`
config · `settings:*` · `learn:*` AI calibration · `crewavail:*` · `timeoff:*` ·
`uniform:*` · `rem:*`/`rsend:*` reminders · `paystmt:*` · `audit:*` · `ai:*` ·
`sms:optout:*` · `rl:*` rate-limit · `pv:*`/`uv:*` analytics · `opspilot:*`
platform waitlist.

## 3. Weaknesses in the current model (FACT)

| Weakness | Evidence | Impact |
|---|---|---|
| **No tenant boundary** | all keys global (`redis.ts:4-12`) | the core migration |
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

### 4a. Tenant ownership (the invariant)
Prefix **every tenant-owned key** with `t:{tenantId}:` inside `call()`
(`redis.ts:17-34`). Platform-scoped keys (Tenant records, industry packs,
`opspilot:*`, platform billing/analytics) live under a `platform:` prefix and
are explicitly exempt. **Two files must be hand-migrated** (`app/api/track`,
`app/api/admin/analytics`) because they bypass `call()`.

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
