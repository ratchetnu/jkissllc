// Customer communications log — every inbound/outbound message (SMS, email,
// admin note, system event) tied to a customer/booking. Mirrors the Redis
// patterns in bookings.ts: a JSON blob per message under `msg:{id}`, plus
// sorted-set indexes for the global feed, the unread badge, per-booking
// timelines, and per-phone threading, plus a provider-id dedup key.
//
// Pure store — no provider calls and no Next.js APIs. Matching, sending, and
// notifying live in the webhook/route layer so this stays decoupled.

import { redis } from './redis'

export type MsgDirection = 'inbound' | 'outbound'
export type MsgChannel = 'sms' | 'email' | 'note' | 'system'
export type MsgProvider = 'twilio' | 'resend' | 'manual' | 'system' | 'gmail'
export type MsgStatus =
  | 'queued' | 'sent' | 'delivered' | 'failed'   // outbound lifecycle
  | 'received' | 'read' | 'archived'             // inbound lifecycle

// Workflow/triage labels (Phase 8 automation-safety states).
export type MsgReviewState = 'needs_reply' | 'customer_responded' | 'waiting_on_customer' | 'resolved'

export type Message = {
  id: string
  direction: MsgDirection
  channel: MsgChannel
  provider: MsgProvider
  providerMessageId?: string      // Twilio MessageSid / Resend id — also dedup key

  from?: string                   // E.164 or email
  to?: string
  subject?: string                // email only
  body: string

  // Linkage (any that are known). bookingToken is the join to a Booking.
  customerId?: string
  customerName?: string
  customerPhone?: string          // E.164 when known
  customerEmail?: string
  bookingToken?: string
  bookingNumber?: string
  jobId?: string
  quoteId?: string
  threadId?: string               // email thread / SMS conversation grouping

  status: MsgStatus
  unread: boolean                 // true for inbound until an admin reads it
  reviewState?: MsgReviewState
  tags?: string[]
  assignedAdmin?: string

  createdAt: number               // epoch ms
  readAt?: number
}

// ── keys ─────────────────────────────────────────────────────────────────────
const KEY = 'msg:'                                   // msg:{id} -> JSON
const IDX_ALL = 'msg:index'                          // zset score=createdAt member=id
const IDX_UNREAD = 'msg:unread'                      // zset of unread inbound ids
const idxBooking = (token: string) => `msg:booking:${token}`   // per-booking timeline
const idxPhone = (e164: string) => `msg:phone:${e164}`         // per-phone thread
const dedupKey = (pid: string) => `msg:pid:${pid}`             // provider id -> msg id

function genId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function mget(ids: string[]): Promise<Message[]> {
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(`${KEY}${id}`)))
  const out: Message[] = []
  for (const raw of raws) {
    if (!raw) continue
    try { out.push(JSON.parse(raw) as Message) } catch { /* skip corrupt */ }
  }
  return out
}

// ── write ────────────────────────────────────────────────────────────────────

export async function saveMessage(m: Message): Promise<void> {
  await redis.set(`${KEY}${m.id}`, JSON.stringify(m))
  await redis.zadd(IDX_ALL, m.createdAt, m.id)
  if (m.bookingToken) await redis.zadd(idxBooking(m.bookingToken), m.createdAt, m.id)
  if (m.customerPhone) await redis.zadd(idxPhone(m.customerPhone), m.createdAt, m.id)
  if (m.providerMessageId) await redis.set(dedupKey(m.providerMessageId), m.id)
  if (m.direction === 'inbound' && m.unread && m.status !== 'archived') {
    await redis.zadd(IDX_UNREAD, m.createdAt, m.id)
  } else {
    await redis.zrem(IDX_UNREAD, m.id)
  }
}

