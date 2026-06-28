import { redis } from './redis'

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
  | 'payment_received'
  | 'booking_created'
  | 'confirmation_link_sent'
  | 'customer_viewed'
  | 'time_verification_pending'
  | 'time_verified'
  | 'confirmed'
  | 'completed'
  | 'cancelled'

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  quote_received: 'Quote Received',
  pending_payment: 'Pending Payment',
  payment_received: 'Payment Received',
  booking_created: 'Booking Created',
  confirmation_link_sent: 'Confirmation Link Sent',
  customer_viewed: 'Customer Viewed',
  time_verification_pending: 'Awaiting Time Verification',
  time_verified: 'Time Verified',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
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
  createdAt: number
  confirmedAt?: number
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

  // Internal (never exposed to the customer)
  internalNotes?: string
  assignedTo?: string          // lead crew/rep assigned to the job (shown to customer)
  assignedHelper?: string      // helper / second rep (shown to customer)
  disposalEstimateCents?: number // estimated dump/disposal cost (from the quote)
  disposalActualCents?: number   // actual disposal cost entered after the job
  loyaltyCode?: string         // 10% off code issued when paid in full (reuse/referral)
  archived?: boolean           // hidden from the default list (soft delete)
  archivedAt?: number

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

export async function nextBookingNumber(): Promise<string> {
  let n: number
  try {
    n = await redis.incr(KEY_COUNTER)
  } catch {
    n = Date.now() % 100000
  }
  return `JK-B-${1000 + n}`
}

export async function nextInvoiceNumber(): Promise<string> {
  let n: number
  try {
    n = await redis.incr(KEY_INV_COUNTER)
  } catch {
    n = Date.now() % 100000
  }
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

  if (b.status !== 'cancelled' && b.status !== 'completed') {
    if (timeVerified && paidSomething) {
      b.status = 'confirmed'
      if (!b.confirmedAt) b.confirmedAt = Date.now()
      if (!b.customerConfirmedAt) b.customerConfirmedAt = b.confirmedAt
    } else if (timeVerified) {
      b.status = 'time_verified'
    } else if (paidSomething && rank(b.status) < rank('payment_received')) {
      b.status = 'payment_received'
    }
  }
  return b
}

const STATUS_ORDER: BookingStatus[] = [
  'quote_received', 'pending_payment', 'payment_received', 'booking_created',
  'confirmation_link_sent', 'customer_viewed', 'time_verification_pending',
  'time_verified', 'confirmed', 'completed',
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
export type CustomerBooking = Omit<Booking, 'internalNotes' | 'agreementIp' | 'agreementUserAgent' | 'payments' | 'disposalEstimateCents' | 'disposalActualCents'> & {
  balanceDueCents: number
  paymentSummary: PaymentSummaryStatus
  payments: Array<Pick<Payment, 'type' | 'method' | 'status' | 'amountCents' | 'feeCents' | 'totalChargedCents' | 'createdAt' | 'confirmedAt'>>
}

export function customerView(b: Booking): CustomerBooking {
  // Strip everything internal: audit fields, full payment detail, and the disposal
  // cost / margin numbers (never expose those to the customer).
  const { internalNotes: _i, agreementIp: _ip, agreementUserAgent: _ua, payments, disposalEstimateCents: _de, disposalActualCents: _da, ...rest } = b
  void _i; void _ip; void _ua; void _de; void _da
  return {
    ...rest,
    balanceDueCents: balanceDueCents(b),
    paymentSummary: paymentSummaryStatus(b),
    payments: payments.map(p => ({
      type: p.type, method: p.method, status: p.status,
      amountCents: p.amountCents, feeCents: p.feeCents, totalChargedCents: p.totalChargedCents,
      createdAt: p.createdAt, confirmedAt: p.confirmedAt,
    })),
  }
}
