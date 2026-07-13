import { redis } from './redis'
import type { StoredAiEstimate } from './ai/estimate-store'

// ── Service types ────────────────────────────────────────────────────────────
// Reusable across every line of business J Kiss runs (and future ones).
export type ServiceType =
  | 'moving'
  | 'junk-removal'
  | 'eviction'
  | 'appliance-delivery'
  | 'freight'
  | 'estate-cleanout'
  | 'garage-cleanout'
  | 'other'

export const SERVICE_LABELS: Record<ServiceType, string> = {
  'moving': 'Moving Service',
  'junk-removal': 'Junk Removal',
  'eviction': 'Eviction / Property Cleanout',
  'appliance-delivery': 'Appliance Delivery',
  'freight': 'Freight Service',
  'estate-cleanout': 'Estate Cleanout',
  'garage-cleanout': 'Garage Cleanout',
  'other': 'Service',
}

export const SERVICE_TYPES = Object.keys(SERVICE_LABELS) as ServiceType[]

// ── Booking lifecycle ────────────────────────────────────────────────────────
export type BookingStatus =
  | 'quote_received'
  | 'pending_payment'
  | 'pending_zelle_verification'   // Zelle proof uploaded, awaiting owner review
  | 'payment_received'
  | 'booking_created'
  | 'confirmation_link_sent'
  | 'customer_viewed'
  | 'time_verification_pending'
  | 'time_verified'
  | 'confirmed'
  | 'in_progress'
  | 'continued'
  | 'completed'
  | 'partially_completed'
  | 'could_not_complete'
  | 'cancelled'
  | 'refunded'

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  quote_received: 'Quote Received',
  pending_payment: 'Pending Payment',
  pending_zelle_verification: 'Pending Zelle Verification',
  payment_received: 'Payment Received',
  booking_created: 'Booking Created',
  confirmation_link_sent: 'Confirmation Link Sent',
  customer_viewed: 'Customer Viewed',
  time_verification_pending: 'Awaiting Time Verification',
  time_verified: 'Time Verified',
  confirmed: 'Confirmed',
  in_progress: 'In Progress',
  continued: 'Continued — Return Needed',
  completed: 'Completed',
  partially_completed: 'Partially Completed',
  could_not_complete: 'Could Not Complete',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
}

// Terminal/closed states — the job is over (one way or another). Normal reminder &
// balance-due automation must NOT fire on these, and recompute must not override them.
export const CLOSED_STATUSES: BookingStatus[] = ['completed', 'partially_completed', 'could_not_complete', 'cancelled', 'refunded']
export function isClosed(b: Booking): boolean { return CLOSED_STATUSES.includes(b.status) }

// One entry per outbound customer message the owner sends from the admin.
export type CommunicationLog = {
  at: number
  channel: 'sms' | 'email' | 'both'
  body: string
  by: string                    // 'admin' | 'system'
  sms?: boolean                 // delivery result per channel
  email?: boolean
  ok: boolean                   // at least one requested channel succeeded
  sid?: string                  // Twilio MessageSid (when sent via the tracked path)
}

// ── Payments ─────────────────────────────────────────────────────────────────
export type PaymentMethod = 'stripe' | 'zelle' | 'apple_cash' | 'cash' | 'other'
export type PaymentType = 'deposit' | 'balance' | 'full' | 'partial'
export type PaymentRecordStatus = 'pending' | 'sent_by_customer' | 'confirmed' | 'failed' | 'refunded'

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  stripe: 'Card (Stripe)',
  zelle: 'Zelle',
  apple_cash: 'Apple Pay / Cash',
  cash: 'Cash',
  other: 'Other',
}

export type Payment = {
  id: string
  type: PaymentType
  method: PaymentMethod
  status: PaymentRecordStatus
  amountCents: number          // invoice amount applied toward the balance
  feeCents: number             // processing fee (card only)
  totalChargedCents: number    // what the customer actually paid (amount + fee)
  netCents: number             // what J Kiss receives toward the invoice
  stripeSessionId?: string
  stripePaymentIntentId?: string
  reference?: string           // manual reference / confirmation number
  note?: string                // manual confirmation notes (ops only)

  // ── Zelle / proof-upload evidence (sensitive — never sent to the browser) ──
  // proofPath is the SEALED (AES-256-GCM) Vercel Blob pathname of the customer's
  // payment screenshot. It is ciphertext at rest and only ever decrypted by the
  // admin-gated serve endpoint — the raw path is never exposed to a customer.
  proofPath?: string
  proofUploadedAt?: number
  proofHistory?: { path: string; at: number; replacedAt?: number }[]  // superseded proofs, kept for audit
  reviewedBy?: string          // principal.sub who approved/rejected
  reviewedAt?: number
  rejectionReason?: string

  createdAt: number
  confirmedAt?: number
}

