# 06 — Industry Module Strategy (Phase 5)

> RECOMMENDATION, grounded in cited current-state facts.

## 1. Principle

Keep a thin, industry-neutral **Platform Core** and push everything a vertical
cares about into a versioned **Industry Pack** plus per-tenant **Tenant Config**.
The test for "does this belong in core?": *would a plumber and a junk-hauler both
need it, unchanged?* If yes → core. If the shape is shared but the values differ
→ core interface + pack/tenant data. If the concept itself differs → pack.

## 2. Three layers

### A. Platform Core (industry-neutral)
Identity, Tenancy, Permissions, Customers/CRM, Jobs, Scheduling, Messaging,
Notifications, Files, Billing, Analytics, Automation, AI, Audit. These are the
domains in `04-domain-model.md` marked "Core." They must not contain a single
`if (industry === 'hauling')` branch — behavior varies through data (pack +
config), never through hardcoded conditionals.

### B. Industry Packs (versioned data + optional logic modules)
An Industry Pack may define: terminology, service templates, pricing model
shape, intake questions, quote logic, required evidence, job stages, equipment
categories, crew requirements, compliance requirements, customer communication
templates, default dashboards, automation templates, and AI instructions.

**J KISS is the reference pack: `hauling-boxtruck`.** Building it means
*extracting* today's hardcoded assumptions into pack data — not writing new
features. Concretely, the extraction targets (all cited):

| Today (hardcoded) | Becomes pack data |
|---|---|
| `services.ts` catalog + compile-time icons | `pack.services[]` + icon-name registry |
| `disposal.ts` `DEFAULT_DISPOSAL` ("calibrated from the brush job") | `pack.pricing.hauling` seed values |
| `availability.ts` `LOAD_UNITS` (box-truck day consumption) | `pack.capacity.model` |
| `ats-config.ts` Position union + payPerDay + "operate a 26' box truck" | `pack.roles[]` + `pack.requirements[]` |
| `routes.ts` `CONFIRM_DISCLAIMER` | `pack.legal.contractorDisclaimer` (tenant-overridable) |
| `new/page.tsx:10` `VEHICLE='Box truck'` | `pack.equipmentCategories[]` |
| `cities.ts` DFW copy + static params | `tenant.serviceAreas[]` (NOT pack — tenant-specific) |
| Job status set | `pack.jobStages[]` |

**Sequencing (RECOMMENDATION):** build `hauling-boxtruck` first (pure extraction,
zero new behavior, proves the pack seam). The second pack choice is an owner
decision (`18-...` D5) — the lowest-effort second vertical is **moving/delivery**
(shares crew+route+equipment shape); **skilled trades** (HVAC/plumbing/electrical)
is higher value but needs new concepts (dispatch windows, parts, service
agreements) so it validates the pack model harder.

### C. Tenant Configuration (per-tenant values)
A tenant configures: branding/logo/colors, business info, locations, service
areas, operating hours, services offered (subset of pack), prices, fees,
deposits, cancellation rules, confirmation rules, time-off policy, required
photos, clock-in/GPS requirements, equipment, roles/permissions, notification
channels, message templates, automations, and AI approval limits.

## 3. How to store config without unmaintainable JSON blobs (RECOMMENDATION)

The current code already hints at the right pattern: `disposal.ts` stores a
config blob in Redis (`cfg:disposal`) **merged over typed defaults**, and
`policy.ts` keeps **versioned** policy (`policy:current` + `policy:v:{n}`).
Generalize that:

1. **Typed schema, not free JSON.** Each config section has a TypeScript type +
   a runtime validator (reuse the dependency-free validator pattern in
   `app/lib/ai/schema.ts`). Reject writes that don't validate.
2. **Layered resolution:** effective value = `tenant override` ⟶ `industry pack
   default` ⟶ `platform default`. One `resolveConfig(section)` helper, mirroring
   how `disposal.ts` merges over `DEFAULT_DISPOSAL`.
3. **Versioned + audited:** every config write creates a new version
   (`t:{tid}:cfg:{section}:v:{n}` + `:current`), mirroring `policy.ts`. Enables
   rollback and "who changed the cancellation fee" audit.
4. **Section-scoped, not one mega-blob:** branding, pricing, policy, evidence,
   automation each get their own key so writes don't contend and permissions can
   gate per section (`settings:manage` vs a future `pricing:manage`).
5. **No secrets in config blobs** — credentials live in the credential store
   (`05-...` §6), referenced by id.

## 4. What stays out of packs (FACT-informed)

- **Legal text is tenant-overridable, not pack-fixed** — `CONFIRM_DISCLAIMER`
  and cancellation policy carry liability; a pack ships a default, the tenant
  (and their counsel) owns the final text.
- **Service areas / cities are tenant, not pack** — `cities.ts` is DFW-specific
  to J KISS, not to hauling generally; and it drives `generateStaticParams`, so
  per-tenant service areas raise a real Next.js question (see `14-...` and
  `17-open-questions.md` Q4): move city landing pages to on-demand ISR or a
  tenant-scoped dynamic segment rather than build-time static generation.

## 5. Migration note

Extracting the `hauling-boxtruck` pack is **Phase 4** of the roadmap
(`15-migration-roadmap.md`) and must be behavior-preserving: after extraction,
`t:jkiss` bound to `hauling-boxtruck` must render and price **identically** to
today. That equality is the pack's acceptance test.
