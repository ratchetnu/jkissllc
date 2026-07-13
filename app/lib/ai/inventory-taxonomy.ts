// ─────────────────────────────────────────────────────────────────────────────
// Governed inventory taxonomy — the controlled vocabulary the customer confirms
// against, and the SEAM between a confirmed item and deterministic pricing.
//
// The AI vision layer speaks the coarse `JunkCategory` (analysis-schema.ts). The
// deterministic engine speaks `DebrisCategory` (disposal.ts). This module is the
// governed middle: a fixed set of customer-facing categories, each carrying the
// per-unit facts pricing needs — estimated volume (cu yd), a weight class, a
// disposal class, and any special-handling / hazard / dense-debris flags.
//
// Everything here is PURE + dependency-free (no I/O, no Date.now) so it can be
// unit-tested directly and reused by both the customer and worker paths. A
// customer NEVER sets a price — they pick a governed category + quantity, and
// THIS table (not their input) supplies the volume/weight/handling that feed
// `priceJob`. "Other" is accepted as free text but normalized into a category
// before it can influence pricing.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkCategory } from './analysis-schema'
import type { DebrisCategory } from '../disposal'

// The governed customer-facing categories (request Part 4). Ordered as shown in UI.
export type InventoryCategory =
  | 'furniture'
  | 'mattress'
  | 'appliance'
  | 'electronics'
  | 'yard_debris'
  | 'household_trash'
  | 'garage_items'
  | 'construction_debris'
  | 'flooring'
  | 'cabinets_fixtures'
  | 'tires'
  | 'exercise_equipment'
  | 'safe_dense_object'
  | 'hot_tub'
  | 'piano'
  | 'dense_material'          // dirt, concrete, brick, rock, roofing
  | 'hazardous'              // paint, chemicals, fuel, batteries, hazmat
  // ── Estate/cleanout SENSITIVE categories — never ordinary disposal; always
  // routed to owner review (Part: Estate Cleanout safeguards). ──
  | 'valuables'             // jewelry, cash, suspected valuables, collectibles
  | 'documents'             // legal papers, records, personal documents
  | 'medications'           // prescription + OTC medications
  | 'firearms'              // firearms + ammunition
  | 'personal_keepsakes'    // photos, ashes/urns, sentimental items
  | 'other'

export type WeightClass = 'light' | 'medium' | 'heavy' | 'very_heavy'
export type DisposalClass = 'landfill' | 'recycling' | 'donation' | 'special_handling' | 'hazardous'

export type TaxonomyEntry = {
  key: InventoryCategory
  label: string                     // customer-facing display label
  short: string                     // compact chip label
  // Pricing facts (governed — the customer never overrides these):
  debrisCategory: DebrisCategory    // → priceJob category
  junkCategory: JunkCategory        // ← AI vision vocabulary (for round-tripping)
  perUnitVolumeCubicYards: number   // governed default volume per unit
  weightClass: WeightClass
  disposalClass: DisposalClass
  // Risk flags — these can only ADD review/handling, never remove it:
  heavy: boolean                    // materially heavy → weight risk
  denseDebris: boolean              // concrete/soil/roofing → dump-weight risk
  hazardous: boolean                // prohibited/special disposal → always manual review
  specialHandling: boolean          // piano/hot-tub/safe → specialty crew/charge
  requiresDisassembly: boolean
  // Estate/cleanout: personal/valuable/sensitive property — NEVER auto-classified
  // as ordinary disposal; always routed to owner review before pricing.
  sensitive?: boolean
}

// One 24 ft box truck ≈ 44 cu yd (mirrors analysis-schema TRUCK_CUBIC_YARDS).
export const TRUCK_CUBIC_YARDS = 44

