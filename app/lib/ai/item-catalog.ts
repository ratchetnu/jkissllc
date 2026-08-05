export type CatalogSize = 'small' | 'medium' | 'large' | 'oversized'
export type WeightClass = 'light' | 'moderate' | 'heavy' | 'very_heavy'
export type VolumeRange = { minimum: number; maximum: number }

export type OperationalItem = {
  id: string
  aliases: string[]
  volumeCubicFeet: Partial<Record<CatalogSize, VolumeRange>>
  weightClass: WeightClass
  defaultCrew: number
  fragile?: boolean
  appliance?: boolean
  bulky?: boolean
  disassemblyLikely?: boolean
  movingFlags: string[]
  junkFlags: string[]
}

const item = (
  id: string, aliases: string[], medium: [number, number],
  options: Partial<Omit<OperationalItem, 'id' | 'aliases' | 'volumeCubicFeet' | 'movingFlags' | 'junkFlags'>> &
    { small?: [number, number]; large?: [number, number]; oversized?: [number, number]; moving?: string[]; junk?: string[] } = {},
): OperationalItem => ({
  id, aliases: [id.replaceAll('_', ' '), ...aliases],
  volumeCubicFeet: {
    medium: { minimum: medium[0], maximum: medium[1] },
    ...(options.small ? { small: { minimum: options.small[0], maximum: options.small[1] } } : {}),
    ...(options.large ? { large: { minimum: options.large[0], maximum: options.large[1] } } : {}),
    ...(options.oversized ? { oversized: { minimum: options.oversized[0], maximum: options.oversized[1] } } : {}),
  },
  weightClass: options.weightClass ?? 'moderate', defaultCrew: options.defaultCrew ?? 2,
  fragile: options.fragile, appliance: options.appliance, bulky: options.bulky,
  disassemblyLikely: options.disassemblyLikely,
  movingFlags: options.moving ?? [], junkFlags: options.junk ?? [],
})

/** Operational facts only. Customer/tenant pricing is deliberately impossible to represent here. */
export const OPERATIONAL_ITEM_CATALOG: OperationalItem[] = [
  item('loveseat', ['two seat sofa'], [45, 65], { large: [55, 75], moving: ['two_person_lift'], junk: ['rigid'] }),
  item('standard_sofa', ['sofa', 'couch', 'three seat sofa'], [65, 90], { large: [80, 110], bulky: true, moving: ['two_person_lift'], junk: ['rigid'] }),
  item('sectional', ['sectional sofa', 'l shaped couch'], [100, 160], { large: [130, 210], oversized: [180, 280], bulky: true, disassemblyLikely: true, moving: ['two_person_lift', 'requires_disassembly'], junk: ['rigid'] }),
  item('recliner', ['reclining chair'], [35, 55], { weightClass: 'heavy', moving: ['two_person_lift'], junk: ['rigid'] }),
  item('twin_mattress', ['single mattress'], [22, 32], { weightClass: 'moderate', moving: ['mattress'], junk: ['mattress'] }),
  item('full_mattress', ['double mattress'], [28, 40], { weightClass: 'moderate', moving: ['mattress'], junk: ['mattress'] }),
  item('queen_mattress', ['queen bed mattress'], [34, 48], { weightClass: 'heavy', moving: ['mattress', 'two_person_lift'], junk: ['mattress'] }),
  item('king_mattress', ['king bed mattress'], [42, 60], { weightClass: 'heavy', moving: ['mattress', 'two_person_lift'], junk: ['mattress'] }),
  item('box_spring', ['bed foundation'], [25, 45], { moving: ['mattress'], junk: ['mattress'] }),
  item('dresser', ['chest of drawers'], [28, 55], { large: [45, 75], weightClass: 'heavy', moving: ['two_person_lift'], junk: ['rigid'] }),
  item('nightstand', ['bedside table'], [8, 16], { small: [5, 10], moving: [], junk: ['rigid'] }),
  item('dining_table', ['kitchen table'], [25, 55], { large: [45, 80], disassemblyLikely: true, moving: ['requires_disassembly'], junk: ['rigid'] }),
  item('dining_chair', ['kitchen chair'], [7, 12], { small: [5, 8], moving: [], junk: ['rigid'] }),
  item('desk', ['office desk', 'writing desk'], [25, 55], { large: [45, 80], disassemblyLikely: true, moving: ['requires_disassembly'], junk: ['rigid'] }),
  item('office_chair', ['desk chair'], [12, 22], { moving: [], junk: ['rigid'] }),
  item('bookcase', ['bookshelf', 'shelving unit'], [20, 45], { large: [35, 70], moving: ['two_person_lift'], junk: ['rigid'] }),
  item('refrigerator', ['fridge'], [45, 75], { large: [60, 95], weightClass: 'very_heavy', defaultCrew: 2, appliance: true, bulky: true, moving: ['two_person_lift', 'appliance'], junk: ['appliance', 'special_disposal_review'] }),
  item('washer', ['washing machine'], [22, 32], { weightClass: 'very_heavy', appliance: true, moving: ['two_person_lift', 'appliance'], junk: ['appliance'] }),
  item('dryer', ['clothes dryer'], [22, 32], { weightClass: 'heavy', appliance: true, moving: ['two_person_lift', 'appliance'], junk: ['appliance'] }),
  item('stove', ['range', 'oven range'], [28, 42], { weightClass: 'very_heavy', appliance: true, moving: ['two_person_lift', 'appliance'], junk: ['appliance'] }),
  item('dishwasher', ['dish washing machine'], [18, 26], { weightClass: 'heavy', appliance: true, moving: ['appliance'], junk: ['appliance'] }),
  item('television', ['tv', 'flat screen'], [6, 18], { small: [3, 8], large: [12, 28], oversized: [22, 45], fragile: true, moving: ['fragile'], junk: ['electronics'] }),
  item('treadmill', ['running machine'], [35, 70], { large: [55, 90], weightClass: 'very_heavy', disassemblyLikely: true, moving: ['two_person_lift', 'requires_disassembly'], junk: ['heavy'] }),
  item('exercise_bike', ['stationary bike'], [20, 35], { weightClass: 'heavy', moving: ['two_person_lift'], junk: ['heavy'] }),
  item('moving_box', ['cardboard box', 'packing box'], [3, 6], { small: [1.5, 3], large: [5, 8], moving: ['container'], junk: ['compactable'] }),
  item('trash_bag', ['garbage bag', 'bin bag'], [2, 5], { small: [1, 3], weightClass: 'light', moving: [], junk: ['bagged_material', 'compactable'] }),
  item('yard_waste_bundle', ['brush bundle', 'branch pile', 'branches'], [8, 18], { large: [15, 30], weightClass: 'moderate', moving: [], junk: ['loose_debris'] }),
  item('drywall_bag', ['construction debris bag'], [1, 3], { weightClass: 'very_heavy', moving: [], junk: ['heavy', 'construction_debris'] }),
  item('lumber_bundle', ['wood bundle', 'boards'], [6, 16], { large: [12, 28], weightClass: 'heavy', moving: ['awkward_shape'], junk: ['sharp_edges'] }),
]

