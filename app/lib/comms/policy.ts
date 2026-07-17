// Safety & send policy (Phase 5). Pure decisions — no Redis, no providers — so the
// rules are unit-testable in isolation. service.ts applies them.

import type { CommContext } from './context'
import type { CommEvent } from './events'

// ── Send mode ────────────────────────────────────────────────────────────────
// The layer is DEFAULT-SUPPRESSED. Nothing sends for real until COMMS_SEND_MODE is
// explicitly 'live' AND we're in production. Preview/dev never send live, no matter
// what COMMS_SEND_MODE says — this is the "no live sends in Preview" guarantee.
export type SendMode =
  | 'live'   // real provider calls (production + COMMS_SEND_MODE=live only)
  | 'test'   // render + validate + log a simulated ledger entry, but NEVER call a provider
  | 'off'    // suppress entirely: no provider call, no ledger write

export function resolveSendMode(override?: SendMode): SendMode {
  if (override) return override
  const env = (process.env.COMMS_SEND_MODE || '').toLowerCase()
  const vercelEnv = process.env.VERCEL_ENV // 'production' | 'preview' | 'development'
  // Hard rule: outside production we never go live.
  if (vercelEnv && vercelEnv !== 'production') {
    return env === 'test' ? 'test' : 'off'
  }
  if (env === 'live') return 'live'
  if (env === 'test') return 'test'
  return 'off'
}

// ── Quiet hours (Central) ────────────────────────────────────────────────────
// Reminder-class events are held during quiet hours unless a caller explicitly
// bypasses. Hard transactional events (confirmations, receipts, cancellations)
// ignore quiet hours — they're expected immediately.
export const QUIET_START_MIN = 21 * 60 // 21:00
export const QUIET_END_MIN = 8 * 60    // 08:00

export function centralMinutesOfDay(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now))
  let h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  if (h === 24) h = 0
  return h * 60 + m
}

export function inQuietHours(now: number): boolean {
  const m = centralMinutesOfDay(now)
  return m >= QUIET_START_MIN || m < QUIET_END_MIN
}

// ── Idempotency / duplicate prevention ───────────────────────────────────────
// The default duplicate window: the same event to the same recipient within this
// window is treated as a duplicate and skipped. Callers can pass an explicit
// idempotency key (e.g. one derived from a state transition) to be precise.
export const DUP_WINDOW_MS = 6 * 60 * 60 * 1000 // 6h

export function idempotencyKey(event: CommEvent, ctx: CommContext, explicit?: string): string {
  if (explicit && explicit.trim()) return `comm:idem:${explicit.trim()}`
  const who = ctx.bookingId || ctx.invoiceNumber || ctx.phone || ctx.email || 'unknown'
  return `comm:idem:${event}:${who}`
}

// ── Retry policy ─────────────────────────────────────────────────────────────
export const MAX_ATTEMPTS = 3 // initial try + 2 retries
