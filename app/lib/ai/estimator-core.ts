// ─────────────────────────────────────────────────────────────────────────────
// The estimator runtime: one shared core, one module per service family.
//
// The canonical rules live in docs/opspilot-os/vision-estimation/05-estimator-
// specification.md. That document explains and justifies; these strings state.
// The spec is roughly ten times this size and is NEVER sent to the model — a
// system prompt is paid for on every request, forever, so the runtime carries
// the rule and the spec carries the reason.
//
// Before this, estimator instructions lived in five places and said the same
// thing differently, or not at all: "treat the set as ONE job" appeared in two
// of four prompts, "never set a price" in two, and the confidence scale in none
// until the moving lane shipped without one. A fix applied to one lane silently
// left the others behind. Shared rules now have exactly one wording.
//
// scripts/estimator-spec.test.ts enforces that what the spec requires is still
// present here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rules that are true of every photo estimate, regardless of service family.
 * Deliberately terse: each line is a rule the specification argues at length.
 */
export const ESTIMATOR_CORE =
  `Analyze the COMPLETE photo set as ONE job — not one job per photo.\n` +
  `Several photos of one room are one room: mark a repeated view, attribute every item to the photo it was seen in, and count each physical object ONCE.\n` +
  `Report what you can SEE. Use conservative ranges when uncertain, an exact count only when it is countable, and never invent objects you cannot see — inventory you suspect is out of frame is a risk to report, not an item to list.\n` +
  `Output schema-valid minified JSON ONLY: no prose, no explanations, no markdown, no code fences, no reasoning — your working is not wanted, and at a fixed output ceiling every sentence you write is inventory that gets cut off.\n` +
  `You NEVER set a price. A separate deterministic engine does that from your observations.\n` +
  `CONFIDENCE is a DECIMAL from 0.0 to 1.0 — never a percentage, never a string. 0.0 = no reliable evidence · 0.5 = partial, uncertain, obstructed or incomplete evidence · 1.0 = exceptionally clear, complete, fully supported evidence.\n` +
  `DO NOT default to 1.0. Perfect confidence is rare in a photograph. Score each dimension independently and lower the relevant ones for partial room coverage, occluded or stacked items, uncertain quantities, a room possibly shown twice, poor lighting, no view of the access route, or an uncertain volume.`

/**
 * Junk removal: material intended to LEAVE the site. The observations a disposal
 * engine needs — and no price, which is the engine's job.
 */
export const JUNK_ESTIMATOR_MODULE =
  `This is JUNK REMOVAL: the items are intended for REMOVAL and disposal.\n` +
  `Report cubic-volume and truck-space inputs; whether material is compactable or rigid; heavy items; appliances and mattresses; anything needing special disposal; and any hazardous or prohibited material, which is flagged for human review rather than estimated.\n` +
  `Loose non-compacting material — brush, limbs, mattresses — consumes truck volume far faster than its pile size suggests. That is an observation, not a surcharge.\n` +
  `Give crew and labour ranges. Give NO final disposal price.`

/**
 * Moving: belongings intended to ARRIVE somewhere else. No disposal vocabulary
 * appears here except to forbid it — a model told to price a "load" will price
 * a family's furniture as material to be hauled off.
 */
export const MOVING_ESTIMATOR_MODULE =
  `This is a MOVE: the belongings are being relocated — packed, carried, loaded, transported, and unloaded at a new address. They are NOT junk, NOT debris, and NOT going to a landfill. Never describe them as discard material and never estimate disposal of any kind.\n` +
  `Report furniture and box/container inventory; bulky, fragile, disassembly and appliance handling; a crew range; and SEPARATE loading and unloading labour ranges.\n` +
  `Report access facts ONLY when you can see them. What a photo cannot tell you — destination, travel distance, stairs or elevator, parking, packing — is reported as missing information so a person can ask, never guessed.\n` +
  `Give NO price of any kind, and no landfill, dump or disposal cost — a move has none.`

/**
 * Compose a runtime system prompt: shared core, then the service module, then the
 * lane's own output contract. Order matters — the general rules are established
 * before the lane-specific ones can qualify them.
 */
export function composeEstimatorPrompt(parts: { role: string; module: string; contract: string }): string {
  return `${parts.role}\n\n${ESTIMATOR_CORE}\n\n${parts.module}\n\n${parts.contract}`
}
