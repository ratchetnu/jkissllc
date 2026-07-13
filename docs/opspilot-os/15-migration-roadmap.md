# 15 — Migration Roadmap (Phase 14)

> Preserves the current J KISS production app throughout. Cited to `~/jkissllc@main`,
> 2026-07-12. **No schema migration authored or run.** Each phase: objective ·
> scope · dependencies · data/code/security/UX implications · tests · acceptance ·
> rollback · risks · complexity · what must NOT change yet.

Ordering follows the standard sequence, adjusted for evidence: **the four §1
defects are already fixed**, so Phase 0 is lighter than the old roadmap assumed;
and because storage is Redis, "row-level security" = key-prefix isolation.

---

## Phase 0 — Stabilize & document
- **Objective:** lock a clean baseline; close cheap security drift; no behavior change.
- **Scope:** these docs (done); ADRs (`docs/adr/`); fix fail-open webhooks/cron
  (M1, L1); replace `Math.random` reminder ack token (M2); add the
  authorization-coverage test (H2 detection); enable CI branch protection.
- **Data:** none. **Code:** tiny, surgical. **Security:** closes M1/M2/L1, detects H2.
- **Tests:** authorization-coverage + webhook fail-closed regression.
- **Acceptance:** CI blocking + green; no functional change to J KISS flows.
- **Rollback:** revert commits (isolated, no data touched).
- **Risk:** minimal. **Complexity:** S. **Do NOT change yet:** data model, auth shape.

## Phase 1 — Establish tenancy & authorization
- **Objective:** model `Tenant` + `Membership`; make the session tenant-aware.
- **Scope:** `Tenant`/`User`/`Membership` types + `t:jkiss` seed byte-identical to
  today; `SessionPayload` gains `tid`; `requireTenantSession(req) →
  {tenantId,userId,role}`; `getPrincipal` returns tenant-scoped principal;
  `AsyncLocalStorage` tenant context set in `proxy.ts`. **Behind a
  `TENANCY_ENABLED` flag defaulting off**; still one tenant, one row.
- **Dependencies:** Phase 0 flags/kill-switch module.
- **Data:** add tenant/membership keys under `platform:*`; **no rewrite of
  existing keys yet.** **Code:** signature change to guards (36 call-sites) +
  context plumbing. **Security:** fixes C2 mechanism; closes H2 (guards now
  permission-checked); begins H3 (principal available to `pushAudit`).
- **Tests:** principal tests, tenant-seed equality test, authorization-coverage.
- **Acceptance:** with flag off, prod identical; with flag on in preview, `t:jkiss`
  behaves identically and every guard resolves a tenant-scoped principal.
- **Rollback:** flag off. **Risk:** medium (auth is critical path). **Complexity:** M.
- **Do NOT change yet:** Redis key prefixing, credentials.

## Phase 2 — Establish shared domain boundaries
- **Objective:** thread the principal into audit + fix the isolation prerequisites
  that are data migrations, while still single-tenant.
- **Scope:** attribute `pushAudit`/central audit to `Principal.sub` (H3);
  convert `biz:{name}` → `biz:{bizId}` + rewrite `Staff.payByBusiness` maps
  (the seam-2 data migration) with a backfill script (direct-to-Upstash, no
  SCAN in client); introduce the `LedgerEntry` boundary (emit only, read later).
- **Data:** **first real data migration** (businesses + staff pay maps) — reversible,
  dual-read during cutover. **Security:** completes H3.
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

| Immediate (now) | Next (1–2 sprints) | Later | Explicitly deferred |
|---|---|---|---|
| Phase 0; Phase 1a (tenant/user seed + principal) | Phase 1b (context + prefix dark-launch); Phase 2 | Phases 3–6 | Phases 7–10 until GA scope approved |
| Close M1/M2/L1/H2 | Phase 2 data migration | Industry pack #2 | Postgres (until billing) |
| Auth-coverage test | Redis prefixing behind flag | Event/outbox | Microservices (never, at this scale) |

## Cross-cutting rollback doctrine
Every phase is **flag-gated and dual-read where data changes**, so any phase can
be disabled without data loss. `t:jkiss` must remain byte-identical to today
until a phase's acceptance test proves equality. Vercel instant-rollback covers
deploy-level regressions.
