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
