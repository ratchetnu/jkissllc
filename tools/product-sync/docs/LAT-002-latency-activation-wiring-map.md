# LAT-002 — AI Latency Phase 2 Activation Wiring Map (PLANNED — do not implement without Preview validation)

**Status:** PLANNED. Map only — no critical-path code changed in Sprint 4.
**Verified against:** Supercharged main `ef618c6`. **Depends on:** LAT-001, OBS-001.

## Current reality (all three features are INERT)
| Flag | Backend present | Wired call-sites | State |
|---|---|---|---|
| `OPERION_CRITIC_JSON` | `app/lib/ai/junk-critic.ts` | **0** | declared only |
| `OPERION_EVENT_ENQUEUE` | `book-now-ai.ts` / `book-now-queue.ts` | **0** | declared only |
| `OPERION_DUE_INDEX` (+ `_DARK_LAUNCH`) | `app/lib/ai-due-index.ts` (9 exported fns) | **0 external callers of the whole module** | helper-only, inert |

> Do not trust older audits — this reflects a fresh grep of `app/` on `ef618c6`.

---

## OPERION_CRITIC_JSON
- **Current implementation:** `junk-critic.ts` provides the structured/JSON critic; the analysis path does not consult the flag.
- **Missing call site:** `app/lib/ai/junk-analysis.ts` (post-analysis critic step).
- **OFF behavior (must preserve exactly):** current critic path unchanged.
- **ON behavior:** structured/text-only critic review for **confident** jobs; a second image review **only** for configured borderline-confidence conditions; deterministic pricing + manual-review thresholds unchanged.
- **Rollback:** flag OFF → prior path (instant, inert).
- **Safeguards:** no duplicate provider call on confident jobs; borderline can still request the extra review; quote decisions within established tolerance; success + failure traces stay complete.
- **Risk:** MEDIUM (touches analysis/critic; extra provider call if mis-gated).

## OPERION_EVENT_ENQUEUE
- **Current implementation:** durable work is picked up by the cron/scan recovery path; nothing enqueues immediately.
- **Missing call site:** the qualifying request handler (post-`/api/quote/analyze` / booking creation) → immediate enqueue via `next/server` `after()` (the existing background mechanism).
- **OFF behavior (must preserve exactly):** current enqueue/recovery unchanged.
- **ON behavior:** enqueue durable work immediately after the qualifying request; **cron/manual recovery retained as the safety net**; idempotent; no duplicate jobs; terminal-state + bounded-retry protections preserved.
- **Rollback:** flag OFF → cron/scan only (instant, inert).
- **Safeguards:** immediate enqueue; no double execution (idempotency key); failed immediate enqueue falls back safely to recovery; request response not unnecessarily blocked.
- **Risk:** HIGH (durable worker + idempotency; double-execution is the failure mode to prevent).

## OPERION_DUE_INDEX (+ _DARK_LAUNCH)
- **Current implementation:** `ai-due-index.ts` maintains a ZSET due-index + parity helpers (`maintainDueIndex`, `rebuildDueIndex`, `dueTokensFromIndex`, `compareDue`, `dueIndexReadEnabled`…) — **none called**. Live selection uses the broad scan.
- **Missing call sites:** (a) `maintainDueIndex()` on booking/job state change; (b) dark-launch parity (`compareDue(scan, index)`) in the worker recording discrepancies; (c) `dueTokensFromIndex()` as the read source **only** once parity proven.
- **OFF behavior (must preserve exactly):** broad existing scan selection.
- **Dark-launch/parity mode:** maintain the index + compare against the scan + record discrepancies; **scan remains source of truth**.
- **Index-backed selection allowed only if:** parity passes, backfill completes, stale entries revalidated, rollback immediate, tests prove matching behavior. **Do NOT promote the live read source merely to close the sprint.**
- **Risk:** HIGH (job selection correctness; a wrong index drops or double-runs jobs).

---

## Required verification before any of this merges
TypeScript · ESLint · dedicated latency tests · AI suite · AI regression · Book Now tests · queue/recovery tests · idempotency tests · retry tests · terminal-state tests · **feature-OFF parity tests** · production build · isolated Preview deployment.

## Preview comparisons (only when Phase-1 gateway is functional)
Per flag, staged (never all at once): total latency, provider calls, token usage, AI cost, queue delay, retry count, quote result, confidence, manual-review result. Stop on any accuracy regression, duplicate processing, or unexpected pricing change.

## Recommended sequencing
1. `OPERION_CRITIC_JSON` (lowest blast radius) → 2. `OPERION_EVENT_ENQUEUE` (idempotency-critical) → 3. `OPERION_DUE_INDEX` **dark-launch parity only** (never live-promote without separate approval). Each is its own branch + PR + flag (OFF), Preview-validated.
