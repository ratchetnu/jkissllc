// ── Example skeletal pack (DISABLED) ─────────────────────────────────────────
//
// A deliberately minimal second-vertical pack to prove the contract generalizes.
// enabledByDefault: false — it is not offered to any tenant. It is a shape
// example only, NOT a complete implementation (no tenant editor exists yet).

import type { IndustryPack } from './types'

export const CLEANING_PACK: IndustryPack = {
  id: 'cleaning-residential',
  displayName: 'Residential & Commercial Cleaning',
  description: 'Skeletal example pack for a future cleaning vertical. Disabled by default.',
  enabledByDefault: false,
  terminology: {
    jobNoun: 'Visit',
    jobNounPlural: 'Visits',
    workerNoun: 'Cleaner',
    contractorNoun: 'Contractor',
    accountNoun: 'Client',
    customerNoun: 'Customer',
    assignmentNoun: 'Shift',
  },
  supportedCapabilities: ['bookings', 'scheduling', 'workforce', 'messaging', 'invoicing', 'payments', 'customer-portal', 'crew-portal'],
  serviceTemplates: [
    { id: 'standard-clean', label: 'Standard Clean', pricingMethod: 'hourly', jobBased: true },
    { id: 'deep-clean', label: 'Deep Clean', pricingMethod: 'flat', jobBased: true },
  ],
  intakeQuestions: ['Home or office?', 'Square footage?', 'Frequency (one-time / recurring)?'],
  pricingMethods: ['hourly', 'flat'],
  jobStages: ['scheduled', 'assigned', 'in_progress', 'completed', 'cancelled'],
  evidenceRequirements: [{ id: 'before-after-photos', label: 'Before/after photos', required: false }],
  equipmentCategories: ['Supplies kit', 'Vacuum'],
  workerRequirements: ['Background check on file'],
  customerCommunications: ['booking-confirmation', 'day-before-reminder', 'completion-receipt'],
  automationTemplates: ['day-before-reminder', 'recurring-rebook'],
  aiWorkerInstructions: {},
  dashboardPriorities: ['today-visits', 'unconfirmed-shifts'],
  complianceRules: [],
}
