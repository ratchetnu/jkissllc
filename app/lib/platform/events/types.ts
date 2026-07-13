// ── Business event types ─────────────────────────────────────────────────────
//
// The typed envelope every business event carries. tenantId is MANDATORY — an
// event without a tenant is invalid (validated at runtime). Correlation/causation
// let a chain of events be reconstructed for audit. No message broker: events are
// delivered via an in-process outbox (outbox.ts). See
// docs/opspilot-os/08-event-and-workflow-architecture.md.

export type BusinessEventType =
  | 'LeadCreated'
  | 'QuoteRequested' | 'QuoteGenerated' | 'QuoteSent' | 'QuoteViewed' | 'QuoteAccepted'
  | 'DepositPaid'
  | 'BookingCreated'
  | 'JobScheduled'
  | 'CrewAssigned' | 'AssignmentSent' | 'AssignmentAccepted' | 'AssignmentDeclined'
  | 'AvailabilitySubmitted'
  | 'TimeOffRequested' | 'TimeOffApproved'
  | 'WorkerClockedIn'
  | 'CompliancePhotoSubmitted'
  | 'EquipmentAssigned'
  | 'JobStarted' | 'JobDelayed'
  | 'ChangeOrderCreated' | 'ChangeOrderApproved'
  | 'JobCompleted'
  | 'InvoiceIssued'
  | 'PaymentReceived'
  | 'ReviewRequested'
  | 'ExpenseRecorded'
  | 'ProfitabilityThresholdBreached'
  | 'VehicleMaintenanceDue'
  | 'AIRecommendationCreated'
  | 'AIActionDrafted' | 'AIActionApprovalRequested' | 'AIActionApproved'
  | 'AIActionRejected' | 'AIActionExecuted' | 'AIActionFailed'

export type EventActor = {
  type: 'user' | 'system' | 'ai'
  id: string // userId, 'system', or 'ai:<workerId>'
  role?: string
}

export type EventEnvelope<T = Record<string, unknown>> = {
  eventId: string
  eventType: BusinessEventType
  eventVersion: number
  occurredAt: number
  tenantId: string
  actor: EventActor
  correlationId: string
  causationId?: string
  entityType: string
  entityId: string
  idempotencyKey: string
  payload: T
  metadata: Record<string, unknown>
  schemaVersion: number
}
