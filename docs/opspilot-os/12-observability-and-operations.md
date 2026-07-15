# 12 — Observability & Operational Readiness (Phase 11)

> Product: **Operion** (J KISS LLC is the first production tenant). Cited to
> `file:line` on `~/jkissllc@main`, baseline 2026-07-12, refreshed 2026-07-14.
> Current = **FACT**; target = **RECOMMENDATION**, sized for a founder-led team.

## 1. Current state (FACT)

_(Updated 2026-07-14: health checks, an alert layer, and a typed flag/dark-launch
gate now exist; structured logging is written but still dormant. Table corrected
below.)_

| Concern | Status |
|---|---|
| Error monitoring / APM | **None** (no Sentry/Datadog/OTel — grep zero; unchanged) |
| Structured logging | **Written but DORMANT** — `app/lib/platform/observability/logger.ts` exists (with `redact.ts`) but has **0 importers**; runtime logging is still raw `console.*` + fail-soft |
| AI request tracing / cost | **Present (custom)** — `ai/telemetry.ts`, `analytics.ts`, `budget.ts` |
| Tenant/dark-launch telemetry | **Present** — `app/lib/platform/observability/tenant-telemetry.ts` (`recordTenantEvent`), imported by `tenancy/dark-launch.ts` + `tenancy/request-context.ts`; emits the `dark-launch-mismatch` event used as the tenancy validation gate |
| Web analytics | `@vercel/analytics` (one `<Analytics/>`, `app/layout.tsx:2`) |
| Notification delivery tracking | Partial — booking notification ledger; crew push degrades to in-app |
| Audit logs | Partial — central `audit.ts` (comms only), per-record coarse actor |
| Health checks | **Present** — `app/api/health/route.ts`: public minimal + admin/secret detailed; pings KV; **KV critical → HTTP 503**; reports per-service config (kv/blob/ai/stripe/email) |
| Uptime / synthetic | **None** (health endpoint exists but no external monitor wired) |
| Alert routing | Owner SMS/email on business events (`owner-alerts.ts`) **plus** `app/lib/alerts.ts` — formatted/deduped alerts, optional `ALERT_SLACK_WEBHOOK_URL` (Slack), else structured-console fallback; `/api/health` fires a `health_critical` alert on KV outage |
| Backups / recovery | **Unverified** — relies on Upstash/Vercel Blob durability (ASSUMPTION) |
| Deploy rollback | Vercel instant rollback (platform capability) |
| Feature flags / kill switches | **Typed module present** — `app/lib/platform/flags.ts` (env-driven, e.g. `TENANCY_ENABLED`, `TENANCY_DARK_LAUNCH`, `AI_WORKFORCE_ENABLED`); most flags OFF, only `CAPABILITY_REGISTRY_ENABLED=true`. Still no Redis-backed per-tenant runtime toggles; `withSmsSuppressed` + AI budget cap remain the live kill mechanisms |

The AI subsystem, health checks, and the dark-launch tenant-telemetry gate are the
places with real observability; the broader app is still largely unmonitored (raw
console, no external APM), so the recommendations below stand.

## 2. Recommended operational-readiness model (RECOMMENDATION)

Prioritized so a small team gets 80% of the value from the first three items.

### Tier 1 — do first (cheap, high value)
1. **Error monitoring:** add **Sentry** (Next.js SDK) — **still the single biggest
   gap** (no external APM exists); captures server + client errors, releases, and
   traces with minimal code. _(Updated 2026-07-14: unchanged — remains open.)_
2. **Structured logging:** _(Updated 2026-07-14: the wrapper now EXISTS —
   `app/lib/platform/observability/logger.ts` + `redact.ts` — but is **dormant (0
   importers)**. Remaining work is adoption, not authoring: migrate hot-path
   `console.*` calls to it and thread `tenantId`/`userId`/`route` context.)_ Keep
   the "never log secrets" discipline (already enforced by `redact.ts`).
3. **Health check:** _(Updated 2026-07-14: DONE — `app/api/health/route.ts` pings
   KV, reports blob/ai/stripe/email config, returns **503** on critical KV failure,
   and raises a deduped `health_critical` alert. Remaining: wire an external uptime
   monitor — Better Uptime / Vercel — to poll it.)_

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

_(Updated 2026-07-14: a typed **env-driven** flag module now exists —
`app/lib/platform/flags.ts` — and already gates the tenancy dark-launch work
(`TENANCY_ENABLED`, `TENANCY_DARK_LAUNCH`, `TENANCY_DUAL_WRITE`) and AI-workforce
rollout. What remains from this recommendation is the **Redis-backed, per-tenant
runtime** scope + kill-switch kinds below; the current flags are deploy-time env
toggles, not live per-tenant switches.)_

Extend the env flags with a small typed **runtime** flag module (Redis-backed,
tenant + global scope), reusing the layered-config pattern from `06-...`:

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
