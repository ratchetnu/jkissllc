// ── Deterministic specialty-item taxonomy (PURE) ─────────────────────────────
//
// A curated list of item TYPES that genuinely warrant a manual handling check —
// refrigerant appliances, pianos/organs, safes, hot tubs, heavy game/exercise
// equipment, vehicles, etc. This exists so the confidence gate NEVER mistakes a
// generic operational note (a UnifiedObject.specialHandling like "2-person lift",
// "disassembly", "e-waste", or "confirm with customer") for a piano-level specialty.
//
// The vision model over-populates specialHandling/specialtyItems with routine handling
// guidance; matching those blindly forced 100% of ordinary jobs (desks, boxes, sofas,
// brush) into manual review. Instead we match ONLY these concrete item keywords against
// the model's structured description/category (and its explicit specialtyItems text),
// using WORD BOUNDARIES so e.g. "closet organizer" does not match "organ".

export const SPECIALTY_KEYWORDS: string[] = [
  // Refrigerant / gas appliances (certified handling / refrigerant recovery)
  'refrigerator', 'fridge', 'freezer', 'mini fridge', 'air conditioner', 'ac unit',
  'window unit', 'wine cooler', 'wine fridge', 'kegerator', 'dehumidifier', 'water heater', 'furnace',
  // Musical (heavy, awkward)
  'piano', 'organ',
  // Secure / very heavy
  'gun safe', 'floor safe', 'fireproof safe', 'wall safe', 'gun cabinet',
  // Water / spa
  'hot tub', 'jacuzzi', 'spa', 'sauna',
  // Game tables needing specialized disassembly (slate pool tables etc.)
  'pool table', 'billiard',
  // Aquatic (large glass + water)
  'aquarium', 'fish tank',
  // Titled vehicles / large outdoor power (fluids, titles, weight)
  'riding mower', 'lawn tractor', 'atv', 'motorcycle', 'jet ski', 'boat', 'snowmobile',
]
// NOTE deliberately EXCLUDED: treadmills, home gyms, dressers, sofas, game consoles,
// arcade/pinball, etc. Those are merely heavy/bulky (a labor SURCHARGE, priced inline) —
// not certified/specialized handling. Including them forced ordinary garage cleanouts to
// manual review. Specialty here means "a human should confirm handling", not "it's heavy".

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Precompiled word-boundary matchers, index-aligned to SPECIALTY_KEYWORDS.
const SPECIALTY_RE: RegExp[] = SPECIALTY_KEYWORDS.map((kw) => new RegExp(`\\b${escape(kw)}\\b`, 'i'))

/** The specialty keyword present in `text` (whole-word), or null. */
export function matchSpecialty(text: string | undefined | null): string | null {
  if (!text || typeof text !== 'string') return null
  for (let i = 0; i < SPECIALTY_RE.length; i++) if (SPECIALTY_RE[i].test(text)) return SPECIALTY_KEYWORDS[i]
  return null
}

/** Scan a job's structured item descriptions/categories + explicit specialty items for a
 *  TRUE specialty. Returns the first matched keyword, or null (no specialty ⇒ no forced review). */
export function detectSpecialty(inputs: {
  descriptions?: (string | undefined | null)[]
  categories?: (string | undefined | null)[]
  specialtyItems?: (string | undefined | null)[]
}): string | null {
  const hay = [...(inputs.descriptions ?? []), ...(inputs.categories ?? []), ...(inputs.specialtyItems ?? [])]
  for (const s of hay) { const m = matchSpecialty(s); if (m) return m }
  return null
}
