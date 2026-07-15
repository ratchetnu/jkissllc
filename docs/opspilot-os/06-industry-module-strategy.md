# 06 — Industry Module Strategy (Phase 5)

> Platform brand: **Operion** (J KISS LLC is its first production tenant). Internal
> identifiers — the `docs/opspilot-os/` path, the `opspilot:` Redis key family, and
> component names like `OpsPilotMark` — are retained verbatim as legacy identifiers
> for compatibility.
>
> _(Updated 2026-07-14: the pack seam this doc recommended is now **SCAFFOLDED** in
> `app/lib/platform/industry-packs/` and `app/lib/platform/capabilities/`, flag-gated
> off. What follows separates FACT (what now exists in code) from RECOMMENDATION
> (the extraction work still ahead).)_

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

_(Updated 2026-07-14 — FACT: the neutral core is now enumerated as a **frozen
37-capability registry** in `app/lib/platform/capabilities/` (`CAPABILITY_IDS`
+ typed `Capability` records with domain, status, dependencies, required
permissions/flags, supported roles, AI actions, and per-tenant/tier eligibility).
`validate.ts` enforces integrity via DFS cycle-detection over the dependency
graph. The registry is pure data: its query layer (`index.ts`) is gated by
`CAPABILITY_REGISTRY_ENABLED` (**ON**, but it only exposes inert configuration —
nothing live reads it yet), so importing it changes no runtime behavior. Each
industry pack's `supportedCapabilities` references these ids, binding the pack
seam to the core vocabulary.)_

### B. Industry Packs (versioned data + optional logic modules)
An Industry Pack may define: terminology, service templates, pricing model
shape, intake questions, quote logic, required evidence, job stages, equipment
categories, crew requirements, compliance requirements, customer communication
templates, default dashboards, automation templates, and AI instructions.

_(Updated 2026-07-14 — FACT: the `IndustryPack` contract now exists as typed data
in `app/lib/platform/industry-packs/types.ts`, carrying exactly these fields —
`terminology`, `serviceTemplates`, `pricingMethods`, `intakeQuestions`,
`jobStages`, `evidenceRequirements`, `equipmentCategories`, `workerRequirements`,
`customerCommunications`, `automationTemplates`, `aiWorkerInstructions` (keyed by
`WorkerId` from the AI-workers registry), `dashboardPriorities`, `complianceRules`,
and a `supportedCapabilities: CapabilityId[]` link into the capability registry.
Two packs are registered in `registry.ts`: **`jkiss-field-service`** (the J KISS
reference pack, `enabledByDefault: true`) and **`cleaning-residential`** (a
deliberately skeletal second-vertical example, `enabledByDefault: false`, proving
the contract generalizes). `availablePacks()` is gated by `INDUSTRY_PACKS_ENABLED`
(**OFF**), so today only the default-on J KISS pack is ever offered — single-vertical
behavior is preserved.)_

**J KISS is the reference pack — registered as `jkiss-field-service`** (display
name "Box-Truck Delivery, Hauling & Moving", covering appliance/final-mile
delivery, box-truck ops, hauling, moving, junk removal and cleanouts). Its pack
data already mirrors today's vocabulary (Route/Operations/Crew/Business), the
`RouteStatus` lifecycle as `jobStages`, and truck-utilization vs flat vs hourly
`pricingMethods`. The remaining work is to make the live code *read* from the pack
instead of its hardcoded sources — *extracting* today's assumptions into pack data,
not writing new features. Concretely, the extraction targets (all cited):

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

**Sequencing (RECOMMENDATION):** finish wiring the live code to read from the
`jkiss-field-service` pack first (pure extraction, zero new behavior, proves the
pack seam). The second *production* pack choice is an owner decision (`18-...` D5)
— the lowest-effort second vertical is **moving/delivery** (shares
crew+route+equipment shape); **skilled trades** (HVAC/plumbing/electrical) is
higher value but needs new concepts (dispatch windows, parts, service agreements)
so it validates the pack model harder. _(Updated 2026-07-14: the registered
`cleaning-residential` pack is only a **skeletal shape example** proving the
contract generalizes — it is `enabledByDefault: false`, has no tenant editor, and
is not the chosen second vertical.)_

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
2. **Layered resolution:** effective value = `override` (location/service) ⟶
   `tenant` ⟶ `industry pack default` ⟶ `platform default`. _(Updated 2026-07-14 —
   FACT: this helper now exists as `resolveConfig(base, layers)` in
   `app/lib/platform/industry-packs/config.ts`, with the precedence order exported as
   `CONFIG_PRECEDENCE = ['override','tenant','pack','platform']`. It mirrors how
   `disposal.ts` merges over `DEFAULT_DISPOSAL`, generalized across the four layers, so
   no call site hand-merges and drifts.)_
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

_(Updated 2026-07-14: the pack **data** now exists as scaffold; the remaining
migration work is repointing live code to read it.)_ Completing the
`jkiss-field-service` extraction is **Phase 4** of the roadmap
(`15-migration-roadmap.md`) and must be behavior-preserving: after the live code
reads from the pack, `t:jkiss` bound to `jkiss-field-service` must render and price
**identically** to today. That equality is the pack's acceptance test.

## 6. Maturity (2026-07-14)

| Element | Evidence | Maturity |
|---|---|---|
| Capability registry (37 caps) | `app/lib/platform/capabilities/` + `validate.ts` | **MVP** — frozen typed data + integrity tests; inert (query layer reads nothing live) |
| Industry-pack contract | `industry-packs/types.ts` | **MVP** — typed contract, cited fields |
| J KISS reference pack data | `industry-packs/jkiss.ts` | **Prototype** — data authored; live code not yet reading it |
| Example second pack | `industry-packs/example-cleaning.ts` | **Prototype** — shape example, disabled, no editor |
| Layered config resolver | `industry-packs/config.ts` | **MVP** — `resolveConfig` + precedence, unit-shaped |
| Live extraction (code reads pack) | — | **Planned** — the Phase-4 work; flag `INDUSTRY_PACKS_ENABLED` still OFF |

Overall the module is **scaffolded / flag-gated, not activated**: the seams and
data exist, but production code paths still read their hardcoded sources.
