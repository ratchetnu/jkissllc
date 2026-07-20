# Operion AI — Image Optimization

Produce a model-optimized **derivative** of every uploaded photo before it reaches
the vision model, **preserving the original** for every booking, and **measure** the
token / byte / latency win — without reducing quote accuracy.

Status: **built, flag-gated OFF everywhere, Preview-first.** With the master flag off
the system is **byte-identical to today** (no derivative generated, model reads the
original).

## Why

iPhone photos arrive at 3–4k px / multi-MB. Claude vision is billed by image
resolution (≈ `width·height / 750` tokens) and every extra byte is upload + fetch
latency. Downscaling to a long-edge cap + a sane JPEG quality typically cuts tokens
and bytes by a large factor while leaving the pixels the model reasons over
unchanged — so accuracy is preserved.

## What runs

**Low-risk set — applied whenever optimization is on (no per-op flag):**

- EXIF **orientation** correction (automatic on decode)
- **HEIC → JPEG** (already handled upstream at upload by `image-convert.ts`)
- Intelligent **resize** to a long-edge cap (default **1280px**)
- **JPEG quality** optimization (default **82**)
- **Metadata strip** (automatic on re-encode — no EXIF written back)

**Higher-risk set — each independently flag-gated, default OFF** until the shadow
eval clears it (see *Validation*):

- `IMAGE_OPT_AUTOCROP_ENABLED` — trim uniform whitespace / borders
- `IMAGE_OPT_NORMALIZE_ENABLED` — adaptive brightness + contrast normalization
- `IMAGE_OPT_SHARPEN_ENABLED` — mild sharpen after downscale
- `IMAGE_OPT_DENOISE_ENABLED` — mild blur to suppress sensor noise

## Flags

| Flag | Default | Effect |
|---|---|---|
| `IMAGE_OPTIMIZATION_ENABLED` | OFF | **Master.** OFF = no derivative, model reads original. ON = low-risk set. |
| `IMAGE_OPT_AUTOCROP_ENABLED` | OFF | Whitespace/border crop (only when master ON). |
| `IMAGE_OPT_NORMALIZE_ENABLED` | OFF | Brightness + contrast normalization. |
| `IMAGE_OPT_SHARPEN_ENABLED` | OFF | Post-resize sharpen. |
| `IMAGE_OPT_DENOISE_ENABLED` | OFF | Noise reduction. |

## Architecture

Library: **jimp** (`^1.6.1`) — pure-JS/wasm, no native deps (matches the repo's
`heic-convert` choice; serverless-safe).

- **Core (pure):** `app/lib/image-optimize.ts` — `optimizeForModel(buffer, contentType, opts)`
  and `optimizeDataUrlForModel(dataUrl, opts)`. Never throws; any decode/encode
  failure or a "no gain" result returns the original untouched with a
  `skippedReason`. Reports `OptimizeMetrics` (bytes, dims, est tokens, reductions).
- **Config:** `app/lib/ai/image-optimize-config.ts` — maps flags → options; keeps
  env reads out of the pure core.
- **Storage (originals preserved):** `app/api/upload/route.ts` stores the original at
  `quote-photos/<id>.<ext>` (unchanged) and, when enabled, the derivative at the
  deterministic sibling `quote-photos/<id>.ai.jpg`. Returns additive `aiUrl` +
  `optimization` fields; `url` is unchanged (backward compatible). Fail-soft.
- **AI-send resolution:** `app/lib/ai/photo-optimize.ts` — `aiDerivativeUrl()` derives
  the `.ai.jpg` sibling from an original URL; `resolveAiPhotoUrls()` swaps originals
  for derivatives that exist (else keeps the original). This works with **zero
  booking-schema change** for both the instant path and the durable Book-Now worker.
  Wired in `junk-analysis.ts` (primary vision), `junk-critic.ts` (second opinion),
  and inline in `app/api/ai/photo-estimate/route.ts` (base64 data-URL path).

## Measurement

- **Upload time (always available):** byte reduction + pixel/estimated-token
  reduction per photo, logged as `[upload] ai-derivative {...}` and returned in the
  `optimization` field.
- **Token / latency / accuracy (A/B):** `app/lib/estimation/image-opt-eval.ts` —
  `compareOptimizationOutcome(original, derivative)` compares the SAME photos analyzed
  as original vs derivative and returns deltas for volume, truck-fill, confidence,
  detected-object overlap (Jaccard), latency, bytes, tokens, cost, plus a verdict:
  `safe_to_promote` | `no_regression_no_benefit` | `accuracy_regression`.
  `aggregateOptEval()` rolls a batch into a promotion recommendation.

## Validation (accuracy guardrail)

"Do not reduce quote accuracy" is enforced by the eval: a derivative that moves
volume, truck-fill, confidence, or the detected-object set beyond tolerance is a
**regression** and is never promoted, regardless of the token/byte saving.

**Rollout order:**

1. Enable `IMAGE_OPTIMIZATION_ENABLED` in **Preview**. Verify derivatives are stored
   and `[upload] ai-derivative` logs show real reductions.
2. Feed the shadow harness both variants; require the aggregate to show
   `regressionRate ≤ 2%` **and** a meaningful mean token saving before promoting the
   low-risk set to Production.
3. Only after the low-risk set is proven, enable ONE higher-risk op at a time in
   Preview, re-run the eval, and promote each only if it clears the same bar.

**Shadow-harness hook (not yet wired to the durable cron):** the comparator is a pure
function ready for `app/lib/estimation/shadow-worker.ts` to call with an
`OptEvalSample` projected from each analysis. Kept out of the durable worker for now
to avoid changing job timing; wire it behind the existing `VISION_SHADOW_*` flags.

## Tests

- `scripts/image-optimize.test.ts` — core transform + data-URL helper (real jimp).
- `scripts/photo-optimize.test.ts` — URL derivation + resolution.
- `scripts/image-opt-eval.test.ts` — A/B comparator + aggregate verdicts.
