import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { getShipment, normalizeBol, STATUS_LABEL, STATUS_DESC } from '../../../lib/shipments'
import { rateLimit } from '../../../lib/rate-limit'

// Normalizes a name for the second-factor comparison: lowercased, trimmed,
// internal whitespace collapsed. Applied to both the submitted name and the
// stored customerName so minor spacing/casing differences still match.
function normalizeName(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ')
}

export const POST = withTenantRoute(async (req: NextRequest) => {
  // BOL/PO numbers are short, sequential and guessable, so tracking cannot be
  // BOL-only. Rate-limit per IP first so the second-factor check below can't
  // be brute-forced by spraying name guesses.
  if (await rateLimit(req, 'ship-lookup', 20, 60_000)) {
    return NextResponse.json({ error: 'Too many lookups. Please wait a minute and try again.' }, { status: 429 })
  }

  const { bol, name } = await req.json()
  if (typeof bol !== 'string' || !bol.trim()) {
    return NextResponse.json({ error: 'BOL or PO number is required.' }, { status: 400 })
  }
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'The customer or company name on the booking is required.' }, { status: 400 })
  }
  const norm = normalizeBol(bol)
  if (!norm) return NextResponse.json({ error: 'Invalid BOL/PO format.' }, { status: 400 })

  try {
    const s = await getShipment(norm)

    // Ownership check: the caller must also know the customer/company name on
    // the booking — something the real customer knows but an enumerator
    // scanning BOL numbers does not. A missing BOL, a shipment with no name on
    // file, and a wrong name ALL return the identical { found: false } so the
    // endpoint cannot be used to discover which BOL numbers exist.
    if (!s || !s.customerName || normalizeName(name) !== normalizeName(s.customerName)) {
      return NextResponse.json({ found: false, bol: norm })
    }

    // Public-safe response — strip ops-only fields
    return NextResponse.json({
      found: true,
      bol: s.bol,
      status: s.status,
      statusLabel: STATUS_LABEL[s.status],
      statusDesc: s.notes || STATUS_DESC[s.status],
      pickupCity: s.pickupCity ?? null,
      deliveryCity: s.deliveryCity ?? null,
      updatedAt: s.updatedAt,
      dispatchedAt: s.dispatchedAt ?? null,
      deliveredAt: s.deliveredAt ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'lookup failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') {
      return NextResponse.json({ error: 'Tracking system is not configured yet.' }, { status: 503 })
    }
    console.error('[shipments/lookup]', err)
    return NextResponse.json({ error: 'Lookup failed.' }, { status: 500 })
  }
})
