# 02 — Capability Registry

**Files:** `app/lib/platform/capabilities/{types,registry,validate,index}.ts`,
plus `{tenant-profile,tenant-profile-store,provider-readiness,guard}.ts` ·
**Tests:** `scripts/platform-capabilities.test.ts`,
`scripts/tenant-capability-profile.test.ts`,
`scripts/capability-runtime-guards.test.ts` · **Flag:**
`CAPABILITY_REGISTRY_ENABLED` (on; gates the catalog queries only — see below).

## What it is
A first-class, typed registry of the platform capabilities — the vocabulary the
platform reasons about. Not a bag of booleans: each `Capability` declares a stable
id, display name, description, owning domain, hard dependencies, soft
dependencies, implementation status (mirroring `../03-capability-matrix.md`), kind
(core/optional/industry), the external provider it adapts (if any), required
permissions, required flags, supported roles, supported AI actions (+ autonomy
level), a default selection, whether a tenant may configure it at all, and future
tier eligibility.

## The five axes, kept separate

Collapsing any two of these is how "Supercharged has no Stripe key" turned into
"Supercharged cannot receive a security fix". They are answered by different
systems and must never be inferred from one another:

| Axis | Question | Answered by |
|---|---|---|
| code installed | Does this deployment CONTAIN the implementation? | the registry's `status` + the release/update record |
| available in the pack | Does this product/industry pack OFFER it? | `kind` + `IndustryPack.supportedCapabilities` |
| enabled by the tenant | Has THIS business turned it on? | the tenant capability profile |
| provider configured | Are the adapter's credentials present? | `provider-readiness.ts`, from the ENVIRONMENT only |
| operational | Is it actually working right now? | readiness + observed provider outcomes |

Installing code and activating a capability are separate events. A core update
installs regardless of the last two axes; it simply lands dormant.

## Hard vs soft dependencies

`dependencies` are HARD prerequisites: the profile validator refuses to enable a
capability while one of them is disabled. `softDependencies` enhance and never
require.

Getting this wrong is not cosmetic. `invoicing` used to declare `payments` a hard
dependency, which asserted — in the one machine-readable place that answers the
question — that a business cannot bill anyone without a card processor. An invoice
is a RECORD: it is numbered, rendered, sent, viewed at `/invoice/{token}` and
marked paid from an offline payment with no processor involved. `reporting` had
the same defect (a revenue report needed Stripe merely to load). Both are now soft.

## Optional provider adapters

`payments-stripe`, `sms-delivery` and `email-delivery` are optional, independently
selectable adapters. The RECORDS they deliver — payments, messaging, notifications
— stay core and always work.

`defaultSelection: 'auto'` is legal only for an adapter and means "in use if, and
only if, this deployment already carries the provider's credentials". That is
precisely the pre-existing effective behavior (an unconfigured provider already
no-ops), so it preserves both deployments byte-for-byte while giving a
credential-free target a HEALTHY "not enabled" instead of a permanently degraded
"unconfigured". An explicit tenant choice always wins, so "enabled but
unconfigured" stays visible and actionable.

## Guarantees
- **Structural validation** (`validate.ts`): every hard and soft dependency
  resolves, nothing depends on itself, the hard graph is acyclic, a provider
  adapter is always `optional`, only an adapter may infer its default, a
  non-configurable capability must default enabled, and the shipped defaults are
  themselves a legal configuration. Enforced by test.
- **Catalog queries** (`index.ts`) are gated by `CAPABILITY_REGISTRY_ENABLED`:
  `capabilitiesForRole(role)`, `aiEligibleCapabilities()`,
  `isCapabilityEnabledByDefault(id)`.
- **Enforcement is NOT gated by that flag.** `guard.ts` resolves from the tenant
  profile directly and fails closed. A kill switch that turns a security check
  into a no-op is not a kill switch, it is a bypass.
- **The reference tenant is unchanged.** J KISS stores no overrides, so every
  capability resolves to exactly the registry defaults it always did.

## Per-tenant configuration

`tenant-profile-store.ts` persists selections at the tenant-owned Redis key
`settings:capabilities`, so it passes through the chokepoint in `app/lib/redis.ts`.
Writes require an active membership plus `settings:manage`, are validated for
dependency closure and mandatory capabilities, and are audited (successes and
refusals). **No credential value is storable** — a `credentialRef` must be a
variable name or path, and a pasted value is refused rather than truncated.
Surface: `GET`/`PATCH /api/admin/capabilities`, and the owner panel at
`/admin/operations/settings`.

## Previously "not done", now done
Per-tenant capability configuration, the runtime guards, and an owner UI surface
all exist. What remains open is multi-tenant GA itself — see
`GET /api/admin/platform/ga-readiness`, which reports thirteen dimensions
separately and will not call this deployment ready until each is proven.