// Convenience: create + persist a message from partial input, filling defaults.
export async function recordMessage(input: Partial<Message> & {
  direction: MsgDirection
  channel: MsgChannel
  provider: MsgProvider
  body: string
}): Promise<Message> {
  const now = Date.now()
  const inbound = input.direction === 'inbound'
  const m: Message = {
    id: input.id ?? genId(),
    direction: input.direction,
    channel: input.channel,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    from: input.from,
    to: input.to,
    subject: input.subject,
    body: input.body,
    customerId: input.customerId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail,
    bookingToken: input.bookingToken,
    bookingNumber: input.bookingNumber,
    jobId: input.jobId,
    quoteId: input.quoteId,
    threadId: input.threadId,
    status: input.status ?? (inbound ? 'received' : 'sent'),
    unread: input.unread ?? inbound,
    reviewState: input.reviewState ?? (inbound ? 'needs_reply' : undefined),
    tags: input.tags,
    assignedAdmin: input.assignedAdmin,
    createdAt: input.createdAt ?? now,
    readAt: input.readAt,
  }
  await saveMessage(m)
  return m
}

export async function markRead(id: string): Promise<Message | null> {
  const m = await getMessage(id)
  if (!m) return null
  m.unread = false
  m.readAt = Date.now()
  if (m.status === 'received') m.status = 'read'
  await saveMessage(m)
  return m
}

export async function setReviewState(id: string, state: MsgReviewState): Promise<Message | null> {
  const m = await getMessage(id)
  if (!m) return null
  m.reviewState = state
  if (state === 'resolved') { m.unread = false }
  await saveMessage(m)
  return m
}

export async function archiveMessage(id: string): Promise<Message | null> {
  const m = await getMessage(id)
  if (!m) return null
  m.status = 'archived'
  m.unread = false
  await saveMessage(m)
  return m
}

// Re-open a message as unread (undo an accidental mark-read).
export async function markUnread(id: string): Promise<Message | null> {
  const m = await getMessage(id)
  if (!m) return null
  if (m.direction !== 'inbound') return m   // only inbound can be "unread"
  m.unread = true
  m.readAt = undefined
  if (m.status === 'read' || m.status === 'archived') m.status = 'received'
  await saveMessage(m)
  return m
}

// Link an (often unmatched) message to a booking. saveMessage re-indexes it into
// that booking's timeline so it shows on the booking detail thread.
export async function attachToBooking(id: string, link: {
  token: string; bookingNumber?: string; customerName?: string; customerPhone?: string; customerEmail?: string
}): Promise<Message | null> {
  const m = await getMessage(id)
  if (!m) return null
  m.bookingToken = link.token
  if (link.bookingNumber) m.bookingNumber = link.bookingNumber
  if (link.customerName && !m.customerName) m.customerName = link.customerName
  if (link.customerPhone && !m.customerPhone) m.customerPhone = link.customerPhone
  if (link.customerEmail && !m.customerEmail) m.customerEmail = link.customerEmail
  await saveMessage(m)
  return m
}

// Triage an unmatched message as not customer-related: archive it and tag it so
// it never shows in the active inbox again.
export async function dismissAsNotCustomer(id: string): Promise<Message | null> {
  const m = await getMessage(id)
  if (!m) return null
  m.status = 'archived'
  m.unread = false
  m.tags = Array.from(new Set([...(m.tags ?? []), 'not-customer']))
  await saveMessage(m)
  return m
}

// ── read ─────────────────────────────────────────────────────────────────────

export async function getMessage(id: string): Promise<Message | null> {
  const raw = await redis.get(`${KEY}${id}`)
  if (!raw) return null
  try { return JSON.parse(raw) as Message } catch { return null }
}

export async function listRecent(limit = 200): Promise<Message[]> {
  return mget(await redis.zrevrange(IDX_ALL, 0, limit - 1))
}

export async function listUnread(limit = 200): Promise<Message[]> {
  return mget(await redis.zrevrange(IDX_UNREAD, 0, limit - 1))
}

export async function unreadCount(): Promise<number> {
  return redis.zcard(IDX_UNREAD)
}

// Oldest-first timeline for a booking (so it reads top-to-bottom chronologically).
export async function timelineForBooking(token: string, limit = 500): Promise<Message[]> {
  return mget(await redis.zrange(idxBooking(token), 0, limit - 1))
}

export async function threadForPhone(e164: string, limit = 200): Promise<Message[]> {
  return mget(await redis.zrange(idxPhone(e164), 0, limit - 1))
}

// Has this provider message id already been stored? (idempotent webhook guard)
export async function seenProviderMessage(providerMessageId: string): Promise<boolean> {
  return !!(await redis.get(dedupKey(providerMessageId)))
}
