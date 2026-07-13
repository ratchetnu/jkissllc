# 11 — Observability

**Files:** `app/lib/platform/observability/{redact,logger}.ts` ·
**Tests:** `scripts/observability.test.ts`.

## Structured logger (`logger.ts`)
A provider-agnostic `Logger` emitting JSON with the standard correlation fields —
tenantId, actorId, workerId, eventId, approvalId, correlationId, route — via an
**injectable sink** (default: console; swap to Sentry/a log platform later with no
call-site change). `child(base)` merges context for scoped logging.

## Redaction (`redact.ts`)
Runs on **every** log call. Masks values under sensitive **keys**
(secret/token/password/authorization/api-key/ssn/tin/cookie/session/…) and values
that **look like** credentials/PII regardless of key (Bearer tokens, long hex,
email, phone, SSN). Recursive over nested objects/arrays; circular-safe.

## Guarantee (tested)
A secret passed to the logger **never appears** in the sink record — proven by
asserting the raw value is absent from the serialized output.

## Not done
Wiring the logger through existing call sites, and adding error monitoring
(Sentry) / health checks / uptime — deferred (`../12-observability-and-operations.md`
Tier 1).
