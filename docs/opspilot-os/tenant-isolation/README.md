# OpsPilot Tenant Isolation — Sprint Record

> Branch `opspilot/tenant-isolation` (from `c1c7591`), 2026-07-12.
> **Not committed, not deployed, not merged, no production data touched.**
> Gates: `tsc --noEmit` clean · **332/332 tests** · eslint clean.

Moves OpsPilot from tenant-aware *scaffolding* to an **enforceable** tenant data
boundary — while `TENANCY_ENABLED=false` keeps J KISS byte-identical to today.

## Index
| Doc | Subject |
|---|---|
| [00-baseline-verification.md](00-baseline-verification.md) | Baseline commit + Redis architecture re-inspection |
| [01-redis-key-inventory.md](01-redis-key-inventory.md) | Every key family classified |
| [02-key-api.md](02-key-api.md) | The tenant-aware key API |
| [03-access-chokepoint.md](03-access-chokepoint.md) | `redis.ts` enforcement |
| [04-bypass-remediation.md](04-bypass-remediation.md) | The 2 inline-fetch bypasses removed |
| [05-jkiss-migration-plan.md](05-jkiss-migration-plan.md) | Reversible copy migration |
| [06-dark-launch-strategy.md](06-dark-launch-strategy.md) | Shadow-read comparison |
| [07-name-derived-key-migration.md](07-name-derived-key-migration.md) | biz/promo/ship → stable ids |
| [08-background-and-storage-isolation.md](08-background-and-storage-isolation.md) | Cron/webhook/blob boundaries |
| [09-security-tests.md](09-security-tests.md) | Isolation test suite + CI gate |
| [10-observability.md](10-observability.md) | Redacted tenancy telemetry |
| [11-rollout-plan.md](11-rollout-plan.md) | Staged rollout (Stage 0–10) |
| [12-rollback-plan.md](12-rollback-plan.md) | Rollback at every stage |
| [13-results.md](13-results.md) | Gate results |
| [14-remaining-risks.md](14-remaining-risks.md) | Open risks |
| [15-next-sprint-recommendation.md](15-next-sprint-recommendation.md) | What's next |
| [diagrams/](diagrams/) | 6 Mermaid views |

## One-paragraph summary
Tenant keys are built in exactly one place (`app/lib/platform/tenancy/keys.ts`),
enforced at exactly one chokepoint (`app/lib/redis.ts`), validated by a static CI
gate, exercised by 36 new tests, and backed by a reversible, production-refusing
migration utility. Everything is flag-gated off; nothing user-facing changes.
