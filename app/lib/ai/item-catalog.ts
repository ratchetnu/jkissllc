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
  // Bare `box` is safe now that matching is head-anchored: `box spring` heads on
  // `spring`, so it keeps its own entry, and `tool box`/`box truck` head elsewhere.
  item('moving_box', ['cardboard box', 'packing box', 'box'], [3, 6], { small: [1.5, 3], large: [5, 8], moving: ['container'], junk: ['compactable'] }),
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

/**
 * Locational/relational prepositions. Everything after the first one is CONTEXT
 * describing where the item sits, not the item itself.
 *
 * The benchmark proved why this matters: "Apple laptop/keyboard on desk" matched
 * `desk`, and "Stereo/AV receiver or CD player on dresser" matched `dresser`,
 * because the resolver anchored on the final token and a supporting surface is
 * always the final token. A location noun then carried real handling facts —
 * two-person lift, disassembly — onto an object that is not that item at all.
 */
const LOCATIONAL_PREPOSITIONS = new Set([
  'on', 'in', 'under', 'underneath', 'beside', 'behind', 'near', 'against',
  'atop', 'inside', 'above', 'below', 'by', 'alongside',
])
/**
 * Multi-word prepositions, rewritten to a single-word equivalent that is already
 * in the set above. Applied AFTER clean(), so punctuation ("next-to") is already
 * normalised to spaces and the rewrite cannot be undone by later normalisation.
 */
const PREPOSITION_PHRASES: Array<[RegExp, string]> = [
  [/\bnext to\b/g, ' beside '], [/\bon top of\b/g, ' on '], [/\bin front of\b/g, ' near '],
]

/**
 * Descriptors modify a noun without ever BEING the noun. Deliberately a closed
 * vocabulary: an open one would let unrelated terms collapse into each other,
 * which is the failure mode this matcher exists to avoid.
 */
const DESCRIPTORS = new Set([
  // size / proportion
  'small', 'medium', 'large', 'oversized', 'tall', 'short', 'big', 'huge', 'compact',
  'standard', 'xl', 'mini', 'wide', 'narrow', 'low', 'high', 'deep',
  // bed sizing
  'twin', 'single', 'full', 'double', 'queen', 'king',
  // measurement units left behind after punctuation is normalised ("6-drawer" → "6 drawer")
  'drawer', 'seat', 'seater', 'inch', 'inches', 'ft', 'foot', 'feet', 'cm', 'piece', 'pc',
  'door', 'tier', 'shelf', 'panel', 'burner',
])
/** Grammatical glue that is never a head noun. */
const STOPWORDS = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'with', 'w', 'plus'])

const isDescriptor = (token: string): boolean =>
  DESCRIPTORS.has(token) || DESCRIPTORS.has(singular(token)) || /^\d+$/.test(token)

/**
 * The subject of a label: the tokens before any locational preposition.
 * "boxes on shelf" → ["box"]; "mattress against wall" → ["mattress"].
 */
const subjectTokens = (label: string): string[] => {
  let text = clean(label)
  for (const [re, to] of PREPOSITION_PHRASES) text = text.replace(re, to)
  const tokens = text.split(' ').filter(Boolean)
  const cut = tokens.findIndex(t => LOCATIONAL_PREPOSITIONS.has(t))
  return (cut === -1 ? tokens : tokens.slice(0, cut)).map(singular)
}

/**
 * The head noun: the last token that is neither a descriptor nor glue. This is
 * what makes word order stop mattering — "sofa large" and "large sofa" share the
 * head `sofa` — while still refusing "tv stand", whose head is `stand`.
 */
const headNoun = (tokens: string[]): string | null => {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (!isDescriptor(t) && !STOPWORDS.has(t)) return t
  }
  return null
}

/**
 * An alias claims a label when they share a head noun AND every alias token is
 * present in the label's subject. Order-free by design, head-anchored for safety.
 */
const aliasClaims = (subject: string[], aliasTokens: string[]): boolean => {
  const aHead = headNoun(aliasTokens)
  const sHead = headNoun(subject)
  if (!aHead || !sHead || aHead !== sHead) return false
  const pool = new Set(subject)
  return aliasTokens.every(t => STOPWORDS.has(t) || pool.has(t))
}

/**
 * The set of labels an alias can match, reduced to one comparable string.
 *
 * Two aliases with this key are interchangeable to the matcher even when they
 * are different strings — `couch`/`couches`, and now `queen mattress`/`mattress
 * queen`, since matching is order-free. Governance MUST compare by this key, or
 * an alias that merely looks new can silently take ownership of an existing one.
 */
export const aliasMatchKey = (alias: string): string => {
  const tokens = clean(alias).split(' ').filter(Boolean).map(singular)
  const head = headNoun(tokens) ?? ''
  return `${head}|${[...tokens].sort().join(' ')}`
}

const APPLIANCE_MODIFIERS = new Set([
  'apartment', 'bar', 'beverage', 'compact', 'dorm', 'mini', 'portable', 'undercounter', 'wine',
])

const hasUnsupportedApplianceModifier = (label: string): boolean => {
  const tokens = label.replace('under counter', 'undercounter').split(' ')
  return tokens.some(token => APPLIANCE_MODIFIERS.has(token))
}

/** Best single entry for one already-tokenised subject phrase, or null. */
function bestEntry(subject: string[], needle: string): OperationalItem | null {
  const matches = OPERATIONAL_ITEM_CATALOG
    .flatMap(entry => entry.aliases.map(alias => ({ entry, tokens: clean(alias).split(' ').filter(Boolean).map(singular) })))
    .filter(match => aliasClaims(subject, match.tokens))
    .filter(match => !(match.entry.appliance && hasUnsupportedApplianceModifier(needle)))
    .sort((a, b) => b.tokens.length - a.tokens.length || b.tokens.join(' ').length - a.tokens.join(' ').length)
  return matches[0]?.entry ?? null
}

export function resolveCatalogItem(label: string): OperationalItem | null {
  const needle = clean(label)
  if (!needle) return null
  const subject = subjectTokens(label)
  if (subject.length === 0) return null

  // "desk or dresser" names two different governed items. Guessing one attaches
  // that one's handling facts — disassembly vs two-person-lift — to an object we
  // cannot identify. An ambiguous phrase is safer unmatched than half-right.
  if (subject.includes('or')) {
    const alternatives = subject.reduce<string[][]>((acc, t) => {
      if (t === 'or') acc.push([])
      else acc[acc.length - 1].push(t)
      return acc
    }, [[]]).filter(seg => seg.length > 0)
    const resolved = new Set(
      alternatives.map(seg => bestEntry(seg, needle)?.id).filter((id): id is string => !!id),
    )
    if (resolved.size > 1) return null
  }
  // Ranking happens in bestEntry(): the most specific alias wins — more matched
  // tokens first, then the longer spelling. A location noun can no longer outrank
  // the subject at all, because aliasClaims() never lets it become a candidate.
  return bestEntry(subject, needle)
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
