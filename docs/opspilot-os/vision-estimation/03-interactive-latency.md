# Interactive photo-estimate latency

**Status:** merged to no environment. All new flags OFF. No Production configuration changed.
**Scope:** the customer-facing photo estimate (`POST /api/quote/analyze`) and the wizard step that drives it. The durable server-side worker is deliberately untouched.

---

## The problem

A customer uploads photos, presses Continue, watches a spinner, and lands on **"We'll review your photos"** with no estimate. The booking arrives in OpsPilot with `Analysis status: queued`, `attempts 0`, and sits there until a cron tick.

Three independent causes, all of them ours:

### 1. The route could not finish inside its own ceiling

| Component | Value | Where |
| --- | --- | --- |
| Route function ceiling | 60s | `maxDuration` in `app/api/quote/analyze/route.ts` |
| Per-call model timeout | 30s | `aiCallTimeoutMs()` — `AI_CALL_TIMEOUT_MS` unset in Production |
| Model attempts | 2 | `runAiTask` retries a transient failure |
| Second-opinion critic | a **full second vision pass** | `OPERION_CRITIC_JSON` unset ⇒ `criticModeFor` always returns `vision` |

A timeout classifies as transient, so two attempts alone could consume 2 × 30s — exactly the ceiling — before the critic asked for its own vision call on the same photos. When the budget blew, the **platform** killed the function. The browser saw a dead request, `runAnalysis` hit its `catch`, `estimate` stayed null, and the wizard fell through to `ConfirmUnavailable`. Nothing was recorded, so the failure was invisible in the funnel.

The bitter detail: the critic only runs when the first pass is **about to instant-quote**. The one path that could produce an instant quote was the only path that paid double latency.

### 2. Nothing started until the customer pressed Continue

`runAnalysis()` fired when leaving the Photos step and `await`ed inline. The customer had usually been on that step for a while already, doing nothing. Every second of model time was a second of spinner.

### 3. The fallback then waited up to 15 minutes

Submit enqueues a durable job with `nextRetryAt = now()`, but `OPERION_EVENT_ENQUEUE` is off in Production and `/api/cron/ai-jobs` runs `*/15`. Hence `queued`, `attempts 0`.

---

## What changed

### Interactive analysis policy — `app/lib/ai/interactive-policy.ts`

An explicit latency budget for customer-facing analysis. It reserves a response margin and spends what is left:

| Stage | Slice | Attempts |
| --- | --- | --- |
| Primary vision read | up to 32s, shrinking as earlier work consumes the budget | **1** |
| Critic | whatever survives, capped at 15s | 1 |
| Response margin | 6s reserved | — |

Worst case 53s against a 60s ceiling. Every number is env-overridable (`QUOTE_ANALYZE_PRIMARY_MAX_MS`, `QUOTE_ANALYZE_CRITIC_MAX_MS`, `QUOTE_ANALYZE_RESPONSE_MARGIN_MS`, `QUOTE_ANALYZE_CRITIC_MIN_MS`).

Three rules:

- **Single-shot.** A retry cannot fit inside the ceiling, so an interactive request never gets one. Retries are the durable worker's job.
- **The budget answers; the platform never kills.** A budget overrun returns a structured 200 carrying `analyzed.degraded`, records `ai_analysis_timeout`, and stamps `estimate.latency.degraded`. A 504 tells the customer nothing and tells us less.
- **A critic that cannot finish is skipped, not abandoned.** Below the 8s floor the critic is skipped and the skip is recorded as `estimate.latency.criticSkipped`. The pricing effect is identical to today's critic-**failure** path (verdict null ⇒ primary analysis stands); the difference is that it is now measurable.

The route asserts `maxDuration * 1000 === INTERACTIVE_ROUTE_CEILING_MS` at module load so the two declarations cannot drift.

**The durable worker passes no budget** and keeps its own policy unchanged: 300s function, 150s per-job deadline, 5 attempts, exponential backoff. Interactive is fast, single-shot and always answers; durable is patient, persistent and thorough. That asymmetry is the design.

### Speculative pre-analysis — `app/lib/ai/pre-analysis.ts`

The analysis now starts when the photo set **settles**, overlapping the model call with the customer's own dwell time. Pressing Continue usually finds the answer already in state.

Speculation is only safe if a result can never be attributed to the wrong inputs, so the mechanics live in a pure, injectable controller rather than a `useEffect`:

| Hazard | Handling |
| --- | --- |
| Unsettled uploads | Never analyze while any upload is in flight — a partial set would be priced |
| Rapid additions | 600ms debounce collapses a burst into one run |
| Stale results | Every run is keyed by a fingerprint of photos + service + debris, and discarded on arrival if that key is no longer current |
| Duplicate runs | One in-flight run per fingerprint |
| Duplicate completions | A runner that settles twice applies exactly once |

Superseded runs are **aborted at the fetch**, not left burning provider time. `ensure()` (Continue) reuses a finished result, joins an in-flight one, or starts fresh with no debounce.

