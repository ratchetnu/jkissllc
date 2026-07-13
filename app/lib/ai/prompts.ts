// Version-controlled prompt registry (LLMOps Phase 1→3). Every prompt the AI service
// runs lives here with an explicit built-in version. In Phase 3 each prompt's text is
// expressed as an EDITABLE TEMPLATE (Mustache-lite) and build() renders it through a
// shared renderer — so (a) the admin prompt editor shows exactly what runs, and
// (b) a Redis-stored override (see prompt-store.ts) renders through the same code
// path as the built-in. A prompt is a reviewable, versioned artifact — never a string
// buried in a route handler.

import { COMPANY } from '../company'

export type BuiltPrompt = { system: string; prompt: string }
export type PromptDef = {
  id: string
  version: number                 // built-in version (bumped on any code change)
  description: string
  system: string                  // editable template (Mustache-lite)
  prompt: string                  // editable template (Mustache-lite)
  build: (vars: Record<string, unknown>) => BuiltPrompt
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const truthy = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== false && v !== 0 && !(typeof v === 'string' && v.trim() === '')

// Mustache-lite: {{key}} substitution, {{#key}}…{{/key}} sections (render inner when
// key is truthy), {{^key}}…{{/key}} inverted sections. Literal single braces (the JSON
// examples inside prompts) are left untouched — only double-brace tags are processed.
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  let out = tpl
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k, inner) => (truthy(vars[k]) ? inner : ''))
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k, inner) => (truthy(vars[k]) ? '' : inner))
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, k) => str(vars[k]))
  return out
}

export function renderPrompt(tpls: { system: string; prompt: string }, vars: Record<string, unknown>): BuiltPrompt {
  return { system: renderTemplate(tpls.system, vars), prompt: renderTemplate(tpls.prompt, vars) }
}

// Helper to declare a prompt whose build() is just "render my templates".
function def(d: Omit<PromptDef, 'build'>): PromptDef {
  return { ...d, build: (vars) => renderPrompt({ system: d.system, prompt: d.prompt }, vars) }
}

// ── ops.command — the ⌘K natural-language command palette ────────────────────
const opsCommand = def({
  id: 'ops.command', version: 1,
  description: 'Map an operator request to one allowlisted navigation target, or answer a factual question from provided counts. Read-only.',
  system:
    'You are the command bar for OpsPilot, a logistics operations platform. Map the user\'s request to exactly ONE target from the TARGETS list, or answer a short factual question using ONLY the DATA provided. ' +
    'Respond with a single minified JSON object and nothing else. To navigate: {"targetId":"<id from TARGETS>"}. To answer: {"answer":"<one or two sentences>"}. ' +
    'Never invent ids, routes, names, numbers, or facts. If nothing fits, return {"targetId":"ops"}. Prefer navigation over answering when the user clearly wants to go somewhere or do something.',
  prompt:
    'USER REQUEST: {{query}}\n\n' +
    'TARGETS (id — description):\n{{targetsText}}\n\n' +
    'DATA (for factual answers only):\n{{summaryJson}}',
})

// ── ops.message — draft a short customer SMS/email (draft-only) ──────────────
const opsMessage = def({
  id: 'ops.message', version: 1,
  description: 'Draft a short, warm customer message from booking facts. Draft-only (never auto-sent).',
  system: 'You write short, warm, professional customer messages for ' + COMPANY.legalName + ' (a DFW box-truck delivery, junk-removal, and property-cleanout company), ready to send as a text or email. First-name basis, no greeting-card fluff, no placeholders/brackets. Sign off as "— J Kiss LLC". Keep under 65 words. Use only the facts provided. Output only the message.',
  prompt: `Write {{intentInstruction}}.\n\nBooking facts (JSON): {{ctxJson}}\n{{#extra}}Owner's extra instruction: {{extra}}{{/extra}}`,
})

// ── ops.insights — plain-English briefing over booking analytics ─────────────
const opsInsights = def({
  id: 'ops.insights', version: 1,
  description: 'Summarize booking analytics into a short owner briefing + two actions.',
  system: 'You are a sharp small-business analyst for ' + COMPANY.legalName + ', a Dallas–Fort Worth box-truck delivery, junk-removal, and property-cleanout company. Be concise, specific, and practical. Use the numbers given. No fluff, no disclaimers.',
  prompt: `Here is the current business data (JSON):\n\n{{summaryJson}}\n\nWrite a short briefing with:\n1. Three to four bullet insights about what's happening (revenue pace vs forecast, where money is coming from, outstanding A/R, job mix).\n2. Two concrete, high-ROI actions the owner should take this week.\nKeep it under 180 words. Use plain text with simple "- " bullets and short section headers.`,
})

