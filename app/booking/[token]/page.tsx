import Link from 'next/link'
import type { Metadata } from 'next'
import { getBookingByToken, customerView } from '../../lib/bookings'
import { getCurrentPolicy, getPolicyVersion } from '../../lib/policy'
import BookingClient from './BookingClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your Booking — J Kiss LLC',
  robots: { index: false, follow: false },
}

export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let booking
  try {
    booking = await getBookingByToken(token)
  } catch {
    booking = null
  }

  if (!booking) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--bg)' }}>
        <div className="glass-card p-10 text-center max-w-md" style={{ borderRadius: '20px' }}>
          <p className="text-2xl font-black text-white mb-3" style={{ letterSpacing: '-0.02em' }}>Booking not found</p>
          <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
            This booking link is invalid or has expired. Please double-check the link, or contact us and we&apos;ll resend it.
          </p>
          <div className="flex justify-center gap-3 flex-wrap">
            <a href="tel:+18179094312" className="btn">Call (817) 909-4312</a>
            <Link href="/" className="btn-ghost">← Home</Link>
          </div>
        </div>
      </main>
    )
  }

  const policy = booking.agreementPolicyVersion
    ? (await getPolicyVersion(booking.agreementPolicyVersion)) ?? (await getCurrentPolicy())
    : await getCurrentPolicy()

  return (
    <BookingClient
      token={token}
      initialBooking={customerView(booking)}
      policy={{ version: policy.version, text: policy.text }}
    />
  )
}
