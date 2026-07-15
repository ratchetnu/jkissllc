# 15 — Migration Roadmap (Phase 14) — Operion

> Preserves the current J KISS production app throughout. Cited to `~/jkissllc@main`,
> originally 2026-07-12. **No schema migration authored or run.** Each phase:
> objective · scope · dependencies · data/code/security/UX implications · tests ·
> acceptance · rollback · risks · complexity · what must NOT change yet.
>
> _(Updated 2026-07-14: platform is now branded **Operion** (`PLATFORM.name =
> 'Operion'` in `app/lib/company.ts`; public `/operion`, `/opspilot`→301). Internal
> identifiers — `opspilot:` Redis prefix, `app/lib/platform/` paths, `docs/opspilot-os/`,
> `/api/opspilot/*` — are preserved as **legacy identifiers** for compatibility.
> **Phase 0 and the tenant identity/context phase are now COMPLETE — shipped to
> `main` + prod as "S1"** (see status banner). The next verified step is
> **dark-launch validation**, then the S2 group below.)_

## Status banner _(2026-07-14)_

- ✅ **Phase 0 — Stabilize & document: COMPLETE.** Security drift closed (M1/M2/L1
  fail-closed, H2 coverage test), CI is a **blocking** gate.
- ✅ **Phase 1 — Tenancy & authorization (identity + context): COMPLETE as S1.**
  Per-request tenant context on **104 handlers** + `withBackgroundTenant` on **3
  crons + 3 webhooks**; `app/lib/redis.ts` `scopeKey()` fails **closed**;
  `TENANCY_ENABLED=false` → **live no-op / byte-identical**. Details:
  `16-first-sprint-plan.md` §Executed.
- ⏭️ **Next (Stage 0):** **dark-launch validation** in the isolated Preview
  (`OperionPreview` Redis + `operion-preview-blob`) — exercise workflows, inspect
  `tenancy:dark-launch-mismatch` telemetry. Status: **DARK-LAUNCH READY, NOT YET
  VERIFIED.**
- 🔜 **S2 (was Phase 2):** Blob path scoping · `ai:*` prompt/telemetry scoping ·
  name-derived key-collision fixes (`businesses.ts` bizKey→payroll,
  `job-learning.ts`) · tenant data migration under `DARK_LAUNCH`→`DUAL_WRITE` ·
  public-route host-based tenant resolution.

Ordering follows the standard sequence, adjusted for evidence: **the four §1
defects are already fixed**, so Phase 0 was lighter than the old roadmap assumed;
and because storage is Redis, "row-level security" = key-prefix isolation.

---

## Phase 0 — Stabilize & document — ✅ COMPLETE (S1)
- **Objective:** lock a clean baseline; close cheap security drift; no behavior change.
- **Scope:** these docs (done); ADRs (`docs/adr/`); fix fail-open webhooks/cron
  (M1, L1); replace `Math.random` reminder ack token (M2); add the
  authorization-coverage test (H2 detection); enable CI branch protection.
- **Data:** none. **Code:** tiny, surgical. **Security:** closes M1/M2/L1, detects H2.
- **Tests:** authorization-coverage + webhook fail-closed regression.
- **Acceptance:** CI blocking + green; no functional change to J KISS flows.
- **Rollback:** revert commits (isolated, no data touched).
- **Risk:** minimal. **Complexity:** S. **Do NOT change yet:** data model, auth shape.

## Phase 1 — Establish tenancy & authorization — ✅ COMPLETE (S1) _(Updated 2026-07-14)_
- **Objective:** make the session tenant-aware and establish per-request tenant
  context. **Done.**
- **Delivered:** `SessionPayload` gained `tid`; `requireTenantSession` resolves a
  tenant-scoped principal; **per-handler** tenant context via
  `app/lib/platform/tenancy/with-tenant-route.ts` (`withTenantRoute` on **104
  request handlers**) + `withBackgroundTenant` on **3 crons + 3 webhooks**. Behind
  `TENANCY_ENABLED` (default **off**) → still one tenant, one row, byte-identical.
  Note the `19-...` correction: ALS is established **per-handler** via
  `runWithTenant`, **not** in `proxy.ts` (which only strips inbound `x-tenant-id`).
