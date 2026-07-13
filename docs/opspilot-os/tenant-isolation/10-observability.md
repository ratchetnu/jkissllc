# 10 — Observability

**File:** `app/lib/platform/observability/tenant-telemetry.ts` (on the
platform-foundation redacting logger).

Structured, **redacted** signals for the migration. Emits ONLY safe metadata —
event type, key **family** (first segment), tenant id, correlation id, mismatch
type. **Never** Redis values, tokens, PII, or message content (the logger redacts;
we never pass sensitive values in).

## Events (`recordTenantEvent`)
`key-gen-failure` · `missing-tenant-context` · `cross-tenant-denial` ·
`legacy-fallback` · `dark-launch-mismatch` · `migration-progress` ·
`migration-conflict` · `background-tenant-resolution` · `unauthorized-global-access`.

`cross-tenant-denial`, `key-gen-failure`, `unauthorized-global-access` log at
`error`; the rest at `warn`.

## Wired
- Dark-launch mismatches (`dark-launch.ts` → `dark-launch-mismatch`).
- Missing/failed background tenant resolution (`request-context.ts` →
  `missing-tenant-context`, `background-tenant-resolution`).
- Migration progress/conflicts (`migrate.ts` structured logs).

## Redaction proof
`scripts/observability.test.ts` (platform-foundation) proves a secret passed to
the logger never appears in the sink; tenancy telemetry reuses that logger.