// ── Per-booking audit trail (request Part 12) ────────────────────────────────
export type BookingEventAction =
  | 'booking.created' | 'booking.confirmed'
  | 'stripe.verified'
  | 'zelle.uploaded' | 'zelle.replacement_uploaded' | 'zelle.approved' | 'zelle.rejected'
  | 'notification.sent' | 'notification.failed' | 'notification.resent'
  | 'customer.confirmation'
  | 'ai.override' | 'ai.reprice' | 'ai.modify'
  | 'test.marked' | 'test.unmarked'

export type BookingEvent = {
  at: number
  actor: string                // 'customer' | 'system' | 'stripe' | principal.sub
  action: BookingEventAction
  result?: string
  meta?: Record<string, unknown>
}

// ── Owner-notification ledger (request Part 7) ───────────────────────────────
export type NotificationKind =
  | 'zelle_review'             // ZELLE PAYMENT REVIEW REQUIRED → owner
  | 'new_confirmed_booking'    // NEW CONFIRMED BOOKING → owner (after Stripe verify)
  | 'zelle_rejected_customer'  // proof rejected → customer, with replacement link
  | 'confirmation_customer'    // booking confirmed → customer

export type NotificationAttempt = {
  id: string
  kind: NotificationKind
  channel: 'sms' | 'email'
  to?: string
  status: 'sent' | 'failed'
  providerId?: string          // Twilio SID / Resend id
  error?: string
  at: number
  retryCount: number
}

// ── Derived payment status (for display + bookkeeping) ───────────────────────
export type PaymentSummaryStatus = 'unpaid' | 'deposit_paid' | 'partially_paid' | 'paid_in_full'

export const PAYMENT_SUMMARY_LABEL: Record<PaymentSummaryStatus, string> = {
  unpaid: 'Unpaid',
  deposit_paid: 'Deposit Paid',
  partially_paid: 'Partially Paid',
  paid_in_full: 'Paid in Full',
}

// A photo attached to an invoice (stored in Vercel Blob; we keep the URL + label).
export type InvoicePhoto = { url: string; name?: string }