const clean = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const IRREGULAR_SINGULARS: Record<string, string> = { bookshelves: 'bookshelf', houses: 'house' }

const singular = (token: string): string => {
  if (IRREGULAR_SINGULARS[token]) return IRREGULAR_SINGULARS[token]
  if (/(ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2)
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

const tokenMatches = (token: string, aliasToken: string): boolean => singular(token) === singular(aliasToken)

/**
 * The set of labels an alias can match, reduced to one comparable string.
 *
 * Two aliases with this same key are interchangeable to the matcher even when
 * they are different strings — `couch` and `couches` both claim every "couches"
 * label. Governance MUST compare aliases by this key rather than by raw text,
 * or a new alias can silently take ownership of an existing one: the resolver
 * ranks by alias length, so the longer spelling wins the tie.
 */
export const aliasMatchKey = (alias: string): string =>
  clean(alias).split(' ').map(singular).join(' ')

const containsAlias = (label: string, alias: string): boolean => {
  const labelTokens = label.split(' ')
  const aliasTokens = alias.split(' ')
  if (aliasTokens.length > labelTokens.length) return false
  const start = labelTokens.length - aliasTokens.length
  return aliasTokens.every((aliasToken, offset) =>
    tokenMatches(labelTokens[start + offset] ?? '', aliasToken),
  )
}

const APPLIANCE_MODIFIERS = new Set([
  'apartment', 'bar', 'beverage', 'compact', 'dorm', 'mini', 'portable', 'undercounter', 'wine',
])

const hasUnsupportedApplianceModifier = (label: string): boolean => {
  const tokens = label.replace('under counter', 'undercounter').split(' ')
  return tokens.some(token => APPLIANCE_MODIFIERS.has(token))
}

export function resolveCatalogItem(label: string): OperationalItem | null {
  const needle = clean(label)
  if (!needle) return null
  const matches = OPERATIONAL_ITEM_CATALOG.flatMap(entry => entry.aliases.map(alias => ({ entry, alias: clean(alias) })))
    .filter(match => containsAlias(needle, match.alias))
    .filter(match => !(match.entry.appliance && hasUnsupportedApplianceModifier(needle)))
    .sort((a, b) => b.alias.length - a.alias.length)
  return matches[0]?.entry ?? null
}

export function catalogVolume(entry: OperationalItem, size: CatalogSize = 'medium'): VolumeRange | null {
  return entry.volumeCubicFeet[size] ?? null
}

export function catalogMatch(label: string, size: CatalogSize, modelCubicFeet: number) {
  const entry = resolveCatalogItem(label)
  if (!entry) return { entry: null, volume: null, agreement: 0.45 }
  const volume = catalogVolume(entry, size)
  if (!volume) return { entry, volume: null, agreement: null }
  const agreement = modelCubicFeet <= 0 ? 0.7
    : modelCubicFeet >= volume.minimum * 0.6 && modelCubicFeet <= volume.maximum * 1.5 ? 1 : 0.55
  return { entry, volume, agreement }
}
