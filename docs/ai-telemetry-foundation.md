# AI Telemetry & Cost-Accounting Foundation — Session 1

Branch: `feat/ai-telemetry-foundation` · Worktree: `/Users/nunubabymuzik/jkissllc-ai-telemetry`

## Audit findings (Phase 1)

Every LLM/vision call in the platform flows through the single governed chokepoint
`runAiTask` (`app/lib/ai/service.ts`) → `generateAI` (`app/lib/ai.ts`, the only
`generateText` site) → `recordAiCall` (`app/lib/ai/telemetry.ts`, the `ai:log` audit
store). There are **no telemetry-blind model calls**: `aiText()` is legacy/unused, and
the "final/second analysis" (`confirmed-analysis.ts`) is deterministic — it makes no
model call, so it correctly produces no AI record.

Eight `runAiTask` call sites:

| feature | site | kind (new) |
|---|---|---|
| `ops.command` | api/admin/ai/command | primary |
| `ops.insights` | api/admin/ai/insights | primary |
| `ops.message` | api/admin/ai/message | primary |
| `ops.reviewReply` | api/admin/ai/review-reply | primary |
| `ops.photoEstimate` | api/ai/photo-estimate | primary |
| `ops.junkAnalysis` | lib/ai/junk-analysis (V1 Book Now) | **primary** |
| `ops.junkAnalysis` | lib/ai/analysis-v2 (V2 shadow, ×1–2/analysis) | **shadow** |
| `ops.junkAnalysisReview` | lib/ai/junk-critic (2nd-opinion) | primary |

### Gaps this session closes
- **No primary/shadow/fallback discriminator.** V2 shadow records under the SAME
  `ops.junkAnalysis` feature as V1 primary → shadow spend is indistinguishable from
  authoritative spend. Fixed with a first-class `kind` field.
- **No booking/job join.** `AiCallRecord` had no `bookingId`/`jobId`; `callId`↔`aiJob.providerTraceId`
  was a one-way, non-indexed link. Added `bookingId`/`jobId`.
- **No image-count / queue-timing / confidence / manual-review-reason.** Added, all optional.
- **`provider` only derived ad-hoc** (and `void`-discarded in analysis-v2). Now a recorded dimension.
- **Cost table scattered & Claude-only.** `MODEL_RATES` silently applied Sonnet rates to any
  non-Claude model. Centralized into a **versioned, env-configurable** cost table that records
  which table version priced a call and flags rate fallbacks.
- No redaction guarantee at the sink, no idempotency guard. Added both.

### Known issues left for their owners (NOT changed here)
- **Double cost-accounting of V2 shadow**: `runAiTask` accrues shadow inferences to
  `ai:cost:{tid}:{day}` AND `shadow-worker` charges `shadow:spend:{day}`. The new `kind`
  field lets a consumer net shadow out of primary cost; budget accrual behavior is left
  unchanged (owned by the governance/shadow layer — Session 2).
- V2 repair-retry cost undercount in `analyzePhotosV2`'s returned `estCostUsd` — analyzer-owned.

## Ownership map (files this session modifies)

Modified (AI-telemetry core, additive/backward-compatible only):
- `app/lib/ai/telemetry.ts` — extend `AiCallRecord`, redaction, idempotency, derivation, `updateAiCall`
- `app/lib/ai/service.ts` — thread optional context through the chokepoint (no behavior change)
- `app/lib/ai/junk-analysis.ts` — pass `kind:'primary'`, `bookingId`, `imageCount`; post-hoc confidence
- `app/lib/ai/analysis-v2.ts` — pass `kind:'shadow'`, `bookingId`, `imageCount` (2 call sites)
- `app/lib/ai/junk-critic.ts` — pass `kind` + `bookingId`

New:
- `app/lib/ai/cost-tables.ts` — versioned configurable cost tables
- `app/lib/ai/telemetry-read.ts` — read API/service for the later dashboard session
- `scripts/ai-telemetry.test.ts` — telemetry-specific tests

Preserved consumers (NOT modified): `app/lib/ai/analytics.ts`, `app/lib/ai/registry.ts`,
`app/lib/ai/estimator-diagnostics.ts`, all `app/api/admin/ai/*` routes.

### Files another session must avoid touching in mine
`app/lib/ai/telemetry.ts`, `app/lib/ai/cost-tables.ts`, `app/lib/ai/telemetry-read.ts`.

### Files this session avoids (Session 2 — feat/ai-job-recovery)
`app/lib/book-now-ai.ts`, `app/lib/estimation/shadow-worker.ts`,
`app/lib/ai/estimator-diagnostics.ts`, `app/api/cron/ai-jobs`, `app/api/cron/vision-shadow`.
</content>
