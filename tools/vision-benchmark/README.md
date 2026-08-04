# Vision benchmark

A dataset and harness for **evaluating** the photo-quote analyzer: its prompts, its response schema, its confidence thresholds and the deterministic pricing rules downstream of it.

**This does not train or improve the vision model.** Nothing here touches model weights. The dataset exists for evaluation, calibration, regression testing and prompt/schema refinement — describing it as anything more would be false.

---

## Where things live

| What | Where | Committed? |
|---|---|---|
| Tooling, schemas, tests | `tools/vision-benchmark/` (this directory) | ✅ yes |
| Images, manifests, results | `$VISION_BENCHMARK_DIR` (default `~/jkiss-vision-benchmark`) | ❌ **never** |

Image binaries stay out of the repository. They are third-party works under a variety of licences, and a public repo is not a licence-compliant redistribution channel. The manifest — which records where every image came from and under what terms — is the thing worth version-controlling, and it lives beside the images so it travels with them.

Benchmark images never enter Production storage and are never mixed with real customer uploads.

---

## Pipeline

```bash
# 1. Acquire — Openverse, permissive licences only, rate-limited
npx tsx tools/vision-benchmark/acquire.ts --per=4          # --dry-run to preview
npx tsx tools/vision-benchmark/acquire.ts --junk --per=6   # one job type

# 2. Organise — assign splits, propose multi-photo job groups
npx tsx tools/vision-benchmark/organize.ts                 # dry run
npx tsx tools/vision-benchmark/organize.ts --apply

# 3. Review + label — REQUIRED before anything runs
npx tsx tools/vision-benchmark/label.ts                    # http://localhost:7391

# 4. Benchmark + report — ONE command. Junk removal only, preflight-gated.
#    Preview env first (never Production):
#      AI_PROVIDER_DIAGNOSTIC_ENABLED=1
#      AI_EVAL_TELEMETRY_ENABLED=1        ← must be set BEFORE the run
BENCH_TARGET=https://<preview>.vercel.app \
VERCEL_AUTOMATION_BYPASS_SECRET=… \
  npm run bench:junk
#    Interrupted?  … npm run bench:junk -- --resume
#    Preview only:  … npm run bench:junk -- --dry-run
```

`bench:junk` runs **preflight → benchmark → report**. The preflight is a spend
gate: it calls the provider diagnostic and stops before any model call if
inference cannot run, naming the fix owner. Discovering an empty gateway balance
costs two seconds instead of ten model calls.

It is **junk removal only** by default. `--job-type=moving` exists but should not
be used yet: the analyze route does not gate on service family, so a moving photo
is read by the junk-removal prompt and priced by the disposal engine — a
confident junk-removal quote for a moving job, silently tabulated as "moving".

---

## Sourcing rules

