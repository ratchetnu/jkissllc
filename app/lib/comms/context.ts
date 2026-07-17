// The channel-agnostic, schema-agnostic adapter payload (Phase 2).
//
// `CommContext` is the ONLY thing templates.ts and service.ts read. It is a flat
// bag of already-resolved primitives — never a Booking, Route, or Invoice — so the
// communications layer stays decoupled from any (possibly unfinished) Operations
// schema. Callers translate their own records into this shape; adapters.ts provides
// ready-made bridges for the shapes that exist today.

export type CommContext = {
  // ── Recipient identity ──
  customerId?: string
  customerName?: string
  phone?: string            // any format; normalized to E.164 at send time
  email?: string

  // ── Linkage (any that are known; used for the ledger + history filters) ──
  jobId?: string
  bookingId?: string        // the booking token
  bookingNumber?: string    // e.g. JK-B-1042
  quoteId?: string
  invoiceNumber?: string    // e.g. JK-INV-1042 / JK-RI-1001

  // ── Scheduling ──
  dateText?: string         // pre-formatted, e.g. "Tue, Jul 22"
  windowText?: string       // e.g. "8:00 AM – 10:00 AM"
  address?: string

  // ── Assignment ──
  crewName?: string         // assigned crew display name

  // ── Money (pre-formatted strings — the layer never does currency math) ──
  amountText?: string       // e.g. "$240.00"
  balanceText?: string

  // ── Links ──
  bookingLink?: string
  invoiceLink?: string
  trackingLink?: string     // status/tracking page (ON_THE_WAY / ETA / ARRIVED)
  reviewLink?: string

  // ── Free-form ──
  etaText?: string          // e.g. "about 20 minutes" (ETA_UPDATED)
  note?: string             // ad-hoc addendum a template may append
}

// Which context fields carry PII vs. are safe to log/preview. Preview surfaces
// use SAMPLE_CONTEXT so no real customer data is needed to render a template.
export const SAMPLE_CONTEXT: Readonly<CommContext> = Object.freeze({
  customerId: 'sample',
  customerName: 'Jordan Sample',
  phone: '+15550001234',
  email: 'jordan@example.com',
  bookingId: 'sampletoken',
  bookingNumber: 'JK-B-1042',
  quoteId: 'JK-B-1042',
  invoiceNumber: 'JK-INV-1042',
  dateText: 'Tue, Jul 22',
  windowText: '8:00 AM – 10:00 AM',
  address: '2901 East Mayfield Rd, Grand Prairie, TX',
  crewName: 'Marcus & Team',
  amountText: '$240.00',
  balanceText: '$120.00',
  bookingLink: 'https://www.jkissllc.com/booking/sampletoken',
  invoiceLink: 'https://www.jkissllc.com/booking/sampletoken/receipt',
  trackingLink: 'https://www.jkissllc.com/track/JK-B-1042',
  reviewLink: 'https://g.page/r/jkissllc/review',
  etaText: 'about 20 minutes',
})

// Fill a partial context with the sample values so a preview always renders fully.
export function withSample(ctx?: Partial<CommContext>): CommContext {
  return { ...SAMPLE_CONTEXT, ...(ctx ?? {}) }
}
