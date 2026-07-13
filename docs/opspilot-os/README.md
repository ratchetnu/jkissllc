# OpsPilot OS — Enterprise Architecture Blueprint

> **Status: assessment & documentation only.** No production code, schema, or
> data was changed to produce this blueprint. Every claim is cited to `file:line`
> against the working tree of `~/jkissllc` on branch `main` as of **2026-07-12**.

This directory is the evidence-based Enterprise Architecture Blueprint and
Migration Plan for transforming the J KISS LLC application ("OpsPilot") from a
single-tenant internal operations platform into a multi-tenant AI Business
Operating System for field-service companies.

It supersedes and corrects `docs/opspilot-multi-tenant-roadmap.md`, which was
written 2026-07-08 and is now **stale in several material ways** (see
`01-current-state-assessment.md` §0). The older roadmap remains useful for its
Redis key inventory; where the two disagree, **this blueprint is authoritative.**

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
| [diagrams/](diagrams/) | Mermaid sources for all system diagrams |

## Ground rules honored in this assessment

- No broad rewrite proposed. No schema migration authored or run. No files or
  dependencies deleted. No secrets printed.
- Facts (code-verified) are separated from Assumptions (inference) throughout.
- Recommendations are scoped to be realistic for a founder-led product; no
  premature microservices, no enterprise stack for its own sake.
- J KISS production continuity is treated as a primary constraint.

## The one-paragraph conclusion

OpsPilot is a **genuinely capable, well-engineered single-tenant operations
platform** with an unusually mature governed-AI subsystem and clean security
fundamentals — but it is **single-company by construction**: storage is Upstash
Redis with un-prefixed global keys, identity is centralized in one config object
but tenancy is not modeled, and authorization is multi-*user* but not
multi-*org*. The path to a multi-tenant AI Business OS is **tractable and
sequenced**, because isolation and authorization each funnel through a single
chokepoint. The recommended near-term architecture is a **modular monolith on
Redis with an `AsyncLocalStorage` tenant context**, not a rewrite and not a
premature database swap.