**Source:** [Openverse](https://openverse.org) — a CC-licensed image index with a documented public API, no key required. Each result carries its licence and its original source page.

**Search engines are used for human discovery only, never for fetching.** Google and friends disallow automated result scraping in `robots.txt`, and result thumbnails are not canonical images. A person may of course find something in a search engine and paste the *source page* into the manifest by hand.

**Licence gate.** Only licences permitting commercial use *and* modification are fetched automatically:

| Auto-accepted | Auto-rejected (logged with reason) |
|---|---|
| `cc0`, `pdm`, `by`, `by-sa` | every `-nc` variant, every `-nd` variant, `sampling+`, anything unrecognised |

We are evaluating a **commercial** product, so a NonCommercial licence is not a safe basis for automated download whatever the intent. NoDerivatives is refused too: resizing and cropping for model input is a derivative. Every rejection lands in `rejected-sources.json` with its reason, so exclusions are auditable rather than invisible.

`licenseVerified` is **false** on everything the acquirer writes. An API's licence field is a strong signal, not a legal opinion; a human confirms it against the source page during review.

**Never touched:** authentication, paywalls, CAPTCHAs, anti-bot systems, private social media. Requests are rate-limited (1.2s gap) and carry a descriptive User-Agent.

---

## What requires a human, and why

The acquirer is deliberately incapable of approving anything. Four decisions are reserved:

- **Licence** — confirmed against the source page, not the API field.
- **Content** — a text screen cannot see a photograph. Titles and tags are keyword-scanned for people, children, documents, plates and addresses, and a hit **demotes to review**; it never certifies an image as clean. Approval is blocked server-side if "contains identifiable people" is ticked.
- **Ground truth** — cubic yards and truck-space percentage cannot be derived from a stranger's photo by the system under test. If the model supplied the answers, the benchmark would be grading its own homework.
- **Hazard classification and operational reasonableness** — safety calls.

Ground truth is entered as a **range**, never a point value. For most photos the honest label is "between 2 and 4 cubic yards", and forcing a single number manufactures precision the accuracy report would then treat as fact. Leaving a field blank is better than guessing: blank is excluded from scoring, a guess corrupts it.

---

## Splits

`development` / `holdout` / `edge_case`, with three rules that exist to stop the benchmark flattering us:

1. **Assignment is permanent.** An image is assigned once and never moves — otherwise a bad result can be "fixed" by quietly relocating the image.
2. **Near-duplicate clusters move together.** Detected by perceptual hash (dHash, Hamming ≤ 8). Without this, a photo tuned against in development reappears in the holdout in a different crop.
3. **The holdout is not for development.** Tuning prompts against it makes it a development set with a misleading name. `report.ts` prints a leakage warning if rule 2 is ever violated.

`#edge` anywhere in a labeller's notes forces an image into the edge-case set.

---

## Reports

`report.ts` emits six sections. Each answers a different question and has different evidence requirements:

| Report | Needs |
|---|---|
| Coverage | manifest only — lists **every** taxonomy category so gaps are visible |
| Duplicates | manifest only — exact, near, and split leakage |
| Latency | a benchmark run — p50/p90/p95 vs the product targets, split by job type |
| Accuracy | **human labels** — per job type, never pooled |
| Calibration | **human labels** + confidence — does stated confidence predict correctness |
| Failure gallery | a benchmark run |

**A report that cannot be computed says so.** Accuracy over zero labelled images is not 100% and not 0% — it is `unavailable`, and printing a number there would be the most misleading thing this tool could do.

Accuracy is reported **per job type**. Junk removal and moving have different inventories, volume distributions and pricing rules; one pooled number hides a regression in whichever type has fewer samples.

The most important column in the calibration report is **false-high-confidence**: confident *and* materially wrong. A customer quoted a number nobody checked is worse than a customer told we are unsure. It should fall as confidence rises; if it does not, confidence is being driven by model phrasing rather than measurable evidence.

---

## Instrumentation — how the internals are measured

`customerEstimateView` is a customer-safe projection. It exposes `estimatedTruckLoads` — a whole-number load count computed as `max(1, ceil(fraction))` — but not `estimatedTruckLoadFraction`, the value pricing actually consumes. A benchmark reading only the public response sees "1 load" for a single couch, and deriving volume from it produces numbers wrong by an order of magnitude. An earlier revision of `report.ts` did exactly that.

The fix is **evaluation telemetry**: `app/lib/ai/eval-telemetry.ts` records the estimate-side facts to KV, keyed by analysis id, and `/api/diagnostics/analysis/[analysisId]` reads them back joined to the AI audit log.

| Source | Carries |
|---|---|
| Evaluation record | truck-load **fraction** (real %), volume, all five confidence sub-scores, monitor concerns, critic verdict, decision, quote |
| AI audit log (joined by `callId`) | input/output tokens, estimated + actual cost, attempts, retries, provider latency |

Token usage and cost are **not copied** into the evaluation record — `recordAiCall` is already their single source of truth, and a second copy could drift from the first. The reader joins them.

**Three gates, all required:** the route and the recorder both 404 / no-op when `VERCEL_ENV=production` regardless of flags; `AI_EVAL_TELEMETRY_ENABLED` is OFF everywhere by default; Preview deployment protection fronts the host. The customer response, the quote and the decision are byte-identical whether the flag is on or off.

**The flag must be set before the analysis runs** — the record is written during the request, so enabling it afterwards cannot recover data for an analysis that already happened.

## Pacing

`/api/quote/analyze` allows **10 requests per 10 minutes**. The first Preview run ignored that: 10 succeeded, 17 returned 429 in ~110ms each, and those fast rejections then dragged the latency percentiles down.

`pacing.ts` keeps two clocks strictly apart:

- **Wait time** — respecting the limit, or honouring a server `Retry-After`. Reported separately, never latency.
- **Inference time** — the request span only. The sole thing measured.

A 429 is not a result: the runner honours `Retry-After` (both delta-seconds and HTTP-date forms), retries the same job up to 4 times, and records the wait against the job rather than as a latency sample. Results are checkpointed after **every** job, so `--resume` skips work already completed against the model — and only genuine completions count, never a 429 or a transport failure.

## Cost## Cost

Live runs make real provider calls (~$0.03/job). `run-benchmark.ts` prints its estimated spend before starting, refuses any non-Preview target, and honours `--limit` and `--dry-run`.
