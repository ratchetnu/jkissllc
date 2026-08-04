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

# 4. Benchmark — Preview only
BENCH_TARGET=https://<preview>.vercel.app \
VERCEL_AUTOMATION_BYPASS_SECRET=… \
  npx tsx tools/vision-benchmark/run-benchmark.ts --split=development

# 5. Report
npx tsx tools/vision-benchmark/report.ts
```

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

## Instrumentation gap

Five of the metrics a rollout needs **cannot be measured from the analyze endpoint's response**, because `customerEstimateView` is a deliberately customer-safe projection:

| Metric | Why it isn't observable |
|---|---|
| Volume (cubic yards) | The response carries `estimatedTruckLoads`, a whole-number load count derived as `max(1, ceil(fraction))`. Every sub-full-truck job reports **1**. `estimatedTruckLoadFraction` — what pricing actually consumes — is not exposed. |
| Truck-space percentage | Same root cause. `loads × 100%` reads 100% for a single couch. |
| Output token usage | Not in the response. |
| Estimated cost | Not in the response. |
| Critic invocation + added latency | Not in the response. |

**An earlier revision of `report.ts` computed volume as `loads × 44` and truck-space as `loads × 100%`.** Those produce 44 cu yd and 100% for a one-item job — wrong by an order of magnitude, and plausible enough to be believed. The columns were removed rather than left to print confident nonsense. Accuracy now scores **item detection**, and calibration scores **false-high-confidence on item detection** — the only correctness signal the public response actually supports.

Closing the gap needs a **Preview-only, flag-gated instrumentation block** on the analyze response carrying the fraction, token usage, cost and critic state. That is a change to a customer-facing route, so it is proposed rather than built — decide before the first paid run, because without it the accuracy and cost halves of the report stay empty no matter how many images are labelled.

## Cost

Live runs make real provider calls (~$0.03/job). `run-benchmark.ts` prints its estimated spend before starting, refuses any non-Preview target, and honours `--limit` and `--dry-run`.
