# IMG-002 — Image Evaluation Data Lifecycle (BLOCKED BY MISSING DATA SOURCE)

**Status:** BLOCKED BY MISSING EVALUATION DATA SOURCE (not failed). No code written in Sprint 4.
**Downstream:** ratchetnu/supercharged · **Depends on:** IMG-001 (image optimization backend).

## 1. Existing evaluation functions
Both live in **`app/lib/estimation/image-opt-eval.ts`** and are **pure** (no I/O):

- **`compareOptimizationOutcome(original, derivative, thresholds?) → OptEvalResult`** — compares an original-image analysis against its optimized-derivative analysis and returns accuracy proxies (item-count / volume / truck-fill / confidence deltas, label Jaccard), efficiency wins (byte / token / cost / latency reductions), and a `verdict` (`safe_to_promote` | `no_regression_no_benefit` | `accuracy_regression`).
- **`aggregateOptEval(results, opts?) → OptEvalAggregate`** — rolls a batch of `OptEvalResult`s into a promotion recommendation (regression rate, mean reductions, `recommendPromotion`).

Supporting types: `OptEvalSample`, `OptEvalResult`, `OptEvalAggregate`, `OptEvalThresholds`, `DEFAULT_OPT_EVAL_THRESHOLDS`.

## 2. Current behavior
Pure comparators. Given two samples they compute a verdict. They perform **no** persistence, no network, no scheduling.

## 3. Why they are never invoked or persisted
Grep of `app/lib` + `app/api` on SC main `ef618c6`: **zero callers** of either function. IMG-001 shipped the optimization backend + the eval *logic* but never the **A/B invocation** (analyze BOTH original and derivative) or the **recording** of the result. `IMAGE_OPTIMIZATION_ENABLED` has been OFF, so even the single-derivative path has not run in production. There is therefore **no eval record anywhere** — no store, no read path. A read-only UI would be permanently empty.

## 4. The exact future event that should trigger evaluation recording
Inside the analysis path (`app/lib/ai/junk-analysis.ts` / the durable worker), **only when `IMAGE_OPTIMIZATION_ENABLED` is ON _and_ a derivative was actually produced** (`optimizeForModel(...).applied === true`):

1. Run the model on the **original** → `OptEvalSample` A (already the normal path when opt is OFF).
2. Run the model on the **derivative** → `OptEvalSample` B (this is the added A/B cost, itself gated behind an `IMAGE_OPT_AB_SHADOW_ENABLED` flag so it never doubles provider cost by default).
3. `compareOptimizationOutcome(A, B)` → `OptEvalResult`.
4. Persist one `OptEvalRecord` (below). Fire-and-forget; never blocks the customer response; never changes the quote (the original result is authoritative unless a separate promotion decides otherwise).

**This event is deliberately NOT implemented this sprint** (owner: defer; no persistence / no image-flow change).

## 5. Minimum evaluation record schema (`OptEvalRecord`)
```ts
type OptEvalRecord = {
  id: string                    // stable eval id
  tenantId: string             // REQUIRED — tenant isolation
  bookingId?: string           // link to the booking/analysis (no raw PII)
  analysisId?: string
  at: number                   // created timestamp (epoch ms)
  originalRef: string          // blob URL/key of the original image
  optimizedRef: string         // blob URL/key of the .ai.jpg derivative
  preprocessVersion: string    // image-optimize pipeline version
  transformations: string[]    // e.g. ['autocrop','normalize','sharpen']
  original: OptEvalSample       // object/volume/truck-fill/confidence/latency/bytes/tokens/cost
  optimized: OptEvalSample
  result: OptEvalResult         // deltas + verdict + reasons (object/volume/truck-fill/confidence/quote-outcome)
  quoteOutcomeOriginal?: string // e.g. instant_quote | estimate_range | review
  quoteOutcomeOptimized?: string
  fallbackUsed: boolean         // derivative failed → fell back to original
  passFail: 'pass' | 'fail'     // = verdict !== 'accuracy_regression'
}
```
Covers every field the owner listed: original ref, optimized ref, preprocess version, transformations, object/volume/truck-fill/confidence/quote-outcome comparisons, latency, tokens, est. cost, fallback state, pass/fail, tenant id, timestamps.

## 6. Tenant isolation, access control, retention, deletion, privacy
- **Tenant isolation:** every record carries `tenantId`; the store is keyed per tenant (`opt-eval:<tenantId>` ZSET by `at`); reads are tenant-scoped exactly like existing admin analytics.
- **Access control:** read API gated on `requirePermission('ai:analytics')` (admin/manager). No public access.
- **Retention:** bounded window (e.g. 30 days / N most-recent), matching the pipeline-trace retention pattern; older entries trimmed on write.
- **Deletion:** deleting a booking/tenant must cascade-delete its eval records; provide an admin purge.
- **Privacy:** store **references** (blob keys) not image bytes; the UI fetches previews through the existing authorized blob path. No new PII beyond what the admin booking view already exposes. No customer-facing surface.

## 7. Smallest safe future implementation — isolated increments
1. **Evaluation recording** — flag `IMAGE_OPT_AB_SHADOW_ENABLED` (OFF): run the derivative A/B analysis + `compareOptimizationOutcome`, emit `OptEvalRecord` (fire-and-forget). No quote/pricing change.
2. **Persistence / read model** — a single KV helper (`recordOptEval` / `listOptEval`), tenant-keyed, bounded retention. No duplicate persistence layer.
3. **Read-only API** — `app/api/admin/ai/image-eval/route.ts`: `requirePermission`, tenant-scoped, pagination + filters, graceful empty/unavailable, zero AI calls.
4. **Admin UI** — a **separate** route `app/admin/operations/ai/image-eval/page.tsx` (not the shared AI page): original/derivative previews, side-by-side, deltas, verdict, filters, SC branding.
5. **Preview validation** — enable the shadow flag in Preview, run a synthetic booking, confirm records + UI, then disable.

## 8. Required feature flags (all default OFF)
- `IMAGE_OPT_AB_SHADOW_ENABLED` (recording; the A/B double-analysis)
- `IMAGE_EVAL_ADMIN_ENABLED` (admin UI visibility) — optional; only if a real rollout gate is needed.

## 9. Required tests & rollback
- Tests: permission enforcement, tenant isolation, empty state, comparison rendering, legacy-record compat, missing-derivative handling, fallback handling, API pagination/filtering, no-mutation-on-read, recording idempotency.
- Rollback: each increment is a separate flag-gated PR; flags OFF = inert; revert the increment PR. Recording is fire-and-forget, so disabling the flag stops new records with zero customer impact.
