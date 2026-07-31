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

### RESOLVED — both ports are merged and live in Supercharged

Approved and delivered as two independently reviewed PRs in `ratchetnu/supercharged`.

| | PR | Merge | Production |
|---|---|---|---|
| Cron cadence | [#27](https://github.com/ratchetnu/supercharged/pull/27) | `9c60ea26` | `dpl_G7f9dHt8B12x89DtLRnpGSorj3Mq` |
| Due-index parity | [#28](https://github.com/ratchetnu/supercharged/pull/28) | `261e7ef7` | `dpl_aWbKzx3G42DKMg9RV2484VgqX8Gk` |

Cron: **913 → 197 runs/day**. Live build id verified against the Vercel API and
against the id embedded in the served HTML; homepage 200.

**Adapted, not cherry-picked.** Four differences were found and honoured:

1. **The index was DEAD CODE there.** `ai-due-index.ts` existed but
   `maintainDueIndex` had no callers — `saveBooking` never invoked it. It is now
   wired into BOTH write paths (`saveBooking` and `updateBooking`'s CAS path);
   wiring only the first would leave the index stale on every optimistic update. A
   mutation test covers it, and caught the omission when it was first missed.
2. **No Redis tenant scoping.** `scopeKey()` has no callers there; `lib/redis.ts`
   never imports it and the cron does not iterate tenants. Supercharged is
   single-tenant, so the port makes **no** tenant-isolation claims and writes **no**
   isolation tests — assertions against an unscoped store would pass vacuously and
   imply a guarantee that does not exist. A test asserts the absence so a future
   sync cannot quietly introduce a false claim.
3. **`isFinalDue` differs.** It treats only `queued`/`retrying` as due — no
   stale-`processing` recovery — and its `CustomerConfirmation` has no
   `invalidatedAt`. Reusing the initial lane's `dueScore` would have scored stuck
   `processing` jobs as due forever.
4. **No event-driven recovery trigger.** J KISS fires `processAiJob` from
   `/api/quote/route.ts`; Supercharged has no such hook, so its cron is the only
   automatic recovery trigger and worst-case recovery for an already-failed analysis
   moved from ≤3 min to ≤15 min. The primary customer path (`/api/quote/analyze` →
   `buildPhotoEstimate`) is unaffected. A test asserts the hook's absence.

Two Supercharged tripwires fired and were resolved deliberately, not suppressed:
the session-wrapped route census (3 → 4, which its own comment says IS the gate
passing) and the generated receipts artifact.

Flags remain OFF in both repositories. No Production backfill was run and no
Production configuration was changed in either project.

### Supercharged operational baseline — 2026-07-31T22:27:31Z

| Field | Value |
|---|---|
| Production build | `dpl_aWbKzx3G42DKMg9RV2484VgqX8Gk` (`261e7ef7`) |
| Homepage | HTTP 200 |
| `/api/health` | **404 — Supercharged has no health endpoint** |
| Cron runs/day | **197** (was 913) |
| Upstash request count | **not recorded — the Marketplace API exposes spend, not usage** |

The request count is deliberately absent rather than estimated. Supercharged uses a
store separate from J KISS, and no authoritative reading is available from here; a
figure invented to fill the row would be indistinguishable from a measurement.

**Follow-up (engineering, not observation):** Supercharged has no `/api/health`, so
it has no liveness signal equivalent to the one that surfaced the J KISS outage
within minutes. That is a real monitoring gap and its own increment.

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