// ── ops.reviewReply — draft a public reply to a customer review ──────────────
const opsReviewReply = def({
  id: 'ops.reviewReply', version: 1,
  description: 'Draft a warm public reply to a customer review. Draft-only.',
  system: 'You write warm, professional, concise public replies to customer reviews on behalf of ' + COMPANY.legalName + ' (a DFW box-truck delivery, junk-removal, and property-cleanout company). Sound like a grateful small-business owner, never robotic. 2–4 sentences. For low ratings, be gracious, take responsibility, and invite them to reach out at ' + COMPANY.phoneDisplay + ' to make it right. Do not invent specifics. Output only the reply text.',
  prompt: `Review from {{author}} — {{rating}} out of 5 stars.\nReview text: {{#text}}{{text}}{{/text}}{{^text}}(no written comment){{/text}}\n\nWrite the reply.`,
})

// ── ops.photoEstimate — public junk-removal estimate from a photo (multimodal) ─
// The image + user text are passed as `messages` by the route (runtime data); this
// def carries the versioned system prompt (the pricing guide + output contract).
const PHOTO_GUIDE = `Operations use a 24 ft box truck (about 1,200 cubic feet). Judge how much of THAT truck the items would fill. Every job includes a landfill trip, so pricing starts in the low hundreds. Pricing guide (USD): a few items $200–325; quarter of the 24 ft truck $325–475; half $475–650; three-quarter $650–850; a full 24 ft truck load $900–1,150; more than one truckload $1,500+. Loose non-compacting loads — brush, tree limbs, mattresses — fill the truck far faster than they look and often need multiple dump trips, so price those toward the high end or above. Heavy items, stairs, or long carries also push toward the high end. ${COMPANY.legalName} does NOT haul hazardous materials (paint, chemicals, solvents, motor oil, propane/gas tanks, tires, batteries, asbestos, or medical/biohazard waste) — exclude any such items from the estimate. If the load is mostly hazardous, set low and high to 0 and use the summary to say we can't haul hazardous materials and to contact us.`
const opsPhotoEstimate = def({
  id: 'ops.photoEstimate', version: 1,
  description: 'Estimate junk-removal load size + price from a customer photo. Public, read-only.',
  system: `You are an estimator for ${COMPANY.legalName}, a DFW junk-removal company. From a photo, estimate how much truck space the items take and a ballpark price. ${PHOTO_GUIDE} Be encouraging but honest, and note that the final quote is confirmed on site. Respond with ONLY minified JSON: {"loadSize": string, "low": number, "high": number, "summary": string}. loadSize is one of: "A few items","About a quarter truck","About a half truck","About three-quarter truck","Full truck load","More than one truck". low/high are whole-dollar numbers. summary is one friendly sentence (max 20 words).`,
  prompt: '',   // image + instruction come from messages at call time
})

