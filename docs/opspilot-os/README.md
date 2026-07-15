# Operion — Enterprise Architecture Blueprint

> **Status: assessment & documentation only.** No production code, schema, or
> data was changed to produce this blueprint. Every claim is cited to `file:line`
> against the working tree of `~/jkissllc`; the original assessment was taken on
> branch `main` as of **2026-07-12**, and the blueprint was reconciled against
> current repository reality on **2026-07-14** (see `CHANGELOG.md`).

> **Naming & source-of-truth note.** The platform's official product name is
> **Operion**. This is the **Operion Enterprise Blueprint**, and it is the single
> authoritative architecture source. The directory is still named
> **`docs/opspilot-os/`** — retained deliberately for link/repo stability, not
> renamed. Likewise the codebase keeps its original internal identifiers
> (`opspilot:` Redis key family, `/api/opspilot/*` routes, `app/lib/platform/`
> modules, component/env names) as **legacy compatibility identifiers**; renaming
> those would break working data, APIs, and deploys, so they change only through a
> separate compatibility migration — never as part of this documentation update.
> Throughout these docs, product/brand references say **Operion**; a lingering
> "OpsPilot" is either a legacy internal identifier (kept on purpose) or, if in
> prose, a stale reference being corrected.

This directory is the evidence-based Enterprise Architecture Blueprint and
Migration Plan for transforming the J KISS LLC application (**Operion**) from a
single-tenant internal operations platform into a multi-tenant AI Business
Operating System for field-service companies.

It supersedes and corrects `docs/opspilot-multi-tenant-roadmap.md`, which was
written 2026-07-08 and is now **stale in several material ways** (see
`01-current-state-assessment.md` §0). The older roadmap remains useful for its
Redis key inventory; where the two disagree, **this blueprint is authoritative.**

## Status Update — 2026-07-14 (platform now branded **Operion**)

This blueprint was **reconciled with shipped work on 2026-07-14**: every document
below was compared against the current repository and updated in place, and the
product brand was changed **OpsPilot → Operion** in prose/titles/diagram labels
(public page `/operion`, `PLATFORM.name = 'Operion'`; `/opspilot` 301-redirects).
Internal identifiers (the `app/lib/platform/` folder, `opspilot:` Redis key family,
`/api/opspilot/*`, component/branch names) were intentionally **left unchanged as
legacy compatibility identifiers**. Full detail is in [`CHANGELOG.md`](CHANGELOG.md);
the summary of what shipped since the 2026-07-12 baseline follows.

