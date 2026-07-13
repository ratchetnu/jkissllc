// ── J KISS field-service pack (the reference pack) ───────────────────────────
//
// Extracts today's J KISS assumptions into pack DATA, preserving current
// terminology and workflow. Binding tenant `jkiss` to this pack must reproduce
// today's behavior (the pack's acceptance test in a later phase). Covers appliance
// delivery, final-mile, box-truck ops, hauling, moving, junk removal & cleanouts.

import type { IndustryPack } from './types'

export const JKISS_PACK: IndustryPack = {
  id: 'jkiss-field-service',
  displayName: 'Box-Truck Delivery, Hauling & Moving',
  description: 'Appliance/final-mile delivery, box-truck operations, hauling, moving, junk removal and cleanouts — the J KISS reference vertical.',
  enabledByDefault: true,
  terminology: {
    // Preserves the CURRENT product vocabulary (see 11-ux-and-design-system.md).
    jobNoun: 'Route',
    jobNounPlural: 'Operations',
    workerNoun: 'Crew',
    contractorNoun: 'Contractor',
    accountNoun: 'Business',
    customerNoun: 'Customer',
    assignmentNoun: 'Assignment',
  },
  supportedCapabilities: [
    'bookings', 'routes', 'jobs', 'scheduling', 'pricing', 'quotes', 'leads',
    'workforce', 'availability', 'time-off', 'time-tracking', 'gps-verification',
    'compliance-photos', 'equipment', 'fleet', 'messaging', 'notifications',
    'documents', 'invoicing', 'payments', 'contractor-compensation', 'reporting',
    'analytics', 'automations', 'ai-intelligence', 'audit-logs',
    'customer-portal', 'crew-portal', 'management-workspace',
  ],
  serviceTemplates: [
    { id: 'appliance-delivery', label: 'Appliance / Final-Mile Delivery', pricingMethod: 'flat', jobBased: false },
    { id: 'box-truck-delivery', label: 'Box-Truck Delivery', pricingMethod: 'flat', jobBased: false },
    { id: 'junk-removal', label: 'Junk Removal / Cleanout', pricingMethod: 'truck-utilization', jobBased: true },
    { id: 'hauling', label: 'Hauling', pricingMethod: 'truck-utilization', jobBased: true },
    { id: 'moving', label: 'Moving', pricingMethod: 'hourly', jobBased: true },
  ],
  intakeQuestions: [
    'What are you moving or hauling?',
    'Pickup and drop-off addresses?',
    'Approximate volume (truck fill) or item list?',
    'Any stairs, long carries, or access constraints?',
    'Preferred date and time window?',
  ],
  pricingMethods: ['flat', 'truck-utilization', 'hourly'],
  // Mirrors the current RouteStatus lifecycle.
  jobStages: ['scheduled', 'assigned', 'confirmed', 'en_route', 'in_progress', 'completed', 'no_show', 'cancelled'],
  evidenceRequirements: [
    { id: 'uniform-photo', label: 'Daily uniform photo', required: true },
    { id: 'completion-photos', label: 'Job completion photos', required: true },
    { id: 'clock-gps', label: 'Clock-in/out location', required: false },
  ],
  equipmentCategories: ['Box truck', 'Trailer', 'Dolly / hand truck', 'Straps & pads'],
  workerRequirements: [
    'Able to safely operate a 26′ box truck',
    'Able to lift and carry heavy items',
    'Valid driver license (drivers)',
  ],
  customerCommunications: ['booking-confirmation', 'day-before-reminder', 'en-route', 'completion-receipt', 'review-request'],
  automationTemplates: ['day-before-reminder', 'abandoned-booking-recovery', 'payment-reminder', 'post-job-review'],
  aiWorkerInstructions: {
    'ai-dispatcher': 'Prioritize on-time confirmation and driver+helper coverage for box-truck routes.',
    'ai-sales': 'Quote junk/hauling by truck utilization; delivery by flat rate; never auto-apply a price.',
  },
  dashboardPriorities: ['today-routes', 'unconfirmed-assignments', 'aging-invoices', 'crew-coverage'],
  complianceRules: ['USDOT/MC identifiers on customer docs', 'contractor confirmation disclaimer on accept'],
}
