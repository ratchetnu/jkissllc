# 02 — Capability Registry

**Files:** `app/lib/platform/capabilities/{types,registry,validate,index}.ts` ·
**Tests:** `scripts/platform-capabilities.test.ts` · **Flag:**
`CAPABILITY_REGISTRY_ENABLED` (on; inert data).

## What it is
A first-class, typed registry of the 37 platform capabilities — the vocabulary
the platform reasons about. Not a bag of booleans: each `Capability` declares a
stable id, display name, description, owning domain, dependencies, implementation
status (mirroring `../03-capability-matrix.md`), kind (core/optional/industry),
required permissions, required flags, supported roles, supported AI actions (+
autonomy level), J KISS enablement, and future tier eligibility.

## Guarantees
- **Structural validation** (`validate.ts`): every dependency resolves, nothing
  depends on itself, the dependency graph is acyclic. Enforced by test.
- **Query interfaces** (`index.ts`), all hard-gated by the flag (off → empty):
  `capabilitiesForRole(role)` (role visibility),
  `isCapabilityEnabledForTenant(id, tenant)` (jkiss uses `enabledForJkiss`;
  unknown tenants get nothing yet), `aiEligibleCapabilities()` (AI-tool
  eligibility).
- **J KISS retains every currently working capability** — the enabled set for
  tenant `jkiss` matches today's live features; planned-but-absent capabilities
  (customers, expenses, organizations, approvals) are marked not-enabled.

## Not done
Per-tenant capability configuration (beyond jkiss), and any UI surface — deferred.
