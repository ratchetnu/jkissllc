// Automation rules (Phase 6).
//
// Declarative registry of the operational rules the comms layer COULD run. Every
// rule ships DISABLED and in 'test' mode. Nothing here is wired to a cron: the
// production reminder cadence already lives in app/api/cron/* + notify.ts, and
// double-sending would be worse than not sending. These rules are the event-model
// equivalents an operator can review, preview, and (later, deliberately) enable —
// they never fire on their own, and never in Preview.

import type { CommChannel, CommEvent } from './events'

export type AutomationAnchor =
  | 'appointment_start'   // relative to the scheduled appointment
  | 'quote_sent'          // relative to when the quote went out
  | 'invoice_sent'        // relative to when the invoice went out
  | 'job_completed'       // relative to completion

export type AutomationMode = 'test' | 'live'

export type AutomationRule = {
  id: string
  label: string
  description: string
  event: CommEvent
  anchor: AutomationAnchor
  // Hours relative to the anchor. Negative = before the anchor (e.g. -24 = 24h
  // before the appointment); positive = after (e.g. +2 = 2h after completion).
  offsetHours: number
  channels: CommChannel[]
  enabled: boolean          // DEFAULT false — never auto-runs until explicitly turned on
  mode: AutomationMode      // DEFAULT 'test' — simulate, never call a provider
  // If a production sender already covers this cadence, note it so enabling the
  // rule is a conscious "replace the old path" decision, not an accidental double.
  overlapsExisting?: string
}

export const AUTOMATION_RULES: AutomationRule[] = [
  {
    id: 'appt_reminder_24h', label: '24-hour appointment reminder',
    description: 'Remind the customer one day before their scheduled service.',
    event: 'APPOINTMENT_REMINDER', anchor: 'appointment_start', offsetHours: -24,
    channels: ['sms', 'email'], enabled: false, mode: 'test',
    overlapsExisting: 'cron/daily → notifyJobTomorrow',
  },
  {
    id: 'appt_reminder_2h', label: '2-hour appointment reminder',
    description: 'A short-notice nudge two hours before the arrival window.',
    event: 'APPOINTMENT_REMINDER', anchor: 'appointment_start', offsetHours: -2,
    channels: ['sms'], enabled: false, mode: 'test',
  },
  {
    id: 'on_the_way', label: 'On-the-way notice',
    description: 'Let the customer know the crew has departed and is en route.',
    event: 'ON_THE_WAY', anchor: 'appointment_start', offsetHours: 0,
    channels: ['sms'], enabled: false, mode: 'test',
  },
  {
    id: 'quote_reminder_48h', label: 'Quote follow-up (48h)',
    description: 'Gentle reminder two days after a quote is sent, if not yet booked.',
    event: 'QUOTE_REMINDER', anchor: 'quote_sent', offsetHours: 48,
    channels: ['sms', 'email'], enabled: false, mode: 'test',
  },
  {
    id: 'invoice_reminder_72h', label: 'Invoice reminder (72h)',
    description: 'Remind the customer of an unpaid balance three days after invoicing.',
    event: 'INVOICE_REMINDER', anchor: 'invoice_sent', offsetHours: 72,
    channels: ['sms', 'email'], enabled: false, mode: 'test',
    overlapsExisting: 'cron/daily → notifyPaymentReminder',
  },
  {
    id: 'review_after_completion', label: 'Review request after completion',
    description: 'Ask for a review a few hours after the job is marked complete.',
    event: 'REVIEW_REQUEST', anchor: 'job_completed', offsetHours: 3,
    channels: ['sms', 'email'], enabled: false, mode: 'test',
    overlapsExisting: 'cron/daily → notifyReviewRequest',
  },
]

export const RULE_BY_ID: Record<string, AutomationRule> =
  Object.fromEntries(AUTOMATION_RULES.map(r => [r.id, r]))

// Rules that would actually run. Empty by default — every rule ships disabled.
export function enabledRules(): AutomationRule[] {
  return AUTOMATION_RULES.filter(r => r.enabled)
}

// A rule is "armed for live sending" only if it is BOTH enabled and in live mode.
// Used by any future scheduler to decide whether a real send is authorized.
export function isArmed(rule: AutomationRule): boolean {
  return rule.enabled && rule.mode === 'live'
}
