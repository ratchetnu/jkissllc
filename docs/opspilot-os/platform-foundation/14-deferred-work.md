# 14 — Deferred Work (explicitly NOT done this sprint)

By design — this is a foundation sprint (contracts + registries + governance +
tests), not a feature build. Rule 16: do not build all future features now.

## Data / tenancy
- **Live Redis key prefixing** in `redis.ts` `call()` (blocker C1) — the
  `tenant-store.ts` contract exists but is not wired to the live client.
- **Name-derived-key migration** (`biz:{name}`, `Staff.payByBusiness`, `learn:*`)
  — blocker C3, a data migration.
- **Postgres** — not introduced (Redis-first holds).

## Auth / security
- **Full `pushAudit` → `pushAuditFor` rollout** to all ~40 call sites (mechanism
  in place; only the highest-value sites migrate later).
- **Fine-grained `requirePermission` conversion** of coarse `requireSession`
  routes (coverage test prevents *un*guarded routes meanwhile).
- **Stripe Connect** (blocker H1), MFA, session revocation, retention/erasure.

## AI
- **Wiring AI workers into live `runAiTask`**, the **context/redaction service**,
  RAG/retrieval, the **action executor** + approval persistence, and the
  conversational interface. No autonomous action exists yet (intended).

## Platform
- **Durable Redis outbox** + real producers/consumers + dead-letter.
- **Per-tenant capability/pack configuration** and a tenant-facing pack editor.
- **Extraction of J KISS hardcoded assumptions** into the pack at runtime (Phase 4).
- **Insight live-data wiring** + the remaining category generators + insight UI.
- **Role-adaptive nav production cutover** (IA validated; cutover pending owner OK).
- **Observability wiring** through call sites + Sentry/health/uptime.
- **DOM/e2e/visual/load test harnesses.**

## Product gaps surfaced (tracked)
No first-class Customer/Quote/Change-Order/Expense entity; two unreconciled money
domains; `customers` workspace destination has no current home (`route-map.ts`).
