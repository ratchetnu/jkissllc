// ── Industry pack contract ───────────────────────────────────────────────────
//
// An industry pack supplies the vertical-specific DATA that lets the neutral
// platform core behave like a particular industry — terminology, service
// templates, pricing method, job stages, evidence rules, etc. Packs never contain
// platform-core business logic; they configure it. See
// docs/opspilot-os/06-industry-module-strategy.md.

import type { CapabilityId } from '../capabilities/types'
import type { WorkerId } from '../ai-workers/types'

export type PricingMethod = 'flat' | 'per-unit' | 'truck-utilization' | 'hourly' | 'custom'

export type ServiceTemplate = {
  id: string
  label: string
  pricingMethod: PricingMethod
  jobBased: boolean
}

export type EvidenceRequirement = {
  id: string
  label: string
  required: boolean
}

export type IndustryPack = {
  id: string
  displayName: string
  description: string
  enabledByDefault: boolean
  /** Vocabulary the UI/AI should use (jobNoun, workerNoun, accountNoun, …). */
  terminology: Record<string, string>
  supportedCapabilities: CapabilityId[]
  serviceTemplates: ServiceTemplate[]
  intakeQuestions: string[]
  pricingMethods: PricingMethod[]
  jobStages: string[]
  evidenceRequirements: EvidenceRequirement[]
  equipmentCategories: string[]
  workerRequirements: string[]
  customerCommunications: string[]
  automationTemplates: string[]
  aiWorkerInstructions: Partial<Record<WorkerId, string>>
  dashboardPriorities: string[]
  complianceRules: string[]
}
