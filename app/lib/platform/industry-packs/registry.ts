// ── Industry pack registry ───────────────────────────────────────────────────

import { isEnabled } from '../flags'
import type { IndustryPack } from './types'
import { JKISS_PACK } from './jkiss'
import { CLEANING_PACK } from './example-cleaning'

const LIST: IndustryPack[] = [JKISS_PACK, CLEANING_PACK]

export const INDUSTRY_PACK_REGISTRY: Record<string, IndustryPack> = Object.freeze(
  LIST.reduce((acc, p) => { acc[p.id] = p; return acc }, {} as Record<string, IndustryPack>),
)

export function getPack(id: string): IndustryPack {
  const p = INDUSTRY_PACK_REGISTRY[id]
  if (!p) throw new Error(`unknown industry pack: ${id}`)
  return p
}

export function allPacks(): IndustryPack[] {
  return Object.values(INDUSTRY_PACK_REGISTRY)
}

/**
 * Packs available to offer. Gated by INDUSTRY_PACKS_ENABLED: when off, only the
 * default-on pack (J KISS) is available — preserving today's single-vertical
 * behavior. When on, every pack marked enabledByDefault is offered.
 */
export function availablePacks(): IndustryPack[] {
  if (!isEnabled('INDUSTRY_PACKS_ENABLED')) return LIST.filter((p) => p.enabledByDefault)
  return LIST.filter((p) => p.enabledByDefault)
}

export { JKISS_PACK, CLEANING_PACK }
export * from './types'
export { resolveConfig, CONFIG_PRECEDENCE } from './config'
