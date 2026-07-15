# Vision Estimation — Shadow Validation Report (2026-07-15)

> **Status: AWAITING SHADOW TRAFFIC.** The engine is deployed to Preview and shadow-ready,
> but no test bookings have been run under `VISION_ESTIMATION_SHADOW=true` yet, so there is
> **no comparison data**. This document is the methodology + template; results get filled in
> from the `vision:shadow-comparison` runtime logs once the owner exercises Preview. No
> accuracy is fabricated.

## 1. Executive summary
_Pending data._ The deterministic engine builds cleanly (tsc 0 · 733/733 tests · build OK) and
is wired fail-soft + flag-guarded into the worker; it has **not** yet been run against live
vision output, so it is **not proven better** than the current estimator. This report captures
the first real comparison once test bookings are submitted.

## 2. Preview deployment and commit
- Branch `feat/operion-enterprise-vision-estimation` · commit `5552689`
- Preview deployment `dpl_1eSiHoU8ofsRZj65McyYrcD8eUxH` (target Preview, READY, isolated `OperionPreview`/`operion-preview-blob`)
- **Note:** setting `VISION_ESTIMATION_SHADOW=true` requires a **new** Preview deployment to pick it up (env applies to new deployments), then bookings must run on that deployment's branch alias.

## 3. Test methodology
1. Owner sets `VISION_ESTIMATION_SHADOW=true` in **Preview scope only** (Production stays false), redeploys the branch.
2. Owner submits Preview-only Book Now requests with the 10 representative photo sets below (staged/synthetic/privacy-safe — **no live customer photos** unless explicitly approved).
3. The durable AI worker runs the current estimator (authoritative) AND, under the flag, the shadow engine — the customer sees only the current engine.
4. The admin Book Now detail page shows the internal "Shadow estimate" block.
5. Claude pulls `vision:shadow-comparison` (+ worker/error) telemetry via Vercel runtime logs and fills §5–§16.
6. Each case is human-scored against its stated expectation (§5 scorecard) — no fabricated accuracy.

## 4. Test cases (template — fill "Photos used" + "Expected …" before submitting)

| ID | Service | Expected visible inventory | Expected volume band | Expected complexity | Expected manual review | Photos | Known limits |
|---|---|---|---|---|---|---|---|
| TC-01 Small household pickup | junk-removal | _e.g. few boxes + 1 chair_ | _low (≤3 cu yd)_ | low | no | _—_ | _—_ |
| TC-02 Furniture-heavy | junk-removal | _2 sofas, dresser, table+chairs_ | _med_ | med | no | | |
| TC-03 Appliance pickup | junk-removal | _fridge + washer + dryer_ | _low-med_ | med (heavy) | no | | |
| TC-04 Mixed junk | junk-removal | _furniture + bags + misc_ | _med_ | med | no | | |
| TC-05 Yard debris | junk-removal | _brush + limbs pile_ | _med_ | low-med | no | | |
| TC-06 Construction debris | junk-removal | _drywall + lumber + concrete_ | _med-high_ | high (dense) | maybe | | |
| TC-07 Heavy-item | junk-removal | _safe / piano / hot tub_ | _low_ | high (special) | likely | | |
| TC-08 Low-quality/incomplete photos | junk-removal | _ambiguous_ | _wide band_ | — | likely (quality gate) | | |
| TC-09 Duplicate-angle set | junk-removal | _one pile, several angles_ | _low-med_ | low | no | _dedup must NOT double-count_ | |
| TC-10 Restricted-item | junk-removal | _paint / chemicals / propane_ | _low_ | — | **required** | _restricted must be flagged_ | |

## 5. Human review scorecard (Accurate / Mostly / Partially / Incorrect / Not Verifiable)
| ID | Inventory | Count | Dedup | Category | Restricted | Volume | Weight | Truck | Crew | Labor | Pricing expl. | Clarify | Manual review |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TC-01…TC-10 | _pending_ | | | | | | | | | | | | |

## 6–16. Current vs shadow comparison (per case) — _pending telemetry_
For each TC, from the logs + admin block:
- **Current engine:** inventory summary · volume · price · confidence · manual-review decision.
- **Shadow engine:** structured inventory · volume low/exp/high · weight low/exp/high · truck fraction + loads · crew · labor hours · equipment · complexity · restricted handling · price + range · clarification questions · confidence · manual-review decision · deltaCents/deltaPct.

## 17. Defects found
_None yet (no run)._ Any Critical/High (restricted missed, dedup fails, volume/weight clearly wrong, worker crash, shadow leaks to customer, customer estimate replaced) → reproduce → smallest fix → regression test → gates → re-run.

## 18. Fixes applied
_None yet._

## 19. Data limitations
No live customer photos to be used without approval; synthetic/staged sets can't perfectly represent field conditions; volume/weight "ground truth" is approximate until completed-job actuals accrue; per-photo pixel-quality signals (blur/exposure/pHash dedup) are not yet produced upstream, so several quality-gate codes are advisory.

## 20. Initial promotion blockers
No measured baseline yet; shadow engine unexercised on real vision output; offline eval dataset (Phase 17/18) not built; guided-capture UI + calibration engine staged. Promotion stays gated.

## 21. Recommended next sprint
Once this report has data: build the offline eval dataset + metrics (ground-truth inventory/volume) so price-MAPE / inventory-accuracy get a real baseline; then tune only what the shadow deltas justify (never retune pricing from a small sample).
