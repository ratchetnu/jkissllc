// Sprint 5 — deterministic customer lookup.
//
// There is deliberately NO "list all customers" endpoint: `customers.ts` maintains
// identity indexes (`cust:email:*`, `cust:phone:*`) but no customer index, so a
// listing would be a scan pretending to be a directory. Lookup is by identifier —
// which is also the only way the record is addressable in the data model.
//
// This endpoint is the surface where the resolver's THREE outcomes become visible
// to an operator, including the one that matters most: `conflict`, where email and
// phone resolve to two different customers. That is surfaced for manual review
// rather than silently resolved, because picking a side would join one person's
// payment history to another's.
//
// PERMISSION: `customers:view` (admin + manager). Read-only, tenant-scoped.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { getBookingByToken } from '../../../../lib/bookings'
import { getCustomer } from '../../../../lib/customers'
import { redis } from '../../../../lib/redis'
import { resolveCustomerLink } from '../../../../lib/customer-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: string | null, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'customers:view')
  if (who instanceof NextResponse) return who

  const q = req.nextUrl.searchParams
  let email = S(q.get('email'), 200)
  let phone = S(q.get('phone'), 40)
  const bookingToken = S(q.get('bookingToken'), 120)

  try {
    // Looking up FROM a booking is the common path: an operator is on a job and
    // wants that customer's history. The identifiers come from the record, never
    // from the query string, so the answer matches what the timeline will join.
    if (bookingToken) {
      const b = await getBookingByToken(bookingToken)
      if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      email = b.customerEmail ?? ''
      phone = b.customerPhone ?? ''
    }

    if (!email && !phone) {
      return NextResponse.json(
        { error: 'invalid', message: 'Provide an email, a phone number, or a booking token.' },
        { status: 400 },
      )
    }

    const link = await resolveCustomerLink({ email, phone }, redis)

    if (link.kind === 'linked') {
      const customer = await getCustomer(link.customerId)
      if (!customer) {
        // The index points at a record that is gone. Report it as unlinked rather
        // than handing back an id that 404s on the next click.
        return NextResponse.json({ ok: true, link: { kind: 'unlinked', reason: 'no_customer_record' } })
      }
      return NextResponse.json({ ok: true, link, customer })
    }

    if (link.kind === 'conflict') {
      // Give the reviewer both sides by name, or this is unactionable.
      const [a, b] = await Promise.all([
        getCustomer(link.emailCustomerId),
        getCustomer(link.phoneCustomerId),
      ])
      return NextResponse.json({
        ok: true,
        link,
        review: {
          reason: 'email_and_phone_resolve_to_different_customers',
          email: a ? { id: a.id, name: a.name, email: a.email, phone: a.phone } : null,
          phone: b ? { id: b.id, name: b.name, email: b.email, phone: b.phone } : null,
        },
      })
    }

    return NextResponse.json({ ok: true, link })
  } catch {
    return NextResponse.json(
      { error: 'unavailable', message: 'Could not look up that customer right now.' },
      { status: 503 },
    )
  }
})
