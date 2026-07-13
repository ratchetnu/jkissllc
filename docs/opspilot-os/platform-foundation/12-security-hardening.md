# 12 — Security Hardening

Full detail: [`../20-security-hardening-sprint.md`](../20-security-hardening-sprint.md).

Closed the approved commercialization-blocking drift:
- **Fail-closed webhooks** — Twilio + email now 503 when no verifying secret is
  configured (were: warn + process).
- **Fail-closed cron** — daily + reminders now 401 when `CRON_SECRET` is unset.
- **CSPRNG reminder ack token** — `reminders.ts` `tok()` now 256-bit crypto hex
  (was `Math.random`); exposed as `newAckToken()`.
- **Attributed audit (H3 groundwork)** — `AuditEntry.actorId/actorRole` +
  `pushAuditFor(who, …)`; existing coarse callers unchanged (full rollout deferred).
- **Anti-spoofing** — `proxy.ts` strips inbound `x-tenant-id`.
- **No frontend-only authorization** — `scripts/authorization-coverage.test.ts`
  asserts every admin route has a server-side guard (a CI gate).
- **No fail-open tenant boundary** — `tenant-store.ts` throws / returns null on a
  missing tenant when tenancy is on.

No secrets rotated or printed. Per-endpoint table in the linked doc.
