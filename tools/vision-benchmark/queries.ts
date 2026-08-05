// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — category taxonomy and search-query generation.
//
// The taxonomy is the coverage contract: the categories here are the ones the
// coverage report measures against, so a category with no images shows up as a
// GAP rather than quietly not existing. Queries are generated from a base phrase
// crossed with modifiers, because the variation we care about (lighting, clutter,
// angle, load size, indoor/outdoor) is mostly expressed in the phrasing.
//
// Pure and deterministic — no network, no clock. The acquirer consumes this.
// ─────────────────────────────────────────────────────────────────────────────

import type { JobType } from './schema'

export type CategorySpec = {
  category: string
  jobType: JobType
  /** Base phrases; each is crossed with the modifiers below. */
  base: string[]
  /** Categories we expect to be hard to source permissively — reported, not hidden. */
  expectThin?: boolean
}

// ── Junk removal ─────────────────────────────────────────────────────────────
export const JUNK_CATEGORIES: CategorySpec[] = [
  { category: 'couch_sectional', jobType: 'junk_removal', base: ['old sofa discarded', 'couch on curb', 'sectional sofa removal'] },
  { category: 'mattress', jobType: 'junk_removal', base: ['discarded mattress', 'old mattress curb', 'box spring dumped'] },
  { category: 'major_appliance', jobType: 'junk_removal', base: ['old refrigerator discarded', 'scrap washing machine', 'broken dryer disposal', 'old oven scrap'] },
  { category: 'electronics_tv', jobType: 'junk_removal', base: ['discarded television', 'e-waste pile', 'old computer monitors scrap'] },
  { category: 'case_goods', jobType: 'junk_removal', base: ['old dresser discarded', 'broken desk removal', 'old cabinet scrap wood furniture'] },
  { category: 'garage_cleanout', jobType: 'junk_removal', base: ['cluttered garage', 'garage full of junk', 'messy garage storage'], expectThin: true },
  { category: 'storage_unit_cleanout', jobType: 'junk_removal', base: ['full storage unit', 'packed self storage unit'] },
  { category: 'apartment_cleanout', jobType: 'junk_removal', base: ['cluttered apartment room', 'abandoned apartment furniture'] },
  { category: 'eviction_cleanout', jobType: 'junk_removal', base: ['abandoned household belongings', 'evicted property belongings street'], expectThin: true },
  { category: 'office_cleanout', jobType: 'junk_removal', base: ['discarded office furniture', 'old office chairs pile'] },
  { category: 'yard_waste', jobType: 'junk_removal', base: ['garden waste pile', 'yard waste bags'] },
  { category: 'brush_limbs', jobType: 'junk_removal', base: ['tree branches pile', 'brush pile cut limbs', 'storm debris branches'] },
  { category: 'bagged_trash', jobType: 'junk_removal', base: ['garbage bags pile', 'rubbish bags street'] },
  { category: 'cardboard_packaging', jobType: 'junk_removal', base: ['flattened cardboard pile', 'cardboard boxes waste'] },
  { category: 'construction_debris', jobType: 'junk_removal', base: ['construction debris', 'demolition waste pile', 'building rubble skip'] },
  { category: 'drywall', jobType: 'junk_removal', base: ['drywall waste', 'plasterboard demolition waste'] },
  { category: 'lumber', jobType: 'junk_removal', base: ['scrap lumber pile', 'waste timber pile'] },
  { category: 'flooring', jobType: 'junk_removal', base: ['removed carpet roll waste', 'torn out flooring debris'] },
  { category: 'concrete_masonry', jobType: 'junk_removal', base: ['broken concrete pile', 'rubble bricks pile'] },
  { category: 'roofing', jobType: 'junk_removal', base: ['old roof shingles waste', 'roofing tear off debris'] },
  { category: 'scrap_metal', jobType: 'junk_removal', base: ['scrap metal pile', 'metal junk yard pile'] },
  { category: 'tires', jobType: 'junk_removal', base: ['old tires pile', 'discarded tyres'] },
  { category: 'hot_tub', jobType: 'junk_removal', base: ['old hot tub', 'discarded jacuzzi'], expectThin: true },
  { category: 'shed', jobType: 'junk_removal', base: ['dilapidated garden shed', 'old wooden shed demolition'] },
  { category: 'exercise_equipment', jobType: 'junk_removal', base: ['old treadmill discarded', 'used exercise equipment'] },
  { category: 'piano_heavy', jobType: 'junk_removal', base: ['old upright piano', 'discarded piano'], expectThin: true },
  { category: 'mixed_full_load', jobType: 'junk_removal', base: ['junk pile mixed household', 'bulky waste collection pile', 'landfill mixed household waste'] },
  { category: 'curbside_pile', jobType: 'junk_removal', base: ['bulky waste on kerb', 'furniture on sidewalk waste'] },
  { category: 'hazardous_indicators', jobType: 'junk_removal', base: ['paint cans waste', 'old propane cylinders', 'chemical drums waste'], expectThin: true },
]

