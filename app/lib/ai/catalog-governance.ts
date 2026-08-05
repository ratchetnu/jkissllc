import { INVENTORY_TAXONOMY } from './inventory-taxonomy'
import { OPERATIONAL_ITEM_CATALOG, type OperationalItem } from './item-catalog'

export const OPERATIONAL_CATALOG_VERSION = 1

export const MOVING_HANDLING_FLAGS = [
  'appliance', 'awkward_shape', 'container', 'fragile', 'mattress',
  'requires_disassembly', 'two_person_lift',
] as const

export const JUNK_HANDLING_FLAGS = [
  'appliance', 'bagged_material', 'compactable', 'construction_debris',
  'electronics', 'heavy', 'loose_debris', 'mattress', 'rigid',
  'sharp_edges', 'special_disposal_review',
] as const

const PRICING_KEY = /(price|cost|fee(?!t)|usd|dollar|rate|debrisCategory|disposalClass|perUnit)/i

const canonical = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function pricingKeys(value: unknown, path = 'catalog'): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(PRICING_KEY.test(key) ? [`${path}.${key}`] : []),
    ...pricingKeys(child, `${path}.${key}`),
  ])
}

/** Pure structural checks. Empty means the two governed tables still respect their ownership boundary. */
export function catalogGovernanceIssues(
  catalog: OperationalItem[] = OPERATIONAL_ITEM_CATALOG,
): string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  const aliases = new Map<string, string>()
  const movingFlags = new Set<string>(MOVING_HANDLING_FLAGS)
  const junkFlags = new Set<string>(JUNK_HANDLING_FLAGS)

  for (const entry of catalog) {
    if (ids.has(entry.id)) issues.push(`duplicate id: ${entry.id}`)
    ids.add(entry.id)

    if (!entry.volumeCubicFeet.medium) issues.push(`${entry.id}: missing medium volume range`)
    for (const [size, range] of Object.entries(entry.volumeCubicFeet)) {
      if (!range || range.minimum <= 0 || range.maximum < range.minimum) {
        issues.push(`${entry.id}: invalid ${size} volume range`)
      }
    }
    if (!Number.isInteger(entry.defaultCrew) || entry.defaultCrew < 1 || entry.defaultCrew > 6) {
      issues.push(`${entry.id}: invalid default crew`)
    }

    for (const alias of entry.aliases) {
      const key = canonical(alias)
      const owner = aliases.get(key)
      if (!key) issues.push(`${entry.id}: empty alias`)
      else if (owner) issues.push(`alias collision: ${key} (${owner}, ${entry.id})`)
      else aliases.set(key, entry.id)
    }
    for (const flag of entry.movingFlags) if (!movingFlags.has(flag)) issues.push(`${entry.id}: unknown moving flag ${flag}`)
    for (const flag of entry.junkFlags) if (!junkFlags.has(flag)) issues.push(`${entry.id}: unknown junk flag ${flag}`)

    if (entry.appliance && (!entry.movingFlags.includes('appliance') || !entry.junkFlags.includes('appliance'))) {
      issues.push(`${entry.id}: appliance identity is not carried in both lanes`)
    }
    if (entry.fragile && !entry.movingFlags.includes('fragile')) issues.push(`${entry.id}: fragile fact missing moving flag`)
    if (entry.disassemblyLikely && !entry.movingFlags.includes('requires_disassembly')) {
      issues.push(`${entry.id}: disassembly fact missing moving flag`)
    }
  }

  issues.push(...pricingKeys(catalog).map(path => `pricing-owned key in operational catalog: ${path}`))
  if (!INVENTORY_TAXONOMY.other || !INVENTORY_TAXONOMY.other.perUnitVolumeCubicYards) {
    issues.push('pricing taxonomy must retain a governed fallback')
  }
  return issues
}
