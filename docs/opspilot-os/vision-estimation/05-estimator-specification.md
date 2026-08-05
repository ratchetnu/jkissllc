# The Operion estimator specification

**Status:** canonical. This document is the authority on what the photo estimator must
do. The runtime prompts are a compressed expression of it, and
`scripts/estimator-spec.test.ts` enforces that they still say the required things.

**This file is never sent to the model.** It is roughly ten times the size of the
prompt it governs, and every token of a system prompt is paid for on every request,
forever. The spec explains and justifies; the runtime states. Where this document
argues a point over a paragraph, the prompt gets one clause — and the test proves the
clause is present.

---

## Why this exists

Estimator instructions had accumulated in five places: four prompts in the registry
(`ops.photoEstimate`, `ops.junkAnalysis`, `ops.junkAnalysisReview`,
`ops.movingAnalysis`) and `analysis-v2-prompt.ts`. The same rule appeared in different
words in each, or was simply missing:

| Rule | Stated in |
|---|---|
| treat the photo set as ONE job | 2 of 4 prompts |
| reconcile duplicate views | 1 of 4, and differently worded elsewhere |
| never set a price | 2 of 4 |
| confidence semantics | 3 of 4, with no shared scale until v3 |

Nothing enforced consistency, so a fix applied to one lane silently left the others
behind. That is how the moving lane shipped without a confidence scale while the junk
lane had one, and how "don't double-count" meant three different things.

One specification, one shared runtime core, one module per service family.

---

## 1. Scope and separation

Two service families, two lanes, and **nothing shared downstream of the routing
decision**:

```
junk   → ops.junkAnalysis   → normalizeAnalysis       → disposal.priceJob
moving → ops.movingAnalysis → normalizeMovingAnalysis → moving-quote.priceMove
```

- A **moving** request must never reach junk-removal logic, vocabulary, or pricing.
- A **junk** request must never reach moving logic or pricing.
- The lane is chosen from the validated service type, never from anything a caller
  supplies. See `serviceFamily()` and the routing gate in `/api/quote/analyze`.

Schemas, normalizers and pricing engines stay separate. Sharing them is how a move
gets billed for a landfill trip.

## 2. What the estimator does

1. Analyze **all submitted photos as one job**, not one job per photo.
2. Determine **photo quality and coverage** — and say when coverage is partial.
3. Identify **scenes or rooms**, and the **visible objects** in them.
4. **Recognize the same object across photos** and count each physical object **once**.
5. Use **quantity ranges** when uncertain; an exact count only when it is countable.
6. Distinguish **visible facts from estimates**. Never invent hidden objects; report
   suspected out-of-frame inventory as a risk, not as items.
7. Estimate **operational inputs**: size, volume, handling, access, crew, labour.
8. Return **compact structured data only**.

## 3. What the estimator must never do

- **Never calculate final customer pricing.** The model produces observations; a
  deterministic engine produces money. This is the single most important boundary in
  the system: a model that prices cannot be audited, tuned, or held to a margin.
- **Never return chain-of-thought or prose.** Reasoning text is unparseable, expensive,
  and — at a fixed output ceiling — it is inventory that got cut off to make room for
  narration.
- **Never default confidence to 1.0.** See §5.
- **Never mix the lanes.** See §1.
- **Never fail open.** An incomplete or invalid analysis is classified and routed to a
  human; it must not become a confident empty result. See §6.

## 4. Cross-photo reconciliation

Several photos of one room are one room. The estimator must mark a repeated view and
attribute each item to the photo it was seen in, so a duplicate is *reconcilable* rather
than merely asserted.

Getting this wrong is expensive in both directions: double-counting inflates a quote and
loses the job; under-counting sends one truck to a two-truck move.

## 5. Confidence

Every confidence value is a **decimal from 0.0 to 1.0** — never a percentage, never a
string, never absent.

| Value | Meaning |
|---|---|
| 0.0 | no reliable evidence |
| 0.5 | partial, uncertain, obstructed or incomplete evidence |
| 1.0 | exceptionally clear, complete, fully supported evidence |

**Perfect confidence is rare and must not be the default.** Dimensions are scored
independently, and a summary dimension (`overall`) may not exceed the weakest dimension
it summarises.

Lower confidence for: partial room coverage, occluded or stacked items, uncertain
quantities, a room possibly shown twice, poor lighting, no view of the access route, an
uncertain volume, or inventory suspected out of frame.

**The prompt asks; the normalizer enforces.** Asking a model to be humble and then
trusting the answer is not a control. Penalties are applied from facts the normalizer
observes for itself — photo quality, the duplicate flag, the width of the volume range,
whether access was ever visible. An out-of-contract value (a percentage, a string, a
missing field) is rejected and recorded, never clamped into range: clamping 85 to 1.0 is
how a 56% false-high-confidence rate was manufactured.

## 6. Safe classification

An analysis that cannot be trusted must be *visibly* untrustworthy:

- Truncated output is classified as **`output_truncated`**, never as an empty read. They
  look identical from outside — zero items either way — but only one is fixed by
  changing a number.
- An unparseable or empty read forces review and carries **no price at all**, not a
  price of zero.
- Failures are preserved with a reason, and the submission is never lost.

## 7. Junk-removal module

Inventory **intended for removal**. Cubic-volume and truck-space inputs; compactable
versus rigid material; heavy-item flags; appliance and mattress flags; special-disposal
indicators; hazardous or prohibited material flagged for review; labour and crew ranges.

**No final disposal price.** Loose non-compacting material (brush, mattresses) consumes
truck volume far faster than its apparent pile size — that is an observation the model
makes, not a price it sets.

## 8. Moving module

Belongings **intended for relocation** — packed, carried, loaded, transported, unloaded.
They are not junk, not debris, and not going to a landfill.

Furniture and box inventory; bulky, fragile, disassembly and appliance flags; crew range;
**separate loading and unloading** labour ranges; access facts *only when visible*; and
**missing non-visual information** — destination, travel distance, stairs or elevator,
parking, packing — reported as codes so the lane can ask instead of inventing.

**No landfill, dump, disposal or junk pricing may appear**, in the prompt or the output.

## 9. Output budget

Compactness is a correctness property, not a style preference. At a fixed output
ceiling, every token of prose is a token of inventory that does not fit — and a JSON
object cut off mid-item is discarded whole.

The measured cost of the moving contract is ~19 output tokens per item compact, versus
~74 verbose. Ceilings: **moving 2400**, **junk 1600**. Raise a ceiling only against
evidence of a real case truncating, and prefer compacting the contract first — a larger
ceiling buys latency and cost, not accuracy.

---

## Enforcement

`scripts/estimator-spec.test.ts` asserts that the runtime prompts still carry the
behaviour this document requires: cross-photo reconciliation, the confidence scale and
the no-default rule, the no-prose and no-price rules, lane purity in both directions,
and that the runtime stays materially smaller than this specification.

When this document and the runtime disagree, the test fails. Change both, deliberately,
and bump the prompt version — a changed prompt running under its old version number
makes the audit log lie about what ran.