// ── Booking record ───────────────────────────────────────────────────────────
export type Booking = {
  token: string                // secure random — the customer link key
  bookingNumber: string        // human code, e.g. JK-B-1042

  // Customer
  customerName: string
  customerPhone?: string
  customerEmail?: string

  // Customer communications / reply-driven automation (added with the message log)
  automationPaused?: boolean    // true once the customer replies — cron skips nagging reminders
  lastCustomerReplyAt?: number  // epoch ms of the most recent inbound reply

  // Invoice
  invoiceNumber?: string
  invoiceDate?: string         // display string, e.g. "June 16, 2026"
  serviceType: ServiceType
  pickupAddress?: string
  dropoffAddress?: string
  jobSiteAddress?: string
  description?: string
  items: string[]
  invoicePhotos?: InvoicePhoto[]   // photos attached to the invoice (Blob URLs)
  jobUnits?: number                // size weight for scheduling capacity (1=small … 4=multi-truck)
  invoiceAmountCents: number
  discountCents?: number       // promo/admin discount off the invoice (0 = none)
  promoCode?: string           // code applied, for display/audit
  depositAmountCents: number
  amountPaidCents: number      // sum of confirmed payments applied to invoice
  collectInPerson?: boolean    // hide online payment on the link (balance collected in person)

  // Job detail (display only)
  crewSize?: number
  estimatedHours?: number

  // Scheduling (Option 2 — customer picks date + window from allowed sets)
  availableDates: string[]     // ISO yyyy-mm-dd
  availableWindows: string[]   // labels, e.g. "8am–10am"
  selectedDate?: string
  selectedWindow?: string

  // Customer-provided access details
  customerNotes?: string
  gateCode?: string
  parkingNotes?: string
  accessNotes?: string
  specialInstructions?: string

  // Cancellation / refund agreement
  agreementAccepted?: boolean
  agreementAcceptedAt?: number
  agreementPolicyVersion?: number
  agreementIp?: string
  agreementUserAgent?: string

  // How the booking was created — 'online' = self-service instant/deposit hold flow,
  // 'admin' = created in the admin. Used to scope the abandoned-hold cleanup.
  source?: 'online' | 'admin'

  // Attribution captured at booking time (UTM / referrer / referral code).
  leadSource?: string
  marketingSource?: string
  referralSource?: string

  // Idempotency: the client-supplied key that created this booking. A retry with
  // the same key returns this booking instead of creating a duplicate.
  idempotencyKey?: string

  // Structured, attributed audit trail + owner-notification delivery ledger.
  events?: BookingEvent[]
  notifications?: NotificationAttempt[]

  // Secure replacement-upload grant issued when a Zelle proof is rejected — the
  // customer can upload a new screenshot via a one-time token without a new booking.
  replacementUpload?: { token: string; paymentId: string; at: number; usedAt?: number }

  // Internal (never exposed to the customer)
  internalNotes?: string
  communications?: CommunicationLog[]   // outbound texts/emails sent from the admin
  assignedTo?: string          // lead crew/rep assigned to the job (shown to customer)
  assignedHelper?: string      // helper / second rep (shown to customer)
  disposalEstimateCents?: number // estimated dump/disposal cost (from the quote)
  disposalActualCents?: number   // actual disposal cost entered after the job
  aiEstimate?: StoredAiEstimate  // AI photo analysis + deterministic pricing + decision (internal)
  loyaltyCode?: string         // 10% off code issued when paid in full (reuse/referral)
  archived?: boolean           // hidden from the default list (soft delete)
  archivedAt?: number
  // Owner-controlled SANDBOX record: never counts toward revenue/analytics/KPIs,
  // never sends automatic customer comms, badged everywhere. Set by an owner only.
  isTest?: boolean
  testMarkedBy?: string        // who flagged it as test
  testMarkedAt?: number

  // Status + payments
  status: BookingStatus
  payments: Payment[]

  // Confirmation tracking (chargeback evidence)
  confirmationLinkSentAt?: number
  confirmationLinkSentBy?: string
  customerViewedAt?: number
  customerTimeVerifiedAt?: number
  customerConfirmedAt?: number

  // Automated-reminder dedupe stamps (set by the daily cron; one-shot each)
  reminders?: {
    recoverySentAt?: number      // "finish confirming your booking" nudge
    paymentSentAt?: number       // unpaid-balance reminder
    dayBeforeSentAt?: number     // "your service is tomorrow"
    reviewRequestSentAt?: number // post-completion review ask
  }

  // Self-service rescheduling
  rescheduleCount?: number
  rescheduleRequest?: { requestedDate?: string; note?: string; at: number }

  // Multi-day / job continuation (work started, return trip needed to finish).
  // NOT a cancellation — the same booking, balance, and payments carry over.
  continuation?: {
    continuedAt: number
    originalServiceDate?: string   // the date work was started (for delay reporting)
    reason?: string
    completedToday?: string
    remainingWork?: string
    returnDate?: string            // yyyy-mm-dd — the proposed return date
    returnWindow?: string
    customerNotified?: boolean
    // Customer confirmation of the proposed return visit (reset whenever ops
    // saves a new return date — a fresh proposal needs a fresh confirmation).
    customerConfirmedReturn?: boolean
    customerConfirmedReturnAt?: number
    // Customer asked for a different return date instead of confirming.
    returnChangeRequest?: { requestedDate?: string; note?: string; at: number }
    notes?: string
  }

  // Lifecycle timestamps
  createdAt: number
  updatedAt: number
  confirmedAt?: number
  completedAt?: number
  cancelledAt?: number
}

// ── Redis keys ───────────────────────────────────────────────────────────────
const KEY_PREFIX = 'bk:'
const KEY_NUM = 'bk:num:'        // bk:num:{bookingNumber} -> token
const KEY_INDEX = 'bk:index'     // sorted set, score=updatedAt, member=token
const KEY_COUNTER = 'bk:counter' // booking-number sequence
const KEY_INV_COUNTER = 'bk:invcounter' // invoice-number sequence

