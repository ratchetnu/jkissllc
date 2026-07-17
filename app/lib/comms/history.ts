// Central message history (Phase 4 deliverable / Phase 7 data source).
//
// Pure read layer over the existing messages.ts ledger — it introduces NO new
// store. It reshapes ledger rows for the communications console and derives the
// comms-specific fields (event, simulated, initiated-by) from the tags the
// dispatch service writes. Filtering happens in memory over the recent window, so
// loading history never sends a message.

import { listRecent, type Message, type MsgChannel, type MsgStatus } from '../messages'
import type { CommEvent } from './events'
import { isCommEvent } from './events'

export type CommHistoryFilter = {
  channel?: MsgChannel
  status?: MsgStatus
  event?: CommEvent
  bookingToken?: string
  onlyComms?: boolean   // only rows the comms layer produced (tagged 'comms')
  onlyFailed?: boolean
  includeSimulated?: boolean  // default true
  limit?: number        // rows returned (post-filter), default 200
  scanLimit?: number     // ledger rows scanned before filtering, default 500
}

export type CommHistoryRow = {
  id: string
  createdAt: number
  direction: 'inbound' | 'outbound'
  channel: MsgChannel
  provider: string
  recipient?: string
  subject?: string
  body: string
  status: MsgStatus
  event?: CommEvent
  simulated: boolean
  initiatedBy?: string
  bookingNumber?: string
  bookingToken?: string
  jobId?: string
  providerMessageId?: string
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  const t = (tags ?? []).find(x => x.startsWith(prefix))
  return t ? t.slice(prefix.length) : undefined
}

function toRow(m: Message): CommHistoryRow {
  const eventTag = tagValue(m.tags, 'event:')
  return {
    id: m.id,
    createdAt: m.createdAt,
    direction: m.direction,
    channel: m.channel,
    provider: m.provider,
    recipient: m.to ?? m.customerPhone ?? m.customerEmail,
    subject: m.subject,
    body: m.body,
    status: m.status,
    event: eventTag && isCommEvent(eventTag) ? eventTag : undefined,
    simulated: (m.tags ?? []).includes('simulated'),
    initiatedBy: tagValue(m.tags, 'by:'),
    bookingNumber: m.bookingNumber,
    bookingToken: m.bookingToken,
    jobId: m.jobId,
    providerMessageId: m.providerMessageId,
  }
}

export async function listCommHistory(filter: CommHistoryFilter = {}): Promise<CommHistoryRow[]> {
  const scanLimit = filter.scanLimit ?? 500
  const limit = filter.limit ?? 200
  const includeSimulated = filter.includeSimulated ?? true
  const raw = await listRecent(scanLimit)
  const rows = raw.map(toRow).filter(r => {
    // onlyComms: keep only rows the comms layer wrote (carry an event or simulated tag).
    if (filter.onlyComms && !r.event && !r.simulated) return false
    if (!includeSimulated && r.simulated) return false
    if (filter.channel && r.channel !== filter.channel) return false
    if (filter.status && r.status !== filter.status) return false
    if (filter.event && r.event !== filter.event) return false
    if (filter.bookingToken && r.bookingToken !== filter.bookingToken) return false
    if (filter.onlyFailed && r.status !== 'failed') return false
    return true
  })
  return rows.slice(0, limit)
}

// ── Usage / cost estimate ────────────────────────────────────────────────────
// A VOLUME estimate from the ledger — clearly not a billing source of truth. SMS
// is billed per 160-char segment; email is effectively free at this volume.
const SMS_SEGMENT_USD = 0.0079
const SMS_SEGMENT_LEN = 160

export type CommUsage = {
  window: number          // rows considered
  smsCount: number
  emailCount: number
  smsSegments: number
  failed: number
  simulated: number
  estimatedUsd: number    // estimate only
}

export function estimateUsage(rows: CommHistoryRow[]): CommUsage {
  let smsCount = 0, emailCount = 0, smsSegments = 0, failed = 0, simulated = 0
  for (const r of rows) {
    if (r.simulated) simulated++
    if (r.status === 'failed') failed++
    // Only real (non-simulated) sends contribute to cost.
    if (r.simulated) continue
    if (r.channel === 'sms') {
      smsCount++
      smsSegments += Math.max(1, Math.ceil((r.body?.length || 1) / SMS_SEGMENT_LEN))
    } else if (r.channel === 'email') {
      emailCount++
    }
  }
  return {
    window: rows.length, smsCount, emailCount, smsSegments, failed, simulated,
    estimatedUsd: Math.round(smsSegments * SMS_SEGMENT_USD * 100) / 100,
  }
}
