import { getPack } from './platform/industry-packs/registry'
import type { PricingMethod, ServiceTemplate } from './platform/industry-packs/types'

// ── Intake configuration (the universal-engine plug point) ───────────────────
//
// The governed Book Now workflow is vertical-neutral: the workflow, events,
// approvals, and timeline are identical for every industry. What changes per
// vertical is DATA — the services offered, the questions asked, the pricing
// method. That data lives in an industry pack; this resolver hands the intake
// surface the pack's config so a new vertical (moving, appliance, landscaping…)
// is a new pack file, not a forked wizard. Junk removal is the reference pack.

export const DEFAULT_PACK_ID = 'jkiss-field-service'

export type IntakeConfig = {
  packId: string
  displayName: string
  terminology: Record<string, string>
  serviceTemplates: ServiceTemplate[]
  intakeQuestions: string[]
  pricingMethods: PricingMethod[]
  jobStages: string[]
}

/**
 * Resolve the intake config for a tenant's industry pack. Falls back to the
 * reference pack when the id is unknown (getPack throws on unknown ids), so the
 * intake surface always has a valid vertical to render.
 */
export function resolveIntakeConfig(packId: string = DEFAULT_PACK_ID): IntakeConfig {
  let pack
  try { pack = getPack(packId) } catch { pack = getPack(DEFAULT_PACK_ID) }
  return {
    packId: pack.id,
    displayName: pack.displayName,
    terminology: pack.terminology,
    serviceTemplates: pack.serviceTemplates,
    intakeQuestions: pack.intakeQuestions,
    pricingMethods: pack.pricingMethods,
    jobStages: pack.jobStages,
  }
}
