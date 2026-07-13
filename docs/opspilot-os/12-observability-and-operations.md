# 12 — Observability & Operational Readiness (Phase 11)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12. Current = **FACT**;
> target = **RECOMMENDATION**, sized for a founder-led team.

## 1. Current state (FACT)

| Concern | Status |
|---|---|
| Error monitoring / APM | **None** (no Sentry/Datadog/OTel — grep zero) |
| Structured logging | **None** — `console.error` + fail-soft |
| AI request tracing / cost | **Present (custom)** — `ai/telemetry.ts`, `analytics.ts`, `budget.ts` |
| Web analytics | `@vercel/analytics` (one `<Analytics/>`, `layout.tsx:115`) |
| Notification delivery tracking | Partial — booking notification ledger; crew push degrades to in-app |
| Audit logs | Partial — central `audit.ts` (comms only), per-record coarse actor |
| Health checks | **None** |
| Uptime / synthetic | **None** |
| Alert routing | Owner SMS/email on business events (`owner-alerts.ts`) — not infra alerts |
| Backups / recovery | **Unverified** — relies on Upstash/Vercel Blob durability (ASSUMPTION) |
| Deploy rollback | Vercel instant rollback (platform capability) |
| Feature flags / kill switches | Ad hoc (`withSmsSuppressed`, AI budget cap) — no system |

The AI subsystem is the one place with real observability; the rest of the app is
effectively unmonitored.

## 2. Recommended operational-readiness model (RECOMMENDATION)

Prioritized so a small team gets 80% of the value from the first three items.

### Tier 1 — do first (cheap, high value)
1. **Error monitoring:** add **Sentry** (Next.js SDK) — the single biggest gap;
   captures server + client errors, releases, and traces with minimal code.
2. **Structured logging:** a thin `logger` wrapper emitting JSON
   (`{ ts, level, tenantId, userId, route, msg, ... }`) — replace bare
   `console.error`; **never log secrets** (already the discipline — keep it).
3. **Health check:** a `/api/health` that pings Redis + Blob + AI Gateway
   reachability; wire to an uptime monitor (Better Uptime / Vercel).

### Tier 2 — before first external tenant
4. **AI action tracing:** extend the existing AI telemetry to cover Level-3+
   actions (`AiActionLog`) with approval + rollback status (`07-...`).
5. **Notification delivery tracking:** unify the booking notification ledger +
   crew fan-out into one delivery log with provider status (Resend/Twilio
   webhooks), surfaced per tenant.
6. **Background-job monitoring:** record each cron run's start/end/outcome +
   outbox depth + dead-letter count (`08-...`); alert on failure or backlog.
7. **Kill switches:** formalize a flag system (Tier below) with a **global +
   per-tenant AI-action kill switch** and a notification kill switch (the
   `withSmsSuppressed` pattern generalized).

### Tier 3 — enterprise readiness
8. Performance/DB monitoring (Upstash metrics), synthetic tests on the
   quote→pay→confirm critical path, alert routing + severity + on-call, documented
   runbooks, backup/recovery **testing** (not just assumed durability), and a
   data-retention/erasure job.

## 3. Feature-flag & kill-switch system (RECOMMENDATION)

Replace the ad-hoc gates with a small typed flag module (Redis-backed, tenant +
global scope), reusing the layered-config pattern from `06-...`:

```
Flag scope: global | tenant
Kinds: killSwitch (AI actions, SMS, email, cron), rollout (new module %), config
Resolution: tenant override ⟶ global default ⟶ code default
```

Must-have switches at launch: **AI-action kill switch** (global + per-tenant),
**notification kill switch** (generalize `withSmsSuppressed`), **new-tenant
gate**, and a **per-module rollout** flag for dark-launching the tenancy work
(`16-...`).

## 4. Runbooks to author (RECOMMENDATION)

Minimum set: "Redis outage" (fail-open surfaces — auth, rate-limit — behave how?),
"Stripe webhook backlog", "cron failed / didn't run", "AI provider outage or cost
spike", "tenant reports missing data", "restore a record". Keep them short and
in-repo (`docs/runbooks/`).

## 5. What NOT to add yet

No full observability stack (Grafana/Prometheus/ELK). Sentry + structured logs +
Upstash/Vercel built-in metrics + the existing AI telemetry cover this product's
scale. Add heavier tooling only when tenant count or incident rate demands it.
