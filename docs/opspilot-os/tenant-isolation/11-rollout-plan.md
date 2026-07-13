# 11 — Rollout Plan

Staged, reversible. Flags: `TENANCY_ENABLED`, `TENANCY_DARK_LAUNCH`,
`TENANCY_DUAL_WRITE` (all off). Nothing below is executed in this sprint.

| Stage | What | Flags | Validation | Success | Rollback | Stop if |
|---|---|---|---|---|---|---|
| **0** | Code merged, tenancy off | all off | full suite green; app unchanged | prod identical | revert branch | any test red |
| **1** | Preview migration **dry-run** | off | `migrate dry-run` | 0 conflicts; expected counts | none (no writes) | unexpected conflicts |
| **2** | Preview **copy + verify** | off | `migrate` then `verify` (preview KV) | verify ok == tenant-owned count | delete targets (manifest) | verify mismatches |
| **3** | Preview **dark launch** | `DARK_LAUNCH` on | mismatch summary ~0 | only serialization diffs | flag off | value-mismatches |
| **4** | Prod **inventory only** | off | `inventory` | classification matches preview | none | drift vs preview |
| **5** | Prod **copy, no cutover** | off (+ `DUAL_WRITE` for set/del) | `migrate` + `verify` | verify ok | delete targets | verify mismatches |
| **6** | Prod **dark launch** | `DARK_LAUNCH` on | mismatch summary | ~0 real mismatches | flag off | value-mismatches |
| **7** | **Tenant reads on** (J KISS) | `TENANCY_ENABLED` on | app health + isolation tests | reads scoped, app healthy | flag off (reads revert to legacy) | any read error/empty |
| **8** | **Tenant writes on** | `TENANCY_ENABLED` on, `DUAL_WRITE` on | writes land in both | consistent | flag off + rely on legacy | write divergence |
| **9** | **Legacy fallback removed** | after stability | monitor | no legacy reads | re-enable fallback | any legacy dependency |
| **10** | **Legacy key deletion** | separate approved change | manifest review | space reclaimed | restore from backup | any doubt |

**Prerequisite for Stage 7:** per-handler `withTenantContextFromRequest` applied +
public-token tenant resolution (deferred work, doc 14). Do not enable
`TENANCY_ENABLED` before context is wired, or tenant-owned reads fail closed.
