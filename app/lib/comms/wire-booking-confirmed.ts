// ─────────────────────────────────────────────────────────────────────────────
// Controlled BOOKING_CONFIRMED wiring (first event onto the comms event model).
//
// When a booking genuinely transitions to `confirmed`, this ADDITIVELY records ONE
// suppressed/test entry on the communications ledger — as evidence the event model
// is wired — WITHOUT ever calling a provider and WITHOUT changing the existing
// customer confirmation (notifyBookingConfirmed still fires as it always has).
//
// Controlled-integration guarantees (all enforced here, not by env alone):
//   • mode is FORCED to 'test' → service.ts renders + logs a SIMULATED ledger row
//     and NEVER calls Twilio/Resend. Independent of COMMS_SEND_MODE (which stays
//     'off' in production) so this can never send a real message, even if someone
//     later flips the env to 'live'. Flip THIS to an env-resolved mode only when
//     confirmations are ready to actually send.
//   • exactly ONE entry: a single channel (SMS if a phone is on file, else email),
//     so a customer with both contact methods still yields one row, not two.
//   • idempotent: a stable per-booking key (`booking-confirmed:{token}`) means a
//     retry/replay of the same confirmation is de-duplicated by the comms layer.
//   • fail-soft: any error is swallowed — a comms hiccup must NEVER block or reverse
//     a booking confirmation.
//   • automation rules are untouched (this is a direct dispatch, not a rule), so the
//     automation registry stays disabled.
// ─────────────────────────────────────────────────────────────────────────────

import type { Booking } from '../bookings'
import { fromBooking } from './adapters'
import { dispatchComm, type CommDeps, type DispatchResult } from './service'
import type { CommChannel } from './events'

export function bookingConfirmedIdempotencyKey(token: string): string {
  return `booking-confirmed:${token}`
}

export async function emitBookingConfirmedComm(
  b: Booking,
  opts: { now?: number } = {},
  deps?: Partial<CommDeps>,
): Promise<DispatchResult | null> {
  try {
    const ctx = fromBooking(b)
    // Exactly one entry: prefer SMS (the immediate confirmation channel), else email.
    const channel: CommChannel | null = ctx.phone ? 'sms' : ctx.email ? 'email' : null
    if (!channel) return null // no contact on file → nothing to record

    return await dispatchComm(
      'BOOKING_CONFIRMED',
      ctx,
      {
        mode: 'test',                         // suppressed/test only — never a provider call
        channels: [channel],                  // single channel → exactly one ledger row
        idempotencyKey: bookingConfirmedIdempotencyKey(b.token),
        actor: 'system',
        actorRole: 'system',
        trigger: 'system',
        now: opts.now,
      },
      deps,
    )
  } catch (e) {
    // Fail-soft: a communications failure must never block booking confirmation.
    console.error('[comms] BOOKING_CONFIRMED emit failed (non-blocking)', e)
    return null
  }
}
