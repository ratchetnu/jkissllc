// Canonical communication event model (Phase 2).
//
// This is the ONE list of things the business communicates about. It is pure
// data + types — no Redis, no providers, no business schema — so the event model
// can be reasoned about, previewed, and tested in isolation, and so a future
// Operations schema can drive it through the `CommContext` adapter (context.ts)
// without this file ever importing that schema.
//
// Every event maps to copy in templates.ts and is dispatched by service.ts.

export type CommEvent =
  | 'BOOKING_RECEIVED'
  | 'QUOTE_SENT'
  | 'QUOTE_REMINDER'
  | 'BOOKING_CONFIRMED'
  | 'APPOINTMENT_REMINDER'
  | 'CREW_DISPATCHED'
  | 'ON_THE_WAY'
  | 'ETA_UPDATED'
  | 'ARRIVED'
  | 'JOB_COMPLETED'
  | 'INVOICE_SENT'
  | 'INVOICE_REMINDER'
  | 'PAYMENT_RECEIVED'
  | 'REVIEW_REQUEST'
  | 'JOB_CANCELLED'
  | 'JOB_RESCHEDULED'
  | 'INTERNAL_DISPATCH'

export type CommChannel = 'sms' | 'email'

// Who the message is for. `customer` events go to the customer's phone/email;
// `internal` events go to crew/dispatch and are delivered through the existing
// crew reminder engine — the comms layer only models + previews them here.
export type CommAudience = 'customer' | 'internal'

export type CommEventDef = {
  event: CommEvent
  label: string
  audience: CommAudience
  // Channels this event is allowed to use. dispatch intersects this with the
  // caller's requested channels and with whichever contact info is present.
  channels: CommChannel[]
  // Transactional messages (booking/appointment/invoice/dispatch) may be sent
  // automatically. `marketing` events may NEVER be auto-sent (compliance guard
  // in service.ts). None of the operational events below are marketing.
  marketing: boolean
  // Reminder-class events respect quiet hours unless a caller explicitly bypasses;
  // hard transactional events (confirmations, receipts) ignore quiet hours.
  reminder: boolean
  // Human note: which existing production sender already covers this, if any.
  // Documentation only — the comms layer does not call these; it is additive.
  existing?: string
}

export const COMM_EVENTS: CommEventDef[] = [
  { event: 'BOOKING_RECEIVED',    label: 'Booking Received',      audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false, existing: 'sendConfirmationLink' },
  { event: 'QUOTE_SENT',          label: 'Quote Sent',           audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false },
  { event: 'QUOTE_REMINDER',      label: 'Quote Reminder',       audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: true },
  { event: 'BOOKING_CONFIRMED',   label: 'Booking Confirmed',    audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false, existing: 'notifyBookingConfirmed' },
  { event: 'APPOINTMENT_REMINDER',label: 'Appointment Reminder', audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: true,  existing: 'notifyJobTomorrow' },
  { event: 'CREW_DISPATCHED',     label: 'Crew Dispatched',      audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false },
  { event: 'ON_THE_WAY',          label: 'Driver On The Way',    audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false },
  { event: 'ETA_UPDATED',         label: 'ETA Updated',          audience: 'customer', channels: ['sms'],          marketing: false, reminder: false },
  { event: 'ARRIVED',             label: 'Arrival Notice',       audience: 'customer', channels: ['sms'],          marketing: false, reminder: false },
  { event: 'JOB_COMPLETED',       label: 'Job Completed',        audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false, existing: 'notifyJobCompleted' },
  { event: 'INVOICE_SENT',        label: 'Invoice Sent',         audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false },
  { event: 'INVOICE_REMINDER',    label: 'Invoice Reminder',     audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: true,  existing: 'notifyPaymentReminder' },
  { event: 'PAYMENT_RECEIVED',    label: 'Payment Confirmation', audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false, existing: 'notifyPaidInFull' },
  { event: 'REVIEW_REQUEST',      label: 'Review Request',       audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: true,  existing: 'notifyReviewRequest' },
  { event: 'JOB_CANCELLED',       label: 'Cancellation',         audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false, existing: 'notifyCancelledByCustomer' },
  { event: 'JOB_RESCHEDULED',     label: 'Rescheduling',         audience: 'customer', channels: ['sms', 'email'], marketing: false, reminder: false, existing: 'notifyRescheduled' },
  { event: 'INTERNAL_DISPATCH',   label: 'Internal Dispatch',    audience: 'internal', channels: ['sms'],          marketing: false, reminder: false, existing: 'sendImmediate (reminder engine)' },
]

export const EVENT_BY_ID: Record<CommEvent, CommEventDef> =
  Object.fromEntries(COMM_EVENTS.map(e => [e.event, e])) as Record<CommEvent, CommEventDef>

export function getEventDef(event: CommEvent): CommEventDef {
  const def = EVENT_BY_ID[event]
  if (!def) throw new Error(`Unknown comm event: ${event}`)
  return def
}

export function isCommEvent(v: unknown): v is CommEvent {
  return typeof v === 'string' && v in EVENT_BY_ID
}
</content>
