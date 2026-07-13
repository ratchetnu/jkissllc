// ── Business event catalog ───────────────────────────────────────────────────
//
// The versioned registry of every business event: its current schema version,
// the entity it concerns, and the payload keys it must carry. Runtime validation
// (envelope.ts) consults this so an unknown type or unsupported version is
// rejected rather than silently accepted.

import type { BusinessEventType } from './types'

export type EventDef = {
  type: BusinessEventType
  version: number
  entityType: string
  requiredPayload: string[]
}

function ev(type: BusinessEventType, entityType: string, requiredPayload: string[] = []): EventDef {
  return { type, version: 1, entityType, requiredPayload }
}

const DEFS: EventDef[] = [
  ev('LeadCreated', 'lead', ['source']),
  ev('QuoteRequested', 'quote'),
  ev('QuoteGenerated', 'quote', ['amountCents']),
  ev('QuoteSent', 'quote'),
  ev('QuoteViewed', 'quote'),
  ev('QuoteAccepted', 'quote'),
  ev('DepositPaid', 'booking', ['amountCents']),
  ev('BookingCreated', 'booking'),
  ev('JobScheduled', 'job', ['scheduledFor']),
  ev('CrewAssigned', 'route', ['staffId']),
  ev('AssignmentSent', 'route', ['staffId']),
  ev('AssignmentAccepted', 'route', ['staffId']),
  ev('AssignmentDeclined', 'route', ['staffId']),
  ev('AvailabilitySubmitted', 'availability', ['staffId']),
  ev('TimeOffRequested', 'timeoff', ['staffId']),
  ev('TimeOffApproved', 'timeoff', ['staffId']),
  ev('WorkerClockedIn', 'route', ['staffId']),
  ev('CompliancePhotoSubmitted', 'route', ['staffId']),
  ev('EquipmentAssigned', 'route', ['equipmentId']),
  ev('JobStarted', 'job'),
  ev('JobDelayed', 'job', ['reason']),
  ev('ChangeOrderCreated', 'changeorder', ['deltaCents']),
  ev('ChangeOrderApproved', 'changeorder'),
  ev('JobCompleted', 'job'),
  ev('InvoiceIssued', 'invoice', ['amountCents']),
  ev('PaymentReceived', 'payment', ['amountCents']),
  ev('ReviewRequested', 'booking'),
  ev('ExpenseRecorded', 'expense', ['amountCents']),
  ev('ProfitabilityThresholdBreached', 'report', ['period']),
  ev('VehicleMaintenanceDue', 'equipment', ['equipmentId']),
  ev('AIRecommendationCreated', 'ai_recommendation', ['workerId']),
  ev('AIActionDrafted', 'ai_action', ['workerId']),
  ev('AIActionApprovalRequested', 'approval', ['approvalId']),
  ev('AIActionApproved', 'approval', ['approvalId']),
  ev('AIActionRejected', 'approval', ['approvalId']),
  ev('AIActionExecuted', 'ai_action', ['workerId']),
  ev('AIActionFailed', 'ai_action', ['workerId', 'error']),
]

export const EVENT_CATALOG: Record<BusinessEventType, EventDef> = Object.freeze(
  DEFS.reduce((acc, d) => { acc[d.type] = d; return acc }, {} as Record<BusinessEventType, EventDef>),
)

export function isKnownEvent(type: string): type is BusinessEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_CATALOG, type)
}

export function currentVersion(type: BusinessEventType): number {
  return EVENT_CATALOG[type].version
}