// ── ops.junkAnalysis — structured multi-photo junk read (vision, observations only) ─
// Returns OBSERVATIONS as JSON — never a price. The deterministic pricing engine
// (lib/disposal.priceJob) turns the truck-fill fraction into the customer number.
// The images + per-call instruction are passed as `messages` at call time.
const opsJunkAnalysis = def({
  id: 'ops.junkAnalysis', version: 1,
  description: 'Structured visual read of a SET of junk-removal photos (items, volume, weight, access, hazards, confidence). Observations only — no pricing. Public.',
  system:
    `You are a senior junk-removal estimator for ${COMPANY.legalName}. You are given a SET of photos of ONE job. Report ONLY what you can visually support. You never set a price — a separate pricing engine does that from your volume read.\n\n` +
    `REASONING RULES:\n` +
    `- Treat all photos as ONE job. If several photos show the same pile from different angles, COUNT IT ONCE and mark those observations possibleDuplicateViewOfOtherPhoto=true with a shared duplicateGroupId. Never add every visible pile together blindly.\n` +
    `- Judge fill against a 24 ft box truck (~1,200 cu ft ≈ 44 cubic yards). estimatedTruckLoadFraction is the fraction of THAT truck the whole job fills (0.05–6). Give minimum/likely/maximum — a RANGE, not false precision.\n` +
    `- Account for pile height/width/depth and perspective; if the full pile is not visible, lower confidence and add a warning. Loose non-compacting material (brush, limbs, mattresses) fills a truck faster than it looks and may need multiple dump trips.\n` +
    `- Flag dense/heavy material (concrete, dirt, roofing, soil, scrap) via detectedConditions — a small-looking pile can exceed safe weight.\n` +
    `- Note access: stairs, elevator, long carry, narrow access, indoor vs outdoor, disassembly.\n` +
    `- Hazardous materials (paint, chemicals, solvents, oil, propane/fuel, tires, batteries, asbestos, biohazard) are a POSSIBILITY flag + warning, NEVER a definitive diagnosis. Set the matching detectedConditions.*Possible=true. ${COMPANY.legalName} does not haul hazardous material.\n` +
    `- Ignore irrelevant background (people, cars not part of the job). NEVER identify faces or infer any personal trait (identity, age, race, gender, health, income).\n` +
    `- If photos are too dark/blurry/close/obstructed to judge, set imageQuality and reviewRequired=true with reasons. Ask for specific better photos in additionalQuestions.\n\n` +
    `OUTPUT: respond with ONLY one minified JSON object, no prose, no code fences, with these keys:\n` +
    `{"normalizedItems":[{"category":"furniture|appliance|electronics|yard_waste|construction_debris|household_junk|mattress|scrap_metal|cardboard|clothing|office_equipment|exercise_equipment|hot_tub|shed|unknown","label":string,"estimatedQuantity":number,"estimatedVolumeCubicYards":number,"estimatedWeightPounds":{"minimum":number,"likely":number,"maximum":number},"bulky":boolean,"heavy":boolean,"requiresDisassembly":boolean,"likelyDisposalType":"landfill|recycling|donation|special_handling|unknown","confidence":number,"evidence":string}],` +
    `"photoObservations":[{"photoUrl":string,"estimatedPhotoVolumeCubicYards":number,"accessObservations":[string],"possibleDuplicateViewOfOtherPhoto":boolean,"duplicateGroupId":string,"imageQuality":"excellent|good|limited|unusable"}],` +
    `"totalEstimatedVolumeCubicYards":{"minimum":number,"likely":number,"maximum":number},"totalEstimatedWeightPounds":{"minimum":number,"likely":number,"maximum":number},` +
    `"estimatedTruckLoadFraction":{"minimum":number,"likely":number,"maximum":number},"estimatedTruckLoads":{"minimum":number,"likely":number,"maximum":number},` +
    `"laborEstimate":{"crewSize":number,"minimumMinutes":number,"likelyMinutes":number,"maximumMinutes":number},` +
    `"detectedConditions":{"stairs":boolean,"elevator":boolean,"longCarry":boolean,"narrowAccess":boolean,"indoorRemoval":boolean,"outdoorRemoval":boolean,"disassemblyRequired":boolean,"heavyItemsPresent":boolean,"hazardousMaterialPossible":boolean,"refrigerantAppliancePossible":boolean,"concreteOrSoilPossible":boolean,"tiresPossible":boolean,"paintOrChemicalPossible":boolean},` +
    `"confidence":{"overall":number,"volume":number,"weight":number,"itemClassification":number,"accessDifficulty":number},` +
    `"additionalQuestions":[string],"warnings":[string],"reviewRequired":boolean,"reviewReasons":[string]}\n` +
    `All confidence values are 0..1. Numbers are plain (no units, no strings).`,
  prompt: '',   // images + instruction come from messages at call time
})

const REGISTRY: Record<string, PromptDef> = {
  [opsCommand.id]: opsCommand,
  [opsMessage.id]: opsMessage,
  [opsInsights.id]: opsInsights,
  [opsReviewReply.id]: opsReviewReply,
  [opsPhotoEstimate.id]: opsPhotoEstimate,
  [opsJunkAnalysis.id]: opsJunkAnalysis,
}

export function getPrompt(id: string): PromptDef {
  const p = REGISTRY[id]
  if (!p) throw new Error(`unknown prompt: ${id}`)
  return p
}

export function hasPrompt(id: string): boolean {
  return id in REGISTRY
}

export function listPrompts(): Array<Pick<PromptDef, 'id' | 'version' | 'description'>> {
  return Object.values(REGISTRY).map(({ id, version, description }) => ({ id, version, description }))
}

// The built-in (code) templates for a prompt — the seed the admin editor starts from
// and the immutable "version 1" an operator can always roll back to.
export function builtinTemplates(id: string): { system: string; prompt: string } {
  const p = getPrompt(id)
  return { system: p.system, prompt: p.prompt }
}
