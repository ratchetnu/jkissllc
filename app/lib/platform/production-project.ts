import type { PlatformBusiness } from './updates/types'

/**
 * Resolve the Vercel project used by Production operations.
 *
 * `deployProject` is the legacy Production field. Preview is intentionally not a
 * fallback: a missing Production mapping must stop safely instead of targeting a
 * Preview project.
 */
export function productionProjectFor(
  business: Pick<PlatformBusiness, 'productionProjectId' | 'deployProject'> | null | undefined,
): string | undefined {
  return business?.productionProjectId || business?.deployProject || undefined
}