**What has shipped since 2026-07-12 (this blueprint's baseline):**

- **S1 — Tenant Context Wiring (the recommended tenancy foundation) is DONE and on `main`/prod.** `withTenantRoute` now establishes per-request tenant context on **104 request handlers** + explicit per-tenant context on **3 crons + 3 webhooks**. `TENANCY_ENABLED` remains **false**, so it is a **live no-op** (byte-identical behavior); the `app/lib/redis.ts` chokepoint fails **closed** if the flag is flipped without context, and a `scripts/bypass-detection.test.ts` CI gate blocks any Redis bypass. See `05-multi-tenant-architecture.md` + `tenant-isolation/`.
- **Isolated dark-launch preview provisioned.** A separate Upstash Redis (`OperionPreview`) + Blob store (`operion-preview-blob`) back the Vercel **Preview** environment, with `TENANCY_DARK_LAUNCH=true` (and `TENANCY_ENABLED=false`) **Preview-only**. Preview is now data-isolated from Production. Dark-launch telemetry validation (exercise workflows → inspect `tenancy:dark-launch-mismatch`) is the next gate before activation; **not yet performed** (needs a browser walkthrough).
- **CI hardened to a blocking full gate.** `.github/workflows/ai-regression.yml` was AI-only; it now runs **tsc → full `npm test` (586 cases, incl. tenant-isolation, bypass-detection, rbac, authorization-coverage, security-hardening, AI regression) → `next build`** on Node 24 (pinned via `engines` + `.nvmrc`). Test count grew 296 → **586**.
- **Book Now admin redesign shipped to prod** — `/admin/operations/book-now` is now an enterprise dashboard (KPI row, toolbar, grouped-accordion filters, full-width table with sort/bulk, slide-over drawer). **UI-only; all APIs/filters/actions preserved.**
- **Admin auth reconciled** — `ADMIN_PASSWORD` unified from `.env.local` across Production/Preview/Development; a too-short 89-day-old Production `ADMIN_SESSION_SECRET` was rotated (the min-16-char check now enforced; doc encryption unaffected as it derives from `DOC_ENCRYPTION_KEY`).

**Activation still blocked** (before `TENANCY_ENABLED` can flip): Blob paths are not tenant-scoped; `ai:*` prompts/telemetry are platform-global (shared); name-derived key collisions (`businesses.ts` `bizKey` → payroll, `job-learning.ts`); the tenant data migration must run under `DARK_LAUNCH → DUAL_WRITE`; and public routes need host-based tenant resolution. These are unchanged from `05-multi-tenant-architecture.md`.

_(Deferred: a separate `docs/operion/` governance layer — scored maturity scorecard, YAML registers, sprint/ADR templates — was scoped but intentionally NOT built, to avoid a competing source of truth. This blueprint remains the single authority.)_

## How to read this

| Doc | What it answers |
|---|---|
| [00-executive-summary.md](00-executive-summary.md) | The 10-minute version: classification, top findings/risks, recommended path |
| [01-current-state-assessment.md](01-current-state-assessment.md) | What exists today, cited — stack, providers, boundaries |
| [02-repository-map.md](02-repository-map.md) | Directory/module map, critical paths, coupling, dead code |
| [03-capability-matrix.md](03-capability-matrix.md) | 47 capabilities, status + evidence |
| [04-domain-model.md](04-domain-model.md) | Current domains + proposed target domain model |
| [05-multi-tenant-architecture.md](05-multi-tenant-architecture.md) | Tenancy model, isolation, the migration chokepoints |
| [06-industry-module-strategy.md](06-industry-module-strategy.md) | Platform core vs industry packs vs tenant config |
| [07-ai-operating-layer.md](07-ai-operating-layer.md) | Governed AI: existing LLMOps + the 9 assistants + action levels 0–5 |
| [08-event-and-workflow-architecture.md](08-event-and-workflow-architecture.md) | Business-event taxonomy, producers/consumers, sync vs async |
| [09-data-architecture.md](09-data-architecture.md) | Redis data model, tenant ownership, audit/retention, outbox |
| [10-security-risk-register.md](10-security-risk-register.md) | Threat review + Critical/High/Medium/Low register |
| [11-ux-and-design-system.md](11-ux-and-design-system.md) | UX findings, IA, design-system direction |
| [12-observability-and-operations.md](12-observability-and-operations.md) | Logs, monitoring, AI tracing, runbooks, kill switches |
| [13-testing-and-ai-evaluation.md](13-testing-and-ai-evaluation.md) | Test strategy + AI eval (injection, leakage, hallucination) |
| [14-target-architecture.md](14-target-architecture.md) | Current → transitional → target, with Mermaid diagrams |
| [15-migration-roadmap.md](15-migration-roadmap.md) | Phased plan (0–10) with rollback, acceptance, complexity |
| [16-first-sprint-plan.md](16-first-sprint-plan.md) | The safest first sprint, in detail |
| [17-open-questions.md](17-open-questions.md) | What still needs verification |
| [18-architecture-decisions-needed.md](18-architecture-decisions-needed.md) | Decisions only the owner can make |
| [19-assessment-verification.md](19-assessment-verification.md) | Re-verification passes (incl. 2026-07-14 reconciliation) |
| [20-security-hardening-sprint.md](20-security-hardening-sprint.md) | Security-hardening sprint: shipped vs open items |
| [21-design-system-foundation.md](21-design-system-foundation.md) | Design-system foundation (reference-only, flag-gated) |
| [CHANGELOG.md](CHANGELOG.md) | Dated blueprint changelog — what changed in code & which docs updated |
| [diagrams/](diagrams/) | Mermaid sources for all system diagrams |

## Ground rules honored in this assessment

- No broad rewrite proposed. No schema migration authored or run. No files or
  dependencies deleted. No secrets printed.
- Facts (code-verified) are separated from Assumptions (inference) throughout.
- Recommendations are scoped to be realistic for a founder-led product; no
  premature microservices, no enterprise stack for its own sake.
- J KISS production continuity is treated as a primary constraint.

## The one-paragraph conclusion

Operion is a **genuinely capable, well-engineered operations platform** with an
unusually mature governed-AI subsystem and clean security fundamentals. It is
still **single-company in behavior** — J KISS LLC is the one live tenant and
`TENANCY_ENABLED` is `false` — but as of **2026-07-14 the tenant-context
foundation has shipped**: the recommended `AsyncLocalStorage` tenant context now
wraps **104 request handlers** plus 3 crons and 3 webhooks, every Redis key flows
through a fail-closed `scopeKey()` chokepoint (guarded by a `bypass-detection`
CI gate), and an isolated dark-launch Preview environment is provisioned. So the
earlier "tenancy is not modeled / no request carries a tenant" framing is now
**partially out of date**: the context plumbing exists and is inert; what remains
before activation is data-level scoping (Blob paths, `ai:*` globals, name-derived
key collisions), the tenant data migration under `DARK_LAUNCH → DUAL_WRITE`, and
host-based public-route resolution — plus moving from a single shared owner
password to per-owner identity. The path to a multi-tenant AI Business OS remains
**tractable and sequenced**, because isolation and authorization each funnel
through a single chokepoint. The near-term architecture is the **modular monolith
on Redis with an `AsyncLocalStorage` tenant context** — now realized in plumbing,
not yet activated — not a rewrite and not a premature database swap.
