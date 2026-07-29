# Public-token lifecycle matrix (Wave 6D, Phase 1)

Traced from code on 2026-07-29 against `main` @ `789ad68`. This is the precondition
for wrapping anything: **no route should be wrapped until its issuance and revocation
lifecycle is understood**, and two families turned out not to be token routes at all.

## Why every one of these currently breaks

All of them (except `/verify/[id]`, which is unwrapped) use `withTenantRoute`, which
resolves the tenant from the **signed session**. A customer following a link from
their email has none, so with `TENANCY_ENABLED=true`
`withTenantContextFromRequest` throws **before the handler runs**.

## Matrix

| # | Family | Key family | Token generated | Issuance / persistence | Rotation | Revocation / delete | Owning-tenant source | Resource id | Historical tokens exist? | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Booking** `/booking/[token]` (11 API + page) | `bk:*` | booking creation | `bookings.ts` `saveBooking` | n/a | booking delete | active context | booking token | yes | ✅ **bound in #121** |
| 2 | **Quote resume** `/quote/resume/[token]` | `bk:*` | same booking token | same as #1 | n/a | same | active context | booking token | yes | ✅ binding exists — **wrapper swap only** |
| 3 | **Quote status** `/quote/status/[token]` | `bk:*` | same booking token | same as #1 | n/a | same | active context | booking token | yes | ✅ binding exists — **wrapper swap only** |
| 4 | **Route access** `/route/[token]` | `rt:atok:*` → route token | per assignee | `routes.ts:425` `redis.set(KEY_ATOK(a.token), r.token)` | **yes** — old assignee tokens deleted at `:434` | `routes.ts:434` | active context | route token (indirect: atok → route token) | yes | ❌ unbound |
| 5 | **Client portal** `/client/[token]` | `rt:client:*` | `crypto.randomUUID()×2` (`client-portal.ts:31`) | `:43` `saveClientPortal` | none | `:48` `deleteClientPortal` | active context | portal token | yes | ❌ unbound |
| 6 | **Route invoice** `/invoice/[token]` (+ stripe-return) | `rt:inv:*` | invoice creation | `route-invoices.ts:86` | none | `:123` | active context | invoice token | yes | ❌ unbound |
| 7 | **Acknowledgement** `/ack/[token]` | `rsend:token:*` → instance id | reminder send | `reminders.ts:228` `redis.set(tokKey(i.token), i.id)` | none | none found — **retention contract unclear** | active context | reminder instance id | yes | ❌ unbound |
| 8 | **Track** `/api/track` | `pv:*`, `uv:*` | — | — | — | — | — | — | — | ⚠️ **not a token route** |
| 9 | **Pay-statement verify** `/verify/[id]` | `paystmt:*` | `ps_<18 hex>` (`pay-statements.ts:49`) | statement creation | none | statement delete | active context | statement id | yes | ⚠️ **raw id is the capability** |

## The two families that are not what the brief assumed

### `/api/track` — an anonymous beacon, not a capability
No token, no resource, no `[token]` segment. It is a pageview beacon that increments
tenant-owned `pv:*` / `uv:*` counters, rate-limited per IP, storing no PII. There is
nothing to bind.

It still breaks under tenancy, but the correct mechanism is **host → tenant**, not a
token binding: the question "which site was this pageview on?" is answered by the
request host. `resolveTenantFromHost` already exists for exactly this and is currently
unused on this path. Binding a token here would be inventing a capability that the
product does not have.

### `/verify/[id]` — the raw id already IS the capability
`ps_` + 18 hex chars of a UUID: opaque, non-enumerable, and the route deliberately
returns only non-sensitive confirmation fields (`publicStatement`). So a separate
token is arguably redundant — the id is already unguessable capability material.

Two defensible designs, and the choice is a product decision rather than a mechanical
one:

- **Bind the existing id.** `platform:token:{ps_id}` → `{tenant, 'pay-statement', id}`.
  Every existing printed/emailed verification link keeps working, and the backfill is
  a straight walk of existing statements. Slight conceptual stretch: the "token" is
  also the internal record id, so leaking one leaks the other.
- **Mint a separate verification token.** Cleaner separation, but every link already
  in the wild breaks unless both paths are supported for a retention period.

Recommendation: bind the existing id. The id is already public by design, and breaking
issued verification links to gain a distinction customers cannot observe is a poor
trade.

## Decisions (owner, 2026-07-29) — these are settled

### 1. Acknowledgement tokens: repeat-use while active
Not one-time — a user may reopen the link before completing the acknowledgement — and
not indefinite without lifecycle control.

- the same link may be reopened and reused **while the acknowledgement is active**
- the binding points at the exact tenant + acknowledgement resource
- **revoke** on: completed · cancelled · superseded/replaced · expired under the
  existing retention contract
- unknown / revoked / completed / expired / mismatched all fail identically, revealing
  neither tenant nor resource existence
- making them one-time would change the product workflow and belongs in a separate
  reviewed feature, not here

### 2. Pay-statement verification: bind the existing `ps_...` id
The current opaque id **is** the public capability. Binding it preserves every printed,
emailed and saved verification link.

- `platform:token:{payStatementId}` → `{tenantId, resourceType: 'pay-statement', resourceId}`
- resolve the binding **before** reading `paystmt:*`
- **no** second customer-visible token this wave — revisit only if a security review
  finds the current entropy insufficient
- `paystmt:` does **not** join `PLATFORM_GLOBAL_PREFIXES`
- existing unbound links need a controlled backfill/compatibility path
- conflicting ownership fails and never overwrites

### 3. Route-token rotation: old links die immediately
- revoke the old binding **in the same protected mutation** that rotates or removes the
  assignee token
- bind the replacement only to the intended tenant + route + assignee contract
- no window where both old and new links work, unless the route workflow explicitly
  requires overlap
- a stale caller must not restore the previous binding; rotation stays idempotent
- a failed rotation must leave neither a live old token (once revocation committed),
  nor an unbound new token, nor two unintended active bindings

## Delivery split

| PR | Scope |
|---|---|
| **6D-A** (lower risk) | route access · client portal · acknowledgement · quote resume/status wrapper swaps · `/api/track` host mapping · shared backfill · tests |
| **6D-B** (financial, reviewed separately) | route invoice · pay-statement verification · financial backfill · tests |

## What must NOT happen

- `bk:`, `rt:`, `rsend:`, `paystmt:`, `pv:`, `uv:` stay tenant-owned. Nothing here
  justifies another `PLATFORM_GLOBAL_PREFIXES` entry.
- No per-request scan across tenants to find a token's owner.
- No caller-supplied tenant id on any of these paths.
