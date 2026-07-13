# OpsPilot Platform Foundation — Sprint Record

> Branch `opspilot/platform-foundation`, 2026-07-12. **Not committed, not
> deployed, not merged.** Every gate green: `tsc --noEmit` clean · **296/296
> tests** · eslint clean. No production schema/data change; `redis.ts` untouched.

This sprint laid the typed foundation for the multi-tenant AI Business OS, in
three reviewable tranches, all additive under `app/lib/platform/` (+
`app/components/ui/`) and flag-gated off. It implements the blueprint under
`docs/opspilot-os/` (00–21) — it does not replace it.

## Index

| Doc | Subject |
|---|---|
| [00-executive-summary.md](00-executive-summary.md) | What shipped, in one page |
| [01-verified-current-state.md](01-verified-current-state.md) | Assessment re-verification (→ `../19-assessment-verification.md`) |
| [02-capability-registry.md](02-capability-registry.md) | Platform capability registry |
| [03-ai-workforce.md](03-ai-workforce.md) | AI worker registry + governance |
| [04-tenancy-foundation.md](04-tenancy-foundation.md) | Tenant/membership/principal/context |
| [05-industry-pack-contract.md](05-industry-pack-contract.md) | Industry packs + layered config |
| [06-business-events.md](06-business-events.md) | Event catalog + envelope + outbox |
| [07-approval-domain.md](07-approval-domain.md) | Approval request + state machine |
| [08-operational-intelligence.md](08-operational-intelligence.md) | Insight contract + 3 generators |
| [09-role-adaptive-workspaces.md](09-role-adaptive-workspaces.md) | Workspace registry + route map |
| [10-design-system-foundation.md](10-design-system-foundation.md) | UI primitives (→ `../21-design-system-foundation.md`) |
| [11-observability.md](11-observability.md) | Structured logging + redaction |
| [12-security-hardening.md](12-security-hardening.md) | Fail-closed + attribution (→ `../20-security-hardening-sprint.md`) |
| [13-test-results.md](13-test-results.md) | Gate results + coverage added |
| [14-deferred-work.md](14-deferred-work.md) | What this sprint deliberately did NOT do |
| [15-next-sprint-recommendation.md](15-next-sprint-recommendation.md) | The recommended next sprint |
| [diagrams/](diagrams/) | Mermaid sources (8 views) |

## The three tranches

- **A — tenancy + security + flags:** feature flags, `Tenant`/`Membership`/
  `TenantPrincipal`, per-handler `AsyncLocalStorage` context, `requireTenantSession`,
  and the commercialization-blocking security fixes (fail-closed webhooks/cron,
  CSPRNG ack token, attributed audit, authorization-coverage gate).
- **B — registries + governance:** capability registry (37), AI worker registry
  (9) + governance engine, industry-pack contracts (JKISS + disabled example) +
  layered config, business-event catalog (37) + validated envelope + outbox,
  approval domain + state machine.
- **C — intelligence + IA + design + observability:** insight contract + 3
  read-only generators, role-adaptive workspace registry + route-compatibility
  map, design-system primitives (18) + one flagged reference screen, structured
  logging with redaction.

## Guarantees honored

Backward-compatible (every change additive or flag-gated-off; `t:jkiss` behaves
as today) · no rewrite · no microservices · no Postgres · no Redis prefix change ·
no autonomous AI (governance + approval + audit + kill-switch precede any action) ·
no fake/nonfunctional UI (the one reference screen is real and 404s unless flagged) ·
secrets never printed.