**Cost trade-off, stated plainly:** a head start analyzes sets that may be abandoned. Speculative runs are counted separately (`quote_analyze_speculative`) against `quote_analyze_started`, so the ratio is a number, not a guess.

### Compact analysis spec — `ops.junkAnalysisCompact`

Output tokens dominate vision latency: the model must generate every character before we see any of it. The v1 spec asks for fields **nothing in this codebase reads** — a free-text `evidence` sentence per item, a per-item weight range, `bulky`, `likelyDisposalType`, four per-photo fields, two spare labor numbers and three spare confidence sub-scores.

Measured reduction in the emitted response:

| Items | Photos | v1 chars → compact | Reduction |
| --- | --- | --- | --- |
| 3 | 2 | 2,687 → 1,583 | 41.1% |
| 6 | 3 | 4,103 → 2,159 | 47.4% |
| 10 | 4 | 5,908 → 2,898 | 50.9% |
| 14 | 6 | 7,962 → 3,724 | 53.2% |

The **reasoning** rules are unchanged — counting a repeated pile once, the hazard-possibility framing, the face/personal-trait prohibition. This reduces what the model emits, not what it is told to think about. Every dropped field already had a normalizer default, so `JunkPhotoAnalysis` and all its consumers are untouched; `scripts/compact-analysis-prompt.test.ts` proves the same job under either spec yields an identical decision, price, monitor verdict, follow-up set, customer view and critic summary.

Selected by `taskId` while `feature` stays `ops.junkAnalysis`, so routing, cost dashboards and the audit log still see one feature while telemetry records which spec ran.

**`maxOutputTokens` is deliberately still 1600.** Consumer equivalence is proven; whether the model *reads photos* as well under the smaller spec is a live-model question for LAT-002.

---

## What was NOT changed

- No Production environment variable.
- Cron cadence stays `*/15`. Event enqueue is the right fix for queue latency; a faster cron is what you do if that turns out to be insufficient, not before.
- No Production model change.
- `maxDuration` stays 60s. Raising the customer's ceiling to 180s would make the wait *longer*, not the answer better.

---

## Measuring it

```bash
# Offline: exact payload reduction + policy simulation (no credentials, no cost)
npx tsx scripts/interactive-latency-bench.ts

# Your own latency distribution instead of the illustrative one
BENCH_PROVIDER_MS="12000,18000,24000,…" npx tsx scripts/interactive-latency-bench.ts

# Live: real p50/p95 and decision distribution against Preview (makes real calls)
BENCH_TARGET=https://<preview>.vercel.app \
BENCH_PHOTOS=https://<blob>/a.jpg,https://<blob>/b.jpg \
VERCEL_AUTOMATION_BYPASS_SECRET=… BENCH_RUNS=20 \
npx tsx scripts/interactive-latency-bench.ts

# Promotion verdict for any flag, from Preview A/B pairs
npx tsx scripts/lat002-compare.ts pairs.json --arm=critic_json
npx tsx scripts/lat002-compare.ts pairs.json --arm=compact_prompt
npx tsx scripts/lat002-compare.ts pairs.json --arm=model
```

Funnel counters to read after a Preview session:

| Counter | Question it answers |
| --- | --- |
| `quote_analyze_started` | total analyses |
| `quote_analyze_speculative` | what share were head starts (the cost of pre-analysis) |
| `ai_analysis_timeout` | how often our own budget fired |
| `instant_quote_displayed` / `estimate_range_displayed` / `manual_review_required` | decision distribution |

Queued rate is measured on the **submit** path, not the analyze path: a booking that arrives with no attached estimate is the one that lands in the durable queue.

---

## Staged rollout

Each stage is independently reversible and none is implied by the previous one.

| Stage | Change | Gate to clear first |
| --- | --- | --- |
| 1 | Merge this branch (all flags OFF) | Green CI. The interactive policy and pre-analysis are active on merge — they are code, not flags. Watch `ai_analysis_timeout` and the speculative ratio in Preview. |
| 2 | `OPERION_CRITIC_JSON` in **Preview** | LAT-002 `--arm=critic_json` over ≥20 pairs returns `safe_to_promote`. Review-rate delta is the number that matters: a JSON critic that reviews *less* is blinder, not cheaper. |
| 3 | `OPERION_EVENT_ENQUEUE` in **Preview** | Enqueue→start latency drops from minutes to seconds; no duplicate processing; a killed post-response run is still recovered by cron. |
| 4 | `AI_COMPACT_ANALYSIS_PROMPT` in **Preview** | LAT-002 `--arm=compact_prompt`. Only after this passes may `maxOutputTokens` be lowered. |
| 5 | Promote stages 2–4 to Production individually | Each one separately, each watching the same guardrails on live traffic. Never two at once — a regression you cannot attribute is a regression you cannot fix. |
| 6 | Faster first-pass model | LAT-002 `--arm=model`. `quoteMismatchRate` decides it: a cheaper model that quotes differently is a pricing change wearing a latency costume. |
| 7 | Cron cadence | Only if stage 3 measurements show event enqueue is insufficient on its own. |