- **Dependencies:** Phase 0 flags/kill-switch module. **Met.**
- **Data:** tenant/membership keys additive under `platform:*`; **no rewrite of
  existing keys.** **Code:** guard signature + context plumbing shipped.
  **Security:** C2 mechanism **partially resolved** (session carries `tid`, 104
  handlers establish context) — the shared global HMAC secret + single shared
  owner `ADMIN_PASSWORD` **remain open** (`10-...`, `20-...`); H2 closed
  (coverage gate); H3 groundwork in place (`pushAuditFor`).
- **Tests:** principal + tenant-isolation + bypass-detection + authorization-coverage
  — all in the 586-case blocking suite.
- **Acceptance:** ✅ with flag off, prod identical; the isolated Preview is wired
  for the flag-on dark-launch check (see §Status banner → Next).
- **Rollback:** flag off (unchanged doctrine). **Risk:** was medium; delivered no-op.
- **Still NOT changed (deliberately deferred to S2):** Redis key **prefixing of
  existing data**, per-tenant credentials.

## Phase 2 (S2) — Establish shared domain boundaries + activate isolation _(Updated 2026-07-14)_
> Begins **only after** dark-launch validation is verified clean. Absorbs the
> remaining activation blockers: Blob path scoping, `ai:*` prompt/telemetry
> scoping, name-derived key-collision fixes, and public-route host resolution.
- **Objective:** thread the principal into audit + fix the isolation prerequisites
  that are data migrations, while still single-tenant.
- **Scope:** attribute `pushAudit`/central audit to `Principal.sub` (H3);
  convert `biz:{name}` → `biz:{bizId}` + rewrite `Staff.payByBusiness` maps
  (the seam-2 data migration, i.e. the `businesses.ts` bizKey→payroll
  name-collision fix) with a backfill script (direct-to-Upstash, no SCAN in
  client); fix the parallel name-derived collision in `job-learning.ts`;
  **scope Blob paths per tenant** (today all-global namespace); **scope `ai:*`
  prompts/telemetry per tenant** (today platform-global/shared); add **public-route
  host-based tenant resolution** (drop build-time `NEXT_PUBLIC_SITE_URL`,
  generalize `proxy.ts` host handling); run the tenant data migration **under
  `DARK_LAUNCH`→`DUAL_WRITE`**; introduce the `LedgerEntry` boundary (emit only,
  read later).
- **Data:** **first real data migration** (businesses + staff pay maps + Blob
  namespace + `ai:*` scope) — reversible, dual-read during cutover, gated by the
  `TENANCY_DUAL_WRITE` flag. **Security:** completes H3.
- **Gate:** dark-launch validation (`tenancy:dark-launch-mismatch` telemetry)
  reviewed clean first — see §Status banner.
- **Tests:** migration idempotency + equality (pay resolves identically), audit
  attribution.
- **Acceptance:** pay/finance outputs unchanged; audit shows named actors.
- **Rollback:** dual-read window; keep name-key lookup alias.
- **Risk:** medium (touches payroll). **Complexity:** M. **Do NOT change:** prefixing.

## Phase 3 — Configuration & feature flags
- **Objective:** the layered typed config + flag system (`06-...`, `12-...`).
- **Scope:** `TenantConfig` sections (branding, pricing, policy, evidence,
  automation) with typed validators + versioning (mirror `policy.ts`/`disposal.ts`);
  formal flag/kill-switch module (global + tenant).
- **Data:** config keys under `t:jkiss:cfg:*` seeded from today's values.
- **Acceptance:** J KISS renders/prices identically reading from config.
- **Rollback:** flags. **Risk:** low-medium. **Complexity:** M.

## Phase 4 — Separate J KISS-specific behavior into an industry/tenant pack
- **Objective:** extract `hauling-boxtruck` pack (`06-...`) — pure extraction.
- **Scope:** move services catalog, disposal defaults, LOAD_UNITS, ATS roles,
  disclaimer default, vehicle categories, job stages into pack data; icon-name
  registry (decouple compile-time icon imports); service areas → tenant config;
  address `cities.ts` static-generation question (`17-...` Q4).
