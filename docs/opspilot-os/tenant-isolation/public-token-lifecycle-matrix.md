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

## Open questions that must be answered before wiring

1. **Ack retention (#7).** No revocation path exists. Are ack tokens one-time,
   repeat-use, or indefinite? The binding's lifetime must match, or it either outlives
   the capability or kills it early.
2. **Route-token indirection (#4).** `rt:atok:{assignee}` maps to a *route* token; the
   public page then loads the route. The binding should point at the route, but
   rotation deletes per-assignee atoks — so bindings must be revoked in lockstep at
   `routes.ts:434` or a rotated-out assignee keeps a working link.
3. **Invoice/Stripe boundary (#6).** Stripe callbacks must stay
   metadata/signature-based. The invoice token binding must not become an alternative
   trust path into payment marking.

## What must NOT happen

- `bk:`, `rt:`, `rsend:`, `paystmt:`, `pv:`, `uv:` stay tenant-owned. Nothing here
  justifies another `PLATFORM_GLOBAL_PREFIXES` entry.
- No per-request scan across tenants to find a token's owner.
- No caller-supplied tenant id on any of these paths.
