// Reminder template catalog (request Part 3). The reusable, named reminders the ops
// team fires again and again — each carries its default channels, message, the crew
// acknowledgement buttons it offers, whether it is route-linked, and which smart
// suppression rule turns it off once the underlying task is done (request Part 4).
//
// Pure data + types — no Redis, no provider calls. The engine and the UI both read
// from here so a template's behavior is defined in exactly one place.

// ── Delivery channels ────────────────────────────────────────────────────────
// inapp + sms + email are live (Twilio / Resend / the Messages hub). `push` is a
// first-class channel in the model but has no web-push transport yet — the engine
// delivers it as an in-app message so nothing is dropped, and real web-push can be
// added later without touching callers. See docs for the roadmap.
export type ReminderChannel = 'inapp' | 'sms' | 'email' | 'push'
export const ALL_CHANNELS: ReminderChannel[] = ['inapp', 'sms', 'email', 'push']

// ── Acknowledgement vocabulary (request Part 5) ──────────────────────────────
export type AckKind =
  | 'acknowledged' | 'completed' | 'calling' | 'need_help'
  | 'already_done' | 'having_issues' | 'unable'

export const ACK_LABEL: Record<AckKind, string> = {
  acknowledged: 'Acknowledged',
  completed: 'Completed',
  calling: 'Calling Now',
  need_help: 'Need Help',
  already_done: 'Already Done',
  having_issues: 'Having Issues',
  unable: 'Unable',
}

// An acknowledgement that means "the task is satisfied" — used by suppression +
// completion analytics.
export const ACK_IS_DONE: Record<AckKind, boolean> = {
  acknowledged: false, completed: true, calling: false, need_help: false,
  already_done: true, having_issues: false, unable: false,
}

// ── Smart-suppression rules (request Part 4) ─────────────────────────────────
// The key selects the predicate in reminder-segments.ts that decides whether the
// reminder is still NEEDED for a given crew member on a given day. 'none' = always
// send (subject only to the universal time-off / cancelled-route / dedup guards).
export type SuppressKey =
  | 'none'
  | 'uniform_uploaded'
  | 'clocked_in'
  | 'clocked_out'
  | 'route_confirmed'
  | 'availability_submitted'
  | 'acked_done'          // suppress once the crew tapped a "done" ack today

// ── Dynamic crew segments (request Part 1) ───────────────────────────────────
export type SegmentId =
  | 'all'
  | 'available'
  | 'unconfirmed'
  | 'missing_uniform'
  | 'missing_clock_in'
  | 'missing_clock_out'
  | 'missing_route_confirmation'
  | 'missing_delivery_app'
  | 'missing_availability'
  | 'missing_ack'

export const SEGMENT_LABEL: Record<SegmentId, string> = {
  all: 'Entire Crew',
  available: 'Available Crew',
  unconfirmed: 'Unconfirmed Crew',
  missing_uniform: 'Missing Uniform Photo',
  missing_clock_in: 'Missing Clock In',
  missing_clock_out: 'Missing Clock Out',
  missing_route_confirmation: 'Missing Route Confirmation',
  missing_delivery_app: 'Missing Delivery App Update',
  missing_availability: 'Missing Weekly Availability',
  missing_ack: 'Missing Acknowledgement',
}

export type TemplateCategory = 'compliance' | 'dispatch' | 'schedule' | 'custom'

export type ReminderTemplateDef = {
  id: string
  label: string
  category: TemplateCategory
  icon: string                 // lucide-react icon name; the UI maps it
  defaultChannels: ReminderChannel[]
  defaultMessage: string
  ackOptions: AckKind[]
  requireAckDefault: boolean
  suppress: SuppressKey
  routeLinked: boolean         // needs a route context to be meaningful
  urgent: boolean              // dispatch bypass — sent immediately, all channels
}

