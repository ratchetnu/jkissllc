# Operion Enterprise Vision Estimation — Program (2026-07-15)

> Reuse-and-connect program for the EXISTING Book Now AI photo-assessment + pricing
> pipeline. Not a rebuild. Branch `feat/operion-enterprise-vision-estimation`.
> `TENANCY_ENABLED=false`; all enhancements are SHADOW (flag `VISION_ESTIMATION_SHADOW`,
> default off) — computed/recorded for admin comparison, never authoritative over the
> live estimate/quote until promotion gates pass.

## 1. Verified current-state audit (Phase 1)

The AI estimation subsystem is already substantial (`app/lib/ai/*`, 24 modules) and is
**mostly connected**. Verified directly in the repo:

| Stage | Component | Status |
|---|---|---|
| Photo upload + media validation | `app/api/upload/route.ts` (type/size/count, SSRF-safe URLs) | ✅ working |
| Vision analysis | `ai/photo-estimate.ts` → `ai/junk-analysis.ts` (vision) | ✅ working |
| Structured result | `ai/analysis-schema.ts` (`ANALYSIS_SCHEMA_VERSION=1`, normalizer never throws/prices) | ✅ working |
| QA / monitor | `ai/analysis-monitor.ts` | ✅ working |
| Critic (2nd pass) | `ai/junk-critic.ts` | ✅ working |
| Governed taxonomy | `ai/inventory-taxonomy.ts` (customer categories → volume/weight/handling; now `INVENTORY_TAXONOMY_VERSION=1`) | ✅ working |
| Deterministic pricing | `lib/pricing/quote-decision.ts` (`PRICING_DECISION_VERSION='junk-decision-1'`; AI never sets price) | ✅ working |
| Confidence routing | `quote-decision.ts` (instant/range/manual_review) | ✅ working |
| Durable worker | `lib/book-now-ai.ts` (retry + timeout + reaper, from the hardening sprint) | ✅ working |
| Response-quality score | `ai/quality.ts` (scores the MODEL RESPONSE, not the photos) | ✅ working |
| Feature eval harness | `ai/eval.ts` (prompt/schema fixtures) | ✅ working |
| Job-learning + calibration | `lib/job-learning.ts` (per-category fill-bias EWMA, `accuracyStats` incl. `priceMape`) | ⚠️ present but starved |
| **Outcome recording** | `api/admin/disposal/outcomes/route.ts` | ❌ **DISCONNECTED (fixed this sprint)** |

**Confirmed root disconnect (Phase 12):** the outcome writer built `JobOutcome` without
`aiRecommendedCents`/`overridden`, so `accuracyStats.priceMape` was permanently `null` and
`overrideRate` always `0` — the model never learned how close its estimate was to the final
price. `JobOutcome` already *had* those fields; only the writer was starving them.

**Gaps (genuinely missing, not duplicated):** photo-QUALITY gate; per-photo usability signals;
richer version stamping into outcomes; explainable calibration engine beyond the single
fill-bias; offline inventory ground-truth eval dataset; guided-capture UI; customer inventory
review; shadow-mode comparison telemetry.

## 2. Built this sprint (shadow / backend contract, tested)

