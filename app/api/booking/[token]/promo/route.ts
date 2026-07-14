import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getBookingByToken, saveBooking, customerView, recompute, balanceDueCents } from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { getPromo, savePromo, validatePromo, normalizeCode } from '../../../../lib/promo'

// POST /api/booking/[token]/promo — customer applies a promo code to their invoice.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  if (await rateLimit(req, 'bookingpromo', 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled') return NextResponse.json({ error: 'This booking has been cancelled.' }, { status: 409 })
  if (b.amountPaidCents > 0 || balanceDueCents(b) <= 0) {
    return NextResponse.json({ error: 'A code can only be applied before payment.' }, { status: 409 })
  }
  if (b.promoCode) return NextResponse.json({ error: 'A code is already applied to this invoice.' }, { status: 409 })

  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(body.code)
  if (!code) return NextResponse.json({ error: 'Enter a promo code.' }, { status: 400 })

  const promo = await getPromo(code)
  const v = validatePromo(promo, b.invoiceAmountCents, Date.now())
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  b.discountCents = v.discountCents
  b.promoCode = v.promo.code
  v.promo.uses += 1
  await savePromo(v.promo)
  recompute(b)
  await saveBooking(b)

  return NextResponse.json({ ok: true, booking: customerView(b), discountCents: v.discountCents })
})