// The required template set (request Part 3). `custom` is the open-ended one.
export const TEMPLATES: ReminderTemplateDef[] = [
  {
    id: 'uniform_photo', label: 'Uniform Picture', category: 'compliance', icon: 'Camera',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: "Please upload today's uniform photo before beginning your route.",
    ackOptions: ['completed', 'need_help'], requireAckDefault: true,
    suppress: 'uniform_uploaded', routeLinked: false, urgent: false,
  },
  {
    id: 'delivery_app', label: 'Delivery App Update', category: 'compliance', icon: 'Smartphone',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: 'Please verify that all required delivery apps are updated and logged in before your route.',
    ackOptions: ['completed', 'need_help', 'having_issues'], requireAckDefault: true,
    suppress: 'acked_done', routeLinked: false, urgent: false,
  },
  {
    id: 'route_confirmation', label: 'Route Confirmation', category: 'schedule', icon: 'CheckCircle2',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: "Please confirm tomorrow's route.",
    ackOptions: ['completed', 'unable'], requireAckDefault: true,
    suppress: 'route_confirmed', routeLinked: true, urgent: false,
  },
  {
    id: 'clock_in', label: 'Clock In', category: 'compliance', icon: 'LogIn',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: "Don't forget to clock in when you start your route.",
    ackOptions: ['completed', 'already_done'], requireAckDefault: false,
    suppress: 'clocked_in', routeLinked: true, urgent: false,
  },
  {
    id: 'clock_out', label: 'Clock Out', category: 'compliance', icon: 'LogOut',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: 'Please remember to clock out when your route is complete.',
    ackOptions: ['completed', 'already_done'], requireAckDefault: false,
    suppress: 'clocked_out', routeLinked: true, urgent: false,
  },
  {
    id: 'dispatch_needs_you', label: 'Dispatch Needs You', category: 'dispatch', icon: 'Radio',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: 'Dispatch needs you. Please respond as soon as possible.',
    ackOptions: ['acknowledged', 'calling', 'need_help'], requireAckDefault: true,
    suppress: 'none', routeLinked: false, urgent: true,
  },
  {
    id: 'call_me', label: 'Call Me', category: 'dispatch', icon: 'PhoneCall',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: 'Dispatch needs you. Please call immediately.',
    ackOptions: ['calling', 'need_help', 'unable'], requireAckDefault: true,
    suppress: 'none', routeLinked: false, urgent: true,
  },
  {
    id: 'missing_pod', label: 'Missing Proof of Delivery', category: 'compliance', icon: 'FileCheck2',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: 'We are missing proof of delivery for one or more stops. Please upload it now.',
    ackOptions: ['completed', 'having_issues', 'need_help'], requireAckDefault: true,
    suppress: 'acked_done', routeLinked: true, urgent: false,
  },
  {
    id: 'missing_equipment_check', label: 'Missing Equipment Check', category: 'compliance', icon: 'Wrench',
    defaultChannels: ['inapp', 'sms'],
    defaultMessage: 'Please complete your equipment check before departing.',
    ackOptions: ['completed', 'having_issues'], requireAckDefault: true,
    suppress: 'acked_done', routeLinked: true, urgent: false,
  },
  {
    id: 'missing_availability', label: 'Missing Weekly Availability', category: 'schedule', icon: 'CalendarClock',
    defaultChannels: ['inapp', 'sms', 'email'],
    defaultMessage: 'Please submit your availability for next week so we can build the schedule.',
    ackOptions: ['completed', 'need_help'], requireAckDefault: false,
    suppress: 'availability_submitted', routeLinked: false, urgent: false,
  },
  {
    id: 'custom', label: 'Custom Reminder', category: 'custom', icon: 'Bell',
    defaultChannels: ['inapp'],
    defaultMessage: '',
    ackOptions: ['acknowledged', 'completed', 'need_help'], requireAckDefault: false,
    suppress: 'none', routeLinked: false, urgent: false,
  },
]

export const TEMPLATE_BY_ID: Record<string, ReminderTemplateDef> =
  Object.fromEntries(TEMPLATES.map(t => [t.id, t]))

export function getTemplate(id: string | undefined | null): ReminderTemplateDef {
  return (id && TEMPLATE_BY_ID[id]) || TEMPLATE_BY_ID.custom
}

// ── Dispatch quick-blasts (request Part 13) ──────────────────────────────────
// One-tap, schedule-bypassing sends. Each is a message + its ack buttons; the
// engine fires them immediately across every configured channel.
export type DispatchAction = {
  id: string
  label: string
  message: string
  icon: string
  ackOptions: AckKind[]
  tone: 'urgent' | 'alert' | 'info'
}

export const DISPATCH_ACTIONS: DispatchAction[] = [
  { id: 'call_me', label: 'Call Me', icon: 'PhoneCall', tone: 'urgent',
    message: 'Dispatch needs you. Please call immediately.', ackOptions: ['calling', 'need_help', 'unable'] },
  { id: 'dispatch_needs_you', label: 'Dispatch Needs You', icon: 'Radio', tone: 'urgent',
    message: 'Dispatch needs you. Please respond as soon as possible.', ackOptions: ['acknowledged', 'calling', 'need_help'] },
  { id: 'route_changed', label: 'Route Changed', icon: 'Route', tone: 'alert',
    message: 'Your route has changed. Open the app for the latest details.', ackOptions: ['acknowledged', 'need_help'] },
  { id: 'emergency', label: 'Emergency', icon: 'AlertTriangle', tone: 'urgent',
    message: 'Emergency — please respond to dispatch immediately.', ackOptions: ['acknowledged', 'calling', 'need_help'] },
  { id: 'new_assignment', label: 'New Assignment', icon: 'ClipboardPlus', tone: 'info',
    message: 'You have a new assignment. Open the app to review and confirm.', ackOptions: ['acknowledged', 'completed'] },
  { id: 'customer_waiting', label: 'Customer Waiting', icon: 'Clock', tone: 'alert',
    message: 'A customer is waiting. Please provide a status update.', ackOptions: ['acknowledged', 'calling'] },
  { id: 'traffic_delay', label: 'Traffic Delay', icon: 'TrafficCone', tone: 'info',
    message: 'Heads up on a traffic delay affecting your route. Adjust as needed and update dispatch.', ackOptions: ['acknowledged'] },
  { id: 'equipment_change', label: 'Equipment Change', icon: 'Truck', tone: 'alert',
    message: 'There is an equipment change for your route. Confirm with dispatch before you depart.', ackOptions: ['acknowledged', 'need_help'] },
]