// ── Tokens + numbers ─────────────────────────────────────────────────────────
export function generateToken(): string {
  // 64 hex chars of CSPRNG entropy — unguessable, safe to put in a URL.
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}

// NOTE ON THE MISSING FALLBACK.
// These used to fall back to `Date.now() % 100000` when Redis was unreachable. That
// number can collide with a real sequential id, and the caller then writes
// `bk:num:{n}` over an existing booking's token mapping — quietly pointing a
// customer-facing number at somebody else's booking. A failed INCR must be loud:
// let it throw, the request 500s, and the customer retries. A duplicate id is worse
// than a failed booking.
export async function nextBookingNumber(): Promise<string> {
  const n = await redis.incr(KEY_COUNTER)
  return `JK-B-${1000 + n}`
}

export async function nextInvoiceNumber(): Promise<string> {
  const n = await redis.incr(KEY_INV_COUNTER)
  return `JK-INV-${1000 + n}`
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function getBookingByToken(token: string): Promise<Booking | null> {
  if (!token || !/^[a-f0-9]{16,}$/i.test(token)) return null
  const raw = await redis.get(`${KEY_PREFIX}${token}`)
  if (!raw) return null
  try { return normalize(JSON.parse(raw) as Booking) } catch { return null }
}

export async function getBookingByNumber(bookingNumber: string): Promise<Booking | null> {
  const num = bookingNumber.trim().toUpperCase()
  if (!num) return null
  const token = await redis.get(`${KEY_NUM}${num}`)
  if (!token) return null
  return getBookingByToken(token)
}

/** Owner-controlled sandbox record — excluded from all business analytics/comms. */
export const isTestBooking = (b: Pick<Booking, 'isTest'>): boolean => !!b.isTest

export async function saveBooking(b: Booking): Promise<void> {
  b.updatedAt = Date.now()
  await redis.set(`${KEY_PREFIX}${b.token}`, JSON.stringify(b))
  await redis.set(`${KEY_NUM}${b.bookingNumber.toUpperCase()}`, b.token)
  await redis.zadd(KEY_INDEX, b.updatedAt, b.token)
}

export async function deleteBooking(token: string): Promise<void> {
  const b = await getBookingByToken(token)
  await redis.del(`${KEY_PREFIX}${token}`)
  if (b) await redis.del(`${KEY_NUM}${b.bookingNumber.toUpperCase()}`)
  await redis.zrem(KEY_INDEX, token)
}

export async function listBookings(limit = 500): Promise<Booking[]> {
  const tokens = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!tokens.length) return []
  const raws = await Promise.all(tokens.map(t => redis.get(`${KEY_PREFIX}${t}`)))
  return raws
    .filter(Boolean)
    .map(r => { try { return normalize(JSON.parse(r as string) as Booking) } catch { return null } })
    .filter((b): b is Booking => b !== null)
}

// Backfill defaults so older records never crash newer code.
function normalize(b: Booking): Booking {
  b.items = Array.isArray(b.items) ? b.items : []
  b.payments = Array.isArray(b.payments) ? b.payments : []
  b.availableDates = Array.isArray(b.availableDates) ? b.availableDates : []
  b.availableWindows = Array.isArray(b.availableWindows) ? b.availableWindows : []
  if (b.invoicePhotos !== undefined) b.invoicePhotos = sanitizePhotos(b.invoicePhotos)
  b.amountPaidCents = b.amountPaidCents || 0
  b.depositAmountCents = b.depositAmountCents || 0
  b.invoiceAmountCents = b.invoiceAmountCents || 0
  return b
}

// Validate/clean invoice-photo input from the admin form. Only accepts objects
// with an https Blob URL; caps the count and label length so a bad payload can't
// bloat the record.
export function sanitizePhotos(v: unknown): InvoicePhoto[] {
  if (!Array.isArray(v)) return []
  const out: InvoicePhoto[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const url = String((item as { url?: unknown }).url ?? '').trim()
    if (!/^https:\/\/\S+$/i.test(url) || url.length > 1000) continue
    const rawName = (item as { name?: unknown }).name
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 120) : undefined
    out.push(name ? { url, name } : { url })
    if (out.length >= 20) break
  }
  return out
}

