import Link from 'next/link'
import { COMPANY } from '../../lib/company';
import type { Metadata } from 'next'
import { getBookingByToken, customerView } from '../../lib/bookings'
import { getCurrentPolicy, getPolicyVersion } from '../../lib/policy'
import BookingClient from './BookingClient'
import { withPublicTokenScope } from '../../lib/platform/tenancy/public-token-scope'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `Your Booking — ${COMPANY.legalName}`,
  robots: { index: false, follow: false },
}

export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // WAVE 6D-C. A server component is not a route handler, so it cannot use
  // withPublicTokenRoute — and a customer following an emailed link has no session.
  // This page therefore read `bk:*` with NO tenant context, and because the read was
  // already wrapped in try/catch it did not error under TENANCY_ENABLED=true: it
  // rendered "Booking not found" for EVERY valid customer link. A crash would have
  // been obvious; this looked like a legitimate answer.
  //
  // The token's platform binding now supplies the tenant BEFORE any tenant-owned read.
  // resourceId is asserted explicitly because a booking token binds to itself, so a
  // token that names some other resource must not be honoured here.
  //
  // Refusal returns null and falls through to the same "not found" card — an unknown,
  // malformed, revoked, wrong-surface, cross-tenant or unbound-under-tenancy token is
  // indistinguishable from a genuinely missing booking, so nothing leaks.
  const loaded = await withPublicTokenScope(
    token,
    'booking',
    async () => {
      const b = await getBookingByToken(token)
      if (!b) return null
      // Policy is tenant-owned and read INSIDE the same scope, so it can never fall
      // back to another tenant's — or to the global default — for a real booking.
      const p = b.agreementPolicyVersion
        ? (await getPolicyVersion(b.agreementPolicyVersion)) ?? (await getCurrentPolicy())
        : await getCurrentPolicy()
      return { booking: b, policy: p }
    },
    () => null,
  )

  if (!loaded) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--bg)' }}>
        <div className="glass-card p-10 text-center max-w-md" style={{ borderRadius: '20px' }}>
          <p className="text-2xl font-black text-white mb-3" style={{ letterSpacing: '-0.02em' }}>Booking not found</p>
          <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
            This booking link is invalid or has expired. Please double-check the link, or contact us and we&apos;ll resend it.
          </p>
          <div className="flex justify-center gap-3 flex-wrap">
            <a href={"tel:" + COMPANY.phoneE164} className="btn">Call (817) 909-4312</a>
            <Link href="/" className="btn-ghost">← Home</Link>
          </div>
        </div>
      </main>
    )
  }

  const { booking, policy } = loaded

  return (
    <BookingClient
      token={token}
      initialBooking={customerView(booking)}
      policy={{ version: policy.version, text: policy.text }}
    />
  )
}