- **Learning loop closed (Phase 12):** `JobOutcome` extended with `bookingId`, `adminQuotedCents`,
  `acceptedQuoteCents`, `finalInvoiceCents`, `estimateVersion`, `promptVersion`, `taxonomyVersion`,
  `pricingRuleVersion`, and optional actuals (`actualVolume/Weight/LaborHours/CrewSize/TruckLoads`,
  `inventoryCorrections`, `reasonForDifference`, `completionTimestamp`). The writer now persists
  `aiRecommendedCents`/`overridden` (+ versions). New pure `lib/outcome-capture.ts`
  `buildOutcomeFromBooking()` snapshots the AI-vs-quoted numbers from a Booking; `mark-completed`
  captures that snapshot **without** auto-writing empty actuals (so calibration isn't polluted).
  Result: `priceMape`/`overrideRate` compute once outcomes carry the AI number. **No change to the
  EWMA/bias math. Actuals are never fabricated.**
- **Photo-quality gate (Phase 3):** new pure `ai/photo-quality-gate.ts` classifies a submission
  (`sufficient` / `sufficient_with_warnings` / `clarification_recommended` /
  `additional_photos_required` / `manual_review_required`) from available server-side signals
  (count, type, bytes, duplicate heuristic, optional per-photo signals), with configurable
  thresholds (`QUALITY_GATE_VERSION`) and targeted customer guidance. Biases toward warnings over
  hard blocks. Pure/deterministic; not yet wired into the live path (see §3).
- **Version stamping (Phase 16 subset):** `INVENTORY_TAXONOMY_VERSION` added; estimate/pricing/
  schema versions now recordable on outcomes for auditable calibration.
- **Shadow flag (Phase 19):** `VISION_ESTIMATION_SHADOW` (default off) governs surfacing/using any
  enhancement; the current estimate stays authoritative.

## 2b. Built in the follow-up sprint (Phases 2–10, shadow — 2026-07-15)

The deterministic estimation ENGINE now exists (`app/lib/estimation/*`), reusing the taxonomy +
`priceJob` (no new pricing math, no duplicate taxonomy). Shadow only (`VISION_ESTIMATION_SHADOW`,
off): computed in parallel in the worker, stashed on the booking for admin comparison, never
authoritative, never shown to customers.

- **Structured inventory (Phase 2):** `inventory-extract.ts` maps vision observations →
  `InventoryItem[]` (taxonomy-mapped, per-unit volume/weight, source images, uncertainty),
  **dedups the same item across photos**, and safety-upgrades a mislabeled restricted item.
- **Deterministic volume (Phase 3):** `volume-engine.ts` — cu ft/yd, truck fraction, loads as
  low/expected/high bands (wider when confidence is lower). AI never gives these numbers.
- **Deterministic weight (Phase 4):** `weight-engine.ts` — governed `WEIGHT_CLASS_LBS_PER_CUBIC_YARD`
  (+ dense-debris floor); min/expected/max; heavy-item flags.
- **Operational complexity (Phase 5):** `complexity.ts` — crew/truck/labor/load-time/equipment/PPE
  and low/medium/high with explainable `factors[]`.
- **Explainable pricing (Phase 6):** `pricing-explain.ts` — transforms the EXISTING `priceJob`
  breakdown (`costLines`) into labeled `adjustments[]` with reasons; every number traces to the
  deterministic engine.
- **Admin explainability (Phase 7):** the existing Book Now request detail page shows an internal
  "Shadow estimate" block (inventory, volume/weight/truck/crew/labor, risk, restricted, pricing,
  clarifications, versions) when a shadow result is attached — not a redesign.
- **Clarification (Phase 8):** `clarify.ts` reuses `followup-questions` to emit ≤4 targeted
  questions on specific uncertainty (sectional sections, appliance disconnected, hidden items,
  stairs) — [] when confident.
- **Shadow + metrics (Phases 9/10):** `shadow.ts` records the current-vs-new delta with a
  PII-safe allow-listed payload (`SHADOW_LOG_SAFE_KEYS`); `metrics.ts` aggregates enterprise
  metrics deterministically, returning null (never fabricated) without ground truth.

Contract types: `app/lib/estimation/types.ts` (`ESTIMATION_ENGINE_VERSION`). Wired fail-soft into
`book-now-ai.ts` under the flag — off ⇒ byte-identical.

## 2c. Defect fixed — HEIC photos unreadable by the vision model (2026-07-15)

**Owner-reported:** iPhone HEIC photos of tree-trimming piles → "couldn't identify … no accurate
quote." **Root cause (confirmed in code):** the upload routes accepted `heic/heif` (iOS default)
and stored them as `image/heic`; `junk-analysis.ts:66` handed that raw HEIC URL to the vision
model, which decodes JPEG/PNG/WebP/GIF but **not HEIC** → the model saw nothing → `no_items` →
manual-review fallback. Affected every iPhone-HEIC submission on the CURRENT (authoritative)
estimator, not just shadow.

**Fix (owner-approved: convert server-side at upload):** new `app/lib/image-convert.ts`
(`toModelReadableImage` / `toModelReadableDataUrl`, using `heic-convert` — pure-JS/libheif wasm,
externalized via `serverExternalPackages`). HEIC/HEIF → JPEG before storage / before the model
call; non-HEIC passes through unchanged; an undecodable HEIC returns a clear "re-take / upload a
JPG or PNG" message instead of a silent failure. Wired into `/api/upload` (customer),
`/api/admin/upload`, and `/api/ai/photo-estimate`. Tests in `scripts/image-convert.test.ts`. On
the branch → Preview; **no production change until owner approval.** The photo-quality gate's
`heic_source` advisory is now backed by real conversion.

## 3. Staged follow-ups (contract defined, NOT built this sprint)

Per the sprint's "complete the backend contract now, document UI/expansion later" guidance:

- **Phase 4 — Guided photo capture UI:** wire the quality gate + guidance into the `/quote` wizard
  (post-upload "add a wide shot / show the access path" hints). Backend contract ready; UI deferred
  to avoid conflicting with the just-shipped wizard a11y + confirmation fix.
- **Phase 5/6/7 — Richer inventory + deterministic volume/weight/labor/access:** extend the vision
  prompt to emit fixed-taxonomy itemization with counts + source-image refs + duplicate-view
  flags; expand deterministic low/expected/high volume+weight ranges; deterministic access/labor/
  crew/equipment model. (Taxonomy + `priceJob` already exist to extend.)
- **Phase 8 — Pricing explanation object:** a canonical `explanation` on the decision for admin
  display (adjustments itemized, versioned).
- **Phase 9/10 — Critic upgrade + self-consistency:** strengthen `junk-critic` comparisons; add a
  threshold-gated second independent extraction for high-value/low-confidence jobs.
- **Phase 11 — Clarification engine:** expand `ai/followup-questions.ts` to a few high-value,
  uncertainty-targeted questions; re-run only affected calculations.
- **Phase 13 — Calibration engine:** explainable calibration by service/category/volume-band/
  confidence, with minimum sample size, max-adjustment-per-release, outlier handling, versioned
  factors, rollback, per-tenant isolation (keys already tenant-scoped via the chokepoint).
- **Phase 14/15 — Admin explainability + customer inventory review:** surface the richer analysis
  in the existing request drawer; optional customer "confirm your items" step gated by the quality
  gate.
- **Phase 17/18 — Offline eval dataset + metrics:** synthetic/anonymized ground-truth cases;
  inventory precision/recall, volume/weight error, price MAPE, restricted-item recall.

## 4. Promotion gates (Phase 20) — before any enhancement becomes authoritative

No Critical/High security issues · schema validation passes · restricted-item recall ≥ threshold ·
underquote rate improves or within tolerance · price MAPE improves vs baseline · manual-review rate
acceptable · latency + cost/estimate acceptable · tenant-isolation tests pass · admin corrections
persist · learning loop writes complete outcomes · rollback tested. **Promotion is a deliberate,
owner-approved step — not automatic.**

## 5. Baseline (to be measured under shadow)

Baseline price MAPE was **unmeasurable** before this sprint (`priceMape=null`). With the loop closed,
the baseline becomes measurable as outcomes accrue — the first real number is the promotion gate's
reference. See `CHANGELOG.md` (2026-07-15).