// The date a crew should actually show up: the return date for a continued job,
// otherwise the scheduled/selected date. Used by the calendar + availability.
export function effectiveServiceDate(b: Booking): string {
  if (b.status === 'continued' && b.continuation?.returnDate) return b.continuation.returnDate
  return b.selectedDate || (b.availableDates?.length === 1 ? b.availableDates[0] : '')
}

// Hours from `now` until a booking's service starts (≈8am Central on the service
// date). Returns Infinity when no date is set yet.
export function hoursUntilService(b: Booking, now: number): number {
  const d = b.selectedDate || (b.availableDates?.length === 1 ? b.availableDates[0] : '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return Infinity
  const [y, m, day] = d.split('-').map(Number)
  const start = Date.UTC(y, m - 1, day, 13) // ~8am Central
  return (start - now) / 3_600_000
}

// Cancellation/refund tier per the policy (deposit handling by notice given).
export function cancellationTier(hoursUntil: number, completed: boolean): { tier: string; label: string; depositRefundPct: number } {
  if (completed) return { tier: 'completed', label: 'This service is already complete and cannot be cancelled online.', depositRefundPct: 0 }
  if (hoursUntil >= 72) return { tier: '72h+', label: 'Full credit toward a future service, or a refund of your deposit minus any card-processing fee.', depositRefundPct: 100 }
  if (hoursUntil >= 48) return { tier: '48-72h', label: '50% of your deposit refunded, or full credit toward a future service.', depositRefundPct: 50 }
  return { tier: 'under-48h', label: 'Within 48 hours of service, deposits are non-refundable per our policy. You can reschedule instead.', depositRefundPct: 0 }
}

// ── Derivations ──────────────────────────────────────────────────────────────
// Invoice the customer actually owes = gross invoice minus any discount/promo.
// Centralizing here keeps balance + paid-in-full logic correct everywhere.
export function netInvoiceCents(b: Booking): number {
  return Math.max(0, b.invoiceAmountCents - (b.discountCents || 0))
}

export function balanceDueCents(b: Booking): number {
  return Math.max(0, netInvoiceCents(b) - b.amountPaidCents)
}

export function paymentSummaryStatus(b: Booking): PaymentSummaryStatus {
  const paid = b.amountPaidCents
  const net = netInvoiceCents(b)
  if (paid <= 0) return 'unpaid'
  if (paid >= net && net > 0) return 'paid_in_full'
  if (b.depositAmountCents > 0 && paid >= b.depositAmountCents) return 'deposit_paid'
  return 'partially_paid'
}

// Sum of confirmed payments applied to the invoice. Source of truth for amountPaid.
export function confirmedPaidCents(b: Booking): number {
  return b.payments
    .filter(p => p.status === 'confirmed')
    .reduce((s, p) => s + p.netCents, 0)
}

export function confirmedFeesCents(b: Booking): number {
  return b.payments
    .filter(p => p.status === 'confirmed')
    .reduce((s, p) => s + p.feeCents, 0)
}

// Recompute amountPaid from confirmed payments and advance status sensibly.
// Time verification is ALWAYS required for full confirmation — payment alone
// never confirms a booking.
export function recompute(b: Booking): Booking {
  b.amountPaidCents = confirmedPaidCents(b)
  const paidSomething = b.amountPaidCents > 0
  const timeVerified = !!b.customerTimeVerifiedAt && !!b.selectedDate && !!b.selectedWindow
  // A Zelle screenshot uploaded and awaiting owner review (not yet money in hand).
  const pendingZelleProof = b.payments.some(p => p.method === 'zelle' && p.status === 'sent_by_customer' && !!p.proofPath)

  // Never downgrade terminal/active workflow states. Closed states + the mid-job
  // states 'in_progress'/'continued' are human-set — payment/time changes must not
  // revert them.
  if (!isClosed(b) && b.status !== 'in_progress' && b.status !== 'continued') {
    if (timeVerified && paidSomething) {
      b.status = 'confirmed'
      if (!b.confirmedAt) b.confirmedAt = Date.now()
      if (!b.customerConfirmedAt) b.customerConfirmedAt = b.confirmedAt
    } else if (pendingZelleProof && !paidSomething) {
      // Proof is in, but a human must verify it before the booking is Confirmed.
      b.status = 'pending_zelle_verification'
    } else if (timeVerified) {
      b.status = 'time_verified'
    } else if (paidSomething && rank(b.status) < rank('payment_received')) {
      b.status = 'payment_received'
    }
  }
  return b
}

// ── Audit + notification ledger helpers (pure mutations on the record) ───────
const MAX_EVENTS = 200
const MAX_NOTIFICATIONS = 100

export function pushBookingEvent(b: Booking, e: Omit<BookingEvent, 'at'> & { at?: number }): BookingEvent {
  const entry: BookingEvent = { at: e.at ?? Date.now(), actor: e.actor, action: e.action, result: e.result, meta: e.meta }
  b.events = [...(b.events ?? []), entry].slice(-MAX_EVENTS)
  return entry
}

export function recordNotificationAttempt(b: Booking, a: Omit<NotificationAttempt, 'id' | 'at'> & { id?: string; at?: number }): NotificationAttempt {
  const entry: NotificationAttempt = {
    id: a.id ?? crypto.randomUUID(),
    kind: a.kind, channel: a.channel, to: a.to,
    status: a.status, providerId: a.providerId, error: a.error,
    at: a.at ?? Date.now(), retryCount: a.retryCount ?? 0,
  }
  b.notifications = [...(b.notifications ?? []), entry].slice(-MAX_NOTIFICATIONS)
  return entry
}

// Most recent attempt of a given kind — used to dedupe (don't re-send unless forced).
export function lastNotification(b: Booking, kind: NotificationKind): NotificationAttempt | undefined {
  return (b.notifications ?? []).filter(n => n.kind === kind).at(-1)
}

const STATUS_ORDER: BookingStatus[] = [
  'quote_received', 'pending_payment', 'pending_zelle_verification', 'payment_received', 'booking_created',
  'confirmation_link_sent', 'customer_viewed', 'time_verification_pending',
  'time_verified', 'confirmed', 'in_progress', 'continued', 'completed',
]
function rank(s: BookingStatus): number {
  const i = STATUS_ORDER.indexOf(s)
  return i === -1 ? 0 : i
}

// ── Money helpers ────────────────────────────────────────────────────────────
export function fmtUSD(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function dollarsToCents(v: string | number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''))
  if (!isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

// ── Customer-safe projection ─────────────────────────────────────────────────
// Strips internal notes and the agreement audit trail (IP / UA) before sending
// a booking to the browser.
export type CustomerBooking = Omit<Booking,
  'internalNotes' | 'agreementIp' | 'agreementUserAgent' | 'payments' | 'disposalEstimateCents' | 'disposalActualCents'
  | 'aiEstimate' | 'events' | 'notifications' | 'replacementUpload' | 'idempotencyKey'> & {
  balanceDueCents: number
  paymentSummary: PaymentSummaryStatus
  payments: Array<Pick<Payment, 'type' | 'method' | 'status' | 'amountCents' | 'feeCents' | 'totalChargedCents' | 'createdAt' | 'confirmedAt'> & { hasProof: boolean }>
}

export function customerView(b: Booking): CustomerBooking {
  // Strip everything internal: audit fields, full payment detail (incl. sealed proof
  // paths), the owner-notification ledger, and the disposal cost / margin numbers.
  const {
    internalNotes: _i, agreementIp: _ip, agreementUserAgent: _ua, payments,
    disposalEstimateCents: _de, disposalActualCents: _da, aiEstimate: _ai,
    events: _ev, notifications: _no, replacementUpload: _ru, idempotencyKey: _ik, ...rest
  } = b
  void _i; void _ip; void _ua; void _de; void _da; void _ai; void _ev; void _no; void _ru; void _ik
  return {
    ...rest,
    balanceDueCents: balanceDueCents(b),
    paymentSummary: paymentSummaryStatus(b),
    payments: payments.map(p => ({
      type: p.type, method: p.method, status: p.status,
      amountCents: p.amountCents, feeCents: p.feeCents, totalChargedCents: p.totalChargedCents,
      createdAt: p.createdAt, confirmedAt: p.confirmedAt,
      hasProof: !!p.proofPath,   // customer can see THAT they uploaded proof, never the path
    })),
  }
}