// The governed table. Volumes are conservative per-unit estimates in cubic yards.
export const INVENTORY_TAXONOMY: Record<InventoryCategory, TaxonomyEntry> = {
  furniture: {
    key: 'furniture', label: 'Furniture', short: 'Furniture',
    debrisCategory: 'furniture', junkCategory: 'furniture',
    perUnitVolumeCubicYards: 1.2, weightClass: 'medium', disposalClass: 'landfill',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  mattress: {
    key: 'mattress', label: 'Mattress or Box Spring', short: 'Mattress',
    debrisCategory: 'mattress', junkCategory: 'mattress',
    perUnitVolumeCubicYards: 1.0, weightClass: 'medium', disposalClass: 'recycling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  appliance: {
    key: 'appliance', label: 'Appliance', short: 'Appliance',
    debrisCategory: 'appliance', junkCategory: 'appliance',
    perUnitVolumeCubicYards: 1.0, weightClass: 'heavy', disposalClass: 'recycling',
    heavy: true, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  electronics: {
    key: 'electronics', label: 'Electronics', short: 'Electronics',
    debrisCategory: 'general', junkCategory: 'electronics',
    perUnitVolumeCubicYards: 0.3, weightClass: 'light', disposalClass: 'recycling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  yard_debris: {
    key: 'yard_debris', label: 'Yard Debris', short: 'Yard',
    debrisCategory: 'yard-waste', junkCategory: 'yard_waste',
    perUnitVolumeCubicYards: 0.8, weightClass: 'medium', disposalClass: 'recycling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  household_trash: {
    key: 'household_trash', label: 'Household Trash', short: 'Trash',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.5, weightClass: 'light', disposalClass: 'landfill',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  garage_items: {
    key: 'garage_items', label: 'Garage Items', short: 'Garage',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.6, weightClass: 'medium', disposalClass: 'landfill',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  construction_debris: {
    key: 'construction_debris', label: 'Construction Debris', short: 'Construction',
    debrisCategory: 'construction-debris', junkCategory: 'construction_debris',
    perUnitVolumeCubicYards: 1.0, weightClass: 'very_heavy', disposalClass: 'landfill',
    heavy: true, denseDebris: true, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  flooring: {
    key: 'flooring', label: 'Flooring', short: 'Flooring',
    debrisCategory: 'construction-debris', junkCategory: 'construction_debris',
    perUnitVolumeCubicYards: 0.7, weightClass: 'heavy', disposalClass: 'landfill',
    heavy: true, denseDebris: true, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
  cabinets_fixtures: {
    key: 'cabinets_fixtures', label: 'Cabinets or Fixtures', short: 'Cabinets',
    debrisCategory: 'construction-debris', junkCategory: 'construction_debris',
    perUnitVolumeCubicYards: 1.0, weightClass: 'heavy', disposalClass: 'landfill',
    heavy: true, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: true,
  },
  tires: {
    key: 'tires', label: 'Tires', short: 'Tires',
    debrisCategory: 'general', junkCategory: 'scrap_metal',
    perUnitVolumeCubicYards: 0.3, weightClass: 'medium', disposalClass: 'special_handling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: true, requiresDisassembly: false,
  },
  exercise_equipment: {
    key: 'exercise_equipment', label: 'Exercise Equipment', short: 'Exercise',
    debrisCategory: 'general', junkCategory: 'exercise_equipment',
    perUnitVolumeCubicYards: 0.9, weightClass: 'heavy', disposalClass: 'landfill',
    heavy: true, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: true,
  },
  safe_dense_object: {
    key: 'safe_dense_object', label: 'Safe or Dense Object', short: 'Safe',
    debrisCategory: 'general', junkCategory: 'scrap_metal',
    perUnitVolumeCubicYards: 0.5, weightClass: 'very_heavy', disposalClass: 'special_handling',
    heavy: true, denseDebris: true, hazardous: false, specialHandling: true, requiresDisassembly: false,
  },
  hot_tub: {
    key: 'hot_tub', label: 'Hot Tub', short: 'Hot Tub',
    debrisCategory: 'construction-debris', junkCategory: 'hot_tub',
    perUnitVolumeCubicYards: 4.0, weightClass: 'very_heavy', disposalClass: 'special_handling',
    heavy: true, denseDebris: false, hazardous: false, specialHandling: true, requiresDisassembly: true,
  },
  piano: {
    key: 'piano', label: 'Piano', short: 'Piano',
    debrisCategory: 'general', junkCategory: 'furniture',
    perUnitVolumeCubicYards: 1.5, weightClass: 'very_heavy', disposalClass: 'special_handling',
    heavy: true, denseDebris: false, hazardous: false, specialHandling: true, requiresDisassembly: false,
  },
  dense_material: {
    key: 'dense_material', label: 'Dirt, Concrete, Brick, Rock, or Roofing', short: 'Dense material',
    debrisCategory: 'construction-debris', junkCategory: 'construction_debris',
    perUnitVolumeCubicYards: 1.0, weightClass: 'very_heavy', disposalClass: 'landfill',
    heavy: true, denseDebris: true, hazardous: false, specialHandling: true, requiresDisassembly: false,
  },
  hazardous: {
    key: 'hazardous', label: 'Paint, Chemicals, Fuel, Batteries, or Hazardous Materials', short: 'Hazardous',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.2, weightClass: 'light', disposalClass: 'hazardous',
    heavy: false, denseDebris: false, hazardous: true, specialHandling: true, requiresDisassembly: false, sensitive: true,
  },
  valuables: {
    key: 'valuables', label: 'Jewelry, Cash, or Valuables', short: 'Valuables',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.1, weightClass: 'light', disposalClass: 'special_handling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: true, requiresDisassembly: false, sensitive: true,
  },
  documents: {
    key: 'documents', label: 'Legal Papers or Personal Documents', short: 'Documents',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.2, weightClass: 'light', disposalClass: 'special_handling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: true, requiresDisassembly: false, sensitive: true,
  },
  medications: {
    key: 'medications', label: 'Medications', short: 'Medications',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.1, weightClass: 'light', disposalClass: 'hazardous',
    heavy: false, denseDebris: false, hazardous: true, specialHandling: true, requiresDisassembly: false, sensitive: true,
  },
  firearms: {
    key: 'firearms', label: 'Firearms or Ammunition', short: 'Firearms',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.2, weightClass: 'medium', disposalClass: 'special_handling',
    heavy: false, denseDebris: false, hazardous: true, specialHandling: true, requiresDisassembly: false, sensitive: true,
  },
  personal_keepsakes: {
    key: 'personal_keepsakes', label: 'Photos, Ashes, or Sentimental Items', short: 'Keepsakes',
    debrisCategory: 'general', junkCategory: 'household_junk',
    perUnitVolumeCubicYards: 0.2, weightClass: 'light', disposalClass: 'special_handling',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: true, requiresDisassembly: false, sensitive: true,
  },
  other: {
    key: 'other', label: 'Other', short: 'Other',
    debrisCategory: 'general', junkCategory: 'unknown',
    perUnitVolumeCubicYards: 0.6, weightClass: 'medium', disposalClass: 'landfill',
    heavy: false, denseDebris: false, hazardous: false, specialHandling: false, requiresDisassembly: false,
  },
}

export const INVENTORY_CATEGORIES: InventoryCategory[] = Object.keys(INVENTORY_TAXONOMY) as InventoryCategory[]

export function taxonomyEntry(key: InventoryCategory): TaxonomyEntry {
  return INVENTORY_TAXONOMY[key] ?? INVENTORY_TAXONOMY.other
}

// Map the AI vision `JunkCategory` → a governed `InventoryCategory` so a detected
// item can be shown in the confirmation UI using the controlled vocabulary.
const JUNK_TO_INVENTORY: Partial<Record<JunkCategory, InventoryCategory>> = {
  furniture: 'furniture',
  appliance: 'appliance',
  electronics: 'electronics',
  yard_waste: 'yard_debris',
  construction_debris: 'construction_debris',
  household_junk: 'household_trash',
  mattress: 'mattress',
  scrap_metal: 'garage_items',
  cardboard: 'household_trash',
  clothing: 'household_trash',
  office_equipment: 'furniture',
  exercise_equipment: 'exercise_equipment',
  hot_tub: 'hot_tub',
  shed: 'construction_debris',
  unknown: 'other',
}

export function inventoryCategoryForJunk(c: JunkCategory): InventoryCategory {
  return JUNK_TO_INVENTORY[c] ?? 'other'
}

// Best-effort normalization of arbitrary/free-text input (incl. an "Other"
// description) into a governed category. Pure, forgiving, never throws. Used to
// keep a customer's free text from ever reaching pricing un-normalized (Part 4).
export function normalizeToInventoryCategory(raw: unknown, freeText?: string): InventoryCategory {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]+/g, '_').trim()
  // A concrete governed category wins — EXCEPT 'other', which defers to the free
  // text so a typed description still classifies into a real category (Part 4).
  if (s !== 'other' && (INVENTORY_CATEGORIES as string[]).includes(s)) return s as InventoryCategory
  // Accept the AI vocabulary too.
  const asJunk = JUNK_TO_INVENTORY[s as JunkCategory]
  if (asJunk && asJunk !== 'other') return asJunk
  return classifyFreeText(`${s === 'other' ? '' : s} ${freeText ?? ''}`)
}

// Keyword classifier for "Other" free text → governed category, so a typed
// description still normalizes before it can influence pricing (Part 4).
const FREE_TEXT_RULES: Array<{ re: RegExp; cat: InventoryCategory }> = [
  // Sensitive/estate categories first so they are never mis-classified as junk.
  { re: /firearm|rifle|pistol|\bammo\b|ammunition|shotgun|handgun|\bguns?\b(?!\s*(safe|cabinet))/, cat: 'firearms' },
  { re: /medication|prescription|\bpills?\b|pharmacy|medicine|opioid/, cat: 'medications' },
  { re: /ashes|urn|cremat|keepsake|sentimental|memento|family photo/, cat: 'personal_keepsakes' },
  { re: /jewelry|jewellery|\bcash\b|coin collection|collectible|valuable|antique|heirloom|gold|silver\b/, cat: 'valuables' },
  { re: /legal (paper|doc)|will\b|deed|title\b|passport|social security|tax (record|return)|birth certificate|document/, cat: 'documents' },
  { re: /paint|chemical|fuel|gasoline|propane|battery|batteries|hazard|solvent|asbestos/, cat: 'hazardous' },
  { re: /concrete|brick|rock|dirt|soil|roofing|shingle|gravel|stone|tile\b/, cat: 'dense_material' },
  { re: /hot ?tub|spa|jacuzzi/, cat: 'hot_tub' },
  { re: /piano|organ/, cat: 'piano' },
  { re: /safe\b|gun ?safe|vault/, cat: 'safe_dense_object' },
  { re: /tire|wheel/, cat: 'tires' },
  { re: /treadmill|elliptical|weight|dumbbell|exercise|gym|peloton/, cat: 'exercise_equipment' },
  { re: /cabinet|vanity|countertop|fixture|sink|toilet/, cat: 'cabinets_fixtures' },
  { re: /floor|carpet|hardwood|laminate|vinyl plank/, cat: 'flooring' },
  { re: /mattress|box ?spring|bed frame/, cat: 'mattress' },
  { re: /fridge|refrigerator|washer|dryer|dishwasher|stove|oven|freezer|appliance|hvac|water heater/, cat: 'appliance' },
  { re: /tv|television|computer|monitor|printer|electronic|stereo|speaker/, cat: 'electronics' },
  { re: /branch|leaves|brush|tree|shrub|lawn|yard|mulch|fence/, cat: 'yard_debris' },
  { re: /drywall|lumber|wood|construction|demo|debris|renovation|remodel/, cat: 'construction_debris' },
  { re: /couch|sofa|chair|table|desk|dresser|furniture|cabinet|shelf|bookcase/, cat: 'furniture' },
  { re: /garage|tool|bike|storage/, cat: 'garage_items' },
  { re: /trash|garbage|bag|box|clothes|clothing|household|junk/, cat: 'household_trash' },
]

export function classifyFreeText(text: string): InventoryCategory {
  const t = text.toLowerCase()
  for (const { re, cat } of FREE_TEXT_RULES) if (re.test(t)) return cat
  return 'other'
}