- **Acceptance (the pack's test):** `t:jkiss` bound to `hauling-boxtruck` renders
  and prices **identically** to pre-extraction.
- **Rollback:** flag to pre-pack path. **Risk:** medium (wide surface). **Complexity:** L.

## Phase 5 — Standardize workflows & events
- **Objective:** typed event taxonomy + durable outbox + idempotent consumers
  (`08-...`); settle terminology (`11-...` D7).
- **Scope:** `emit(event)`, outbox drainer in cron, migrate inline side-effects to
  consumers incrementally; UI noun rename.
- **Acceptance:** notifications/audit/analytics flow through outbox; no lost sends.
- **Risk:** medium. **Complexity:** L.

## Phase 6 — Governed AI insights (Level 0–2)
- **Objective:** ship the 9 assistants at read/recommend/draft, on the existing
  pipeline + Context Service with **redaction + tenant-scoping** (M3).
- **Scope:** Context Service, retrieval (optional RAG), assistant views; keep
  `writes:false`.
- **Acceptance:** cross-tenant leakage + injection tests pass; no writes.
- **Risk:** low (advisory). **Complexity:** M.

## Phase 7 — Human-approved AI actions (Level 3)
- **Objective:** approval queue + action executor + `AiActionLog` + rollback.
- **Scope:** tool registry with `{permission, actionLevel, writes}`;
  `ApprovalRequest`; execute only approved tools under tenant ctx.
- **Acceptance:** no Level-3 execution without recorded approval; full audit.
- **Risk:** high (AI now acts). **Complexity:** L. **Gate:** all `13-...` AI tests.

## Phase 8 — Policy-bounded automations (Level 4)
- **Objective:** auto-execute within tenant-approved rules + hard caps + kill switch.
- **Scope:** only low-risk bounded actions (e.g. payment reminders); numeric caps;
  global + per-tenant kill switch mandatory.
- **Risk:** high. **Complexity:** M. Never promote L5 actions here.

## Phase 9 — Tenant onboarding & billing
- **Objective:** self-serve/assisted onboarding + Stripe Connect + plans/metering.
- **Scope:** provisioning flow (`Tenant` create → seed config → domain map →
  credentials), Connect (reshapes the 6 Stripe call sites, H1), plan/limits gate
  at `requireTenantSession`, per-tenant metering (AI already metered).
- **Risk:** high (money). **Complexity:** L. **Gate:** C1/C2/C3/H1 all closed.

## Phase 10 — Commercial-readiness hardening
- **Objective:** enterprise gates — MFA, session revocation, retention/erasure/
  export, backup-recovery testing, SOC-2-adjacent audit completeness, load tests,
  runbooks, per-tenant data-residency decision.
- **Risk:** medium. **Complexity:** L.

---

## Work division

_(Updated 2026-07-14: the "Immediate" column is **done** — Phase 0 + Phase 1
context wiring shipped as S1. "Now" is dark-launch validation.)_

| Done (S1, shipped) | Immediate (now) | Next (S2) | Later / deferred |
|---|---|---|---|
| ✅ Phase 0; Phase 1 tenant identity + per-handler context (104 handlers, 3 crons, 3 webhooks) | Dark-launch validation in isolated Preview (inspect `tenancy:dark-launch-mismatch`) | Redis prefixing activation; Blob + `ai:*` scoping; name-key fixes; data migration under DUAL_WRITE | Phases 3–6; then 7–10 until GA scope approved |
| ✅ Close M1/M2/L1/H2; auth-coverage + bypass-detection CI gates | Triage mismatch classes into S2 | Public-route host-based tenant resolution | Industry pack #2; Postgres (until billing); Event/outbox; Microservices (never, at this scale) |

## Cross-cutting rollback doctrine
Every phase is **flag-gated and dual-read where data changes**, so any phase can
be disabled without data loss. `t:jkiss` must remain byte-identical to today
until a phase's acceptance test proves equality. Vercel instant-rollback covers
deploy-level regressions.