// ── Moving ───────────────────────────────────────────────────────────────────
export const MOVING_CATEGORIES: CategorySpec[] = [
  { category: 'studio_inventory', jobType: 'moving', base: ['studio apartment furnished', 'small apartment room furniture'] },
  { category: 'one_bed_inventory', jobType: 'moving', base: ['one bedroom apartment furniture', 'apartment living room furnished'] },
  { category: 'two_bed_inventory', jobType: 'moving', base: ['two bedroom apartment interior furniture'] },
  { category: 'three_bed_inventory', jobType: 'moving', base: ['house interior furnished rooms'] },
  { category: 'living_room_furniture', jobType: 'moving', base: ['living room furniture sofa table', 'lounge furniture interior'] },
  { category: 'bedroom_furniture', jobType: 'moving', base: ['bedroom furniture bed wardrobe', 'bedroom interior furnished'] },
  { category: 'dining_furniture', jobType: 'moving', base: ['dining table chairs room', 'dining room furniture'] },
  { category: 'office_furniture', jobType: 'moving', base: ['office desk chairs interior', 'home office furniture'] },
  { category: 'boxed_goods', jobType: 'moving', base: ['moving boxes stacked', 'cardboard moving boxes room'] },
  { category: 'unboxed_goods', jobType: 'moving', base: ['household items packing', 'belongings on floor moving'] },
  { category: 'fragile_electronics', jobType: 'moving', base: ['flat screen television room', 'computer equipment desk'] },
  { category: 'mirrors_artwork', jobType: 'moving', base: ['framed pictures wall art', 'large mirror interior'] },
  { category: 'appliances_moving', jobType: 'moving', base: ['kitchen appliances refrigerator', 'washing machine kitchen'] },
  { category: 'bulky_furniture', jobType: 'moving', base: ['large wardrobe furniture', 'heavy furniture interior'] },
  { category: 'disassembled_furniture', jobType: 'moving', base: ['flat pack furniture parts', 'disassembled bed frame'] },
  { category: 'cluttered_room', jobType: 'moving', base: ['cluttered room belongings', 'messy room full of stuff'] },
  { category: 'staged_room', jobType: 'moving', base: ['staged living room interior', 'tidy furnished room'] },
  { category: 'storage_unit_moving', jobType: 'moving', base: ['storage unit boxes furniture'] },
  { category: 'garage_moving', jobType: 'moving', base: ['garage interior storage shelves'] },
  { category: 'stairs_access', jobType: 'moving', base: ['narrow staircase interior', 'apartment stairwell'] },
  { category: 'elevator_access', jobType: 'moving', base: ['building elevator interior', 'service lift building'] },
  { category: 'narrow_hallway', jobType: 'moving', base: ['narrow corridor apartment', 'hallway interior building'] },
  { category: 'long_carry', jobType: 'moving', base: ['long driveway house', 'apartment walkway exterior'] },
  { category: 'loading_dock', jobType: 'moving', base: ['loading dock truck', 'warehouse loading bay'] },
  { category: 'packed_truck', jobType: 'moving', base: ['moving truck loaded furniture', 'removal van packed'] },
  { category: 'partial_truck', jobType: 'moving', base: ['moving truck partially loaded', 'van interior boxes'] },
]

export const ALL_CATEGORIES = [...JUNK_CATEGORIES, ...MOVING_CATEGORIES]

/**
 * Modifiers that push the SAME subject into different visual conditions. Kept
 * short: each extra modifier multiplies the query count and the API budget.
 */
export const MODIFIERS = [
  '',                 // the bare phrase — usually the highest-quality matches
  'cluttered',
  'outdoor',
  'indoor',
  'old used',
  'wide angle',
]

export type GeneratedQuery = {
  jobType: JobType
  category: string
  query: string
  expectThin: boolean
}

/** Cross every base phrase with every modifier. Deterministic order. */
export function generateQueries(specs: CategorySpec[] = ALL_CATEGORIES): GeneratedQuery[] {
  const out: GeneratedQuery[] = []
  for (const spec of specs) {
    for (const base of spec.base) {
      for (const mod of MODIFIERS) {
        out.push({
          jobType: spec.jobType,
          category: spec.category,
          query: mod ? `${base} ${mod}` : base,
          expectThin: !!spec.expectThin,
        })
      }
    }
  }
  return out
}

/** The per-category target for the pilot, so no single category dominates. */
export const PILOT_TARGET_PER_CATEGORY = 4
