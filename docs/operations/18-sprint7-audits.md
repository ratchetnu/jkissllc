# Sprint 7 — configuration and parity audits

Read-only. Captured 2026-07-31. No configuration was changed in either project.

## 1. Preview / Production flag drift

Built from the flag registry (`ALL_FLAGS`), not by parsing CLI table columns — a
first pass that parsed columns reported `BOOKING_ASSIGNMENT_ENABLED` as
Production-only, which was **wrong**; it is set in both. The registry-driven check
is the authoritative one.

`set` means the variable exists. **Values are encrypted and unreadable from here**,
so this audit reports presence, never state. A variable that is set to `false` is
indistinguishable from one set to `true`.

- 40 flags in the registry · 13 set in Production · 11 set in Preview

| Flag | Production | Preview | Registry default |
|---|---|---|---|
| `TENANCY_ENABLED` | — | set | false |
| `TENANCY_DARK_LAUNCH` | — | set | false |
| `AI_PIPELINE_OBSERVABILITY_ENABLED` | — | set | false |
| `OPERION_SANDBOX_REPAIR_ENABLED` | — | set | false |
| `INTAKE_WORKFLOW_ENABLED` | set | — | false |
| `VISION_SHADOW_QUEUE_ENABLED` | set | — | false |
| `VISION_SHADOW_WORKER_ENABLED` | set | — | false |
| `OPERION_AI_ADAPTATION_ENABLED` | set | — | false |
| `OPERION_AUTOMATIC_ROLLBACK_ENABLED` | set | — | false |
| `SHADOW_ANALYTICS_ENABLED` | set | — | false |

**Reading:** Preview carries the tenancy flags that Production does not, which is
the expected direction — tenancy is validated in Preview first. The
Production-only entries are mostly shadow/AI infrastructure whose *values* are
unknown; several were reported as "all flags OFF" historically, but that claim
cannot be verified from here and should not be repeated as fact.

**No action taken.** Aligning environments means writing Production configuration,
which needs its own approval and its own evidence.

## 2. Supercharged parity — `~/supercharged`

Read-only inspection per the cross-repository rules.

| | |
|---|---|
| Remote | `github.com/ratchetnu/supercharged.git` |
| Branch / head | `main` / `e58ec78` |
| Local dirty state | one untracked directory (`.claude/`) — nothing of the owner's tracked work |
| Test / lint / build | `tsx --test scripts/*.test.ts` · `eslint` · `next build` |
| CI workflows | `ai-regression.yml`, `operion-update.yml` |

### FINDING — Supercharged carries the same latent outage

The defect that exhausted J KISS's Upstash quota on 2026-07-31 is **present and
unfixed** in Supercharged:

- `app/lib/book-now-ai.ts:327` and `:345` — `listBookings(500)`
- `app/lib/book-now-confirmation.ts:288` — `listBookings(500)`
- `app/lib/ai-due-index.ts` exists, but **neither runner references
  `dueIndexReadEnabled` or `selectDueFromIndex`** — it is the pre-#144 shape, so
  every tick scans unconditionally.
- `vercel.json` schedules `/api/cron/ai-jobs` at `*/3` (480 runs/day),
  `reminders` at `*/5`, `vision-shadow` at `*/10`.

That is the exact profile — ~2N+2 Redis requests per tick, 480 ticks/day — that
took J KISS down. Supercharged is a separate Vercel project with its own Upstash
store and its own allowance, so its time-to-exhaustion depends on its booking count
and quota, neither of which is observable from here.

### Not changed, and why

Two ports are available: the cron cadence (PR #145) and the indexed due-work path
(PR #144). Both are code, but both change live behaviour for a **different business**
on deploy, and there is no Supercharged telemetry to size the cadences against — the
J KISS numbers came from measured `estimatedRedisRequests`, which does not exist
there yet.

Presented for approval rather than applied. See the report accompanying this sprint
for the exact proposed diff.

## 3. Sprint 7 scope completed in-session

- Operational gap log, baseline/follow-up capture, observation windows, readiness
  verdict — `app/lib/platform/ops-readiness.ts`
- Authorized, tenant-scoped API — `app/api/admin/operations/readiness/route.ts`
- Monitoring + rollback runbook — `docs/operations/17-operational-readiness.md`
- This audit

## 4. Explicitly NOT completed — operational follow-ups

- [ ] **T+24h usage reading** — earliest 2026-08-01T18:03Z
- [ ] **T+7d usage reading** — earliest 2026-08-07T18:03Z

These are elapsed-time observations. The readiness surface derives completion from
timestamps plus a follow-up reading and has no flag to set, so neither can be
reported as done before it is.
