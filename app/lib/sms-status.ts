// Delivery-status ledger for OUTBOUND SMS. Twilio POSTs a StatusCallback for each
// message as it moves queued → sent → delivered (or → undelivered/failed). We record
// a single record per MessageSid, keyed by the SID, and collapse repeated callbacks
// idempotently. No message body is ever stored, and phone numbers are stored masked
// (last 4 only). Booking linkage + notification type are best-effort — filled when the
// SID correlates to an outbound entry in the message ledger, otherwise left unknown.
//
// The merge logic (mergeDeliveryStatus) is pure so it can be unit-tested without Redis;
// recordDeliveryStatus is the thin Redis load→merge→save wrapper.

import { redis } from './redis'

export type SmsDeliveryStatus =
  | 'queued' | 'accepted' | 'scheduled' | 'sending' | 'sent'
  | 'delivered' | 'undelivered' | 'failed' | 'canceled'

// A status Twilio only reports on a terminal failure — these raise the owner alert.
const TERMINAL_FAILURES = new Set<string>(['undelivered', 'failed'])

export function isTerminalFailure(status: string): boolean {
  return TERMINAL_FAILURES.has(status.toLowerCase())
}

// Map a Twilio message error code to a SAFE, coarse classification for the ledger and
// alert. We never surface raw provider internals beyond the numeric code + this slug.
export function classifyTwilioError(code?: number | null): string | undefined {
  if (code == null) return undefined
  switch (code) {
    case 21610: return 'recipient_opted_out'          // sent to a number that replied STOP
    case 21211: case 21614: return 'invalid_number'
    case 30003: return 'unreachable_destination'      // handset unreachable/off
    case 30004: return 'message_blocked'              // blocked (e.g. carrier/user block)
    case 30005: return 'unknown_destination'          // unknown/inactive number
    case 30006: return 'landline_or_unreachable'
    case 30007: return 'carrier_filtered'             // carrier spam filtering
    case 30008: return 'unknown_error'
    case 30034: return 'a2p_not_registered'           // 10DLC campaign not approved/attached
    case 30410: case 30500: return 'provider_delay_or_outage'
    default: return 'other'
  }
}

// Store only the last 4 digits of a destination number — enough to correlate/debug,
// never the full PII number.
export function maskPhone(e164?: string | null): string | undefined {
  if (!e164) return undefined
  const digits = e164.replace(/[^\d]/g, '')
  if (digits.length < 4) return '••••'
  return `••••${digits.slice(-4)}`
}

export type SmsStatusRecord = {
  sid: string
  status: SmsDeliveryStatus | string
  statusesSeen: string[]        // ordered unique statuses observed (history + idempotency)
  errorCode?: number
  errorClass?: string
  bookingToken?: string
  bookingNumber?: string
  notificationType?: string     // best-effort, from the correlated ledger message
  toMasked?: string
  firstSeenAt: number
  updatedAt: number
  terminalAlertedAt?: number     // set once, when we raise the failure alert
}

export type DeliveryStatusInput = {
  sid: string
  status: string
  errorCode?: number | null
  toMasked?: string
  bookingToken?: string
  bookingNumber?: string
  notificationType?: string
  now: number
}

// Pure state transition. Given the existing record (or null) and an incoming callback,
// returns the next record plus whether this callback advanced the status (isNewStatus)
// and whether it should raise the owner alert now (shouldAlert — a first-time terminal
// failure). Idempotent: a duplicate callback for a status already seen does not
// re-alert and does not duplicate history.
export function mergeDeliveryStatus(
  existing: SmsStatusRecord | null,
  input: DeliveryStatusInput,
): { record: SmsStatusRecord; isNewStatus: boolean; shouldAlert: boolean } {
  const status = input.status
  const base: SmsStatusRecord = existing ?? {
    sid: input.sid,
    status,
    statusesSeen: [],
    firstSeenAt: input.now,
    updatedAt: input.now,
  }
  const isNewStatus = !base.statusesSeen.includes(status)
  const statusesSeen = isNewStatus ? [...base.statusesSeen, status] : base.statusesSeen

  const record: SmsStatusRecord = {
    ...base,
    status,                                   // latest wins
    statusesSeen,
    updatedAt: input.now,
    // Only fill correlation/detail fields; never clear a value we already learned.
    errorCode: input.errorCode ?? base.errorCode,
    errorClass: classifyTwilioError(input.errorCode) ?? base.errorClass,
    bookingToken: input.bookingToken ?? base.bookingToken,
    bookingNumber: input.bookingNumber ?? base.bookingNumber,
    notificationType: input.notificationType ?? base.notificationType,
    toMasked: input.toMasked ?? base.toMasked,
  }

  const shouldAlert = isTerminalFailure(status) && isNewStatus && !base.terminalAlertedAt
  if (shouldAlert) record.terminalAlertedAt = input.now

  return { record, isNewStatus, shouldAlert }
}

// ── Redis-backed store ────────────────────────────────────────────────────────
const key = (sid: string) => `smsdlv:${sid}`
const IDX = 'smsdlv:index'

export async function getDeliveryStatus(sid: string): Promise<SmsStatusRecord | null> {
  try {
    const raw = await redis.get(key(sid))
    return raw ? (JSON.parse(raw) as SmsStatusRecord) : null
  } catch { return null }
}

// Load → merge (pure) → save. Returns the merge result so the route can decide whether
// to alert. Never throws for a missing prior record (idempotent create on first callback,
// which also covers a callback arriving before any ledger write is visible).
export async function recordDeliveryStatus(
  input: DeliveryStatusInput,
): Promise<{ record: SmsStatusRecord; isNewStatus: boolean; shouldAlert: boolean }> {
  const existing = await getDeliveryStatus(input.sid)
  const merged = mergeDeliveryStatus(existing, input)
  try {
    await redis.set(key(input.sid), JSON.stringify(merged.record))
    await redis.zadd(IDX, merged.record.updatedAt, input.sid)
  } catch { /* non-fatal — never crash a webhook on a store hiccup */ }
  return merged
}

export async function listRecentDeliveryStatuses(limit = 100): Promise<SmsStatusRecord[]> {
  try {
    const ids = await redis.zrevrange(IDX, 0, limit - 1)
    const raws = await Promise.all(ids.map(id => redis.get(key(id))))
    const out: SmsStatusRecord[] = []
    for (const raw of raws) { if (raw) { try { out.push(JSON.parse(raw) as SmsStatusRecord) } catch { /* skip */ } } }
    return out
  } catch { return [] }
}
