import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service — J Kiss LLC',
  description: 'J Kiss LLC terms of service.',
  alternates: { canonical: 'https://www.jkissllc.com/terms' },
}

const EFFECTIVE = 'June 19, 2026'

export default function TermsPage() {
  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
          J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
        </Link>
        <Link href="/" className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>← Home</Link>
      </header>

      <section className="pt-32 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="label mb-6">Terms</div>
          <h1 className="text-4xl font-black text-white mb-3" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>Terms of Service</h1>
          <p className="text-sm mb-10" style={{ color: 'var(--muted)' }}>Effective {EFFECTIVE} · J Kiss LLC · US DOT 3484556 · MC 01155352</p>

          <div className="space-y-8" style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
            <Block title="Services">
              <p>J Kiss LLC provides moving, delivery, junk removal, eviction/property cleanout, and related services in the Dallas–Fort Worth area. Quotes are estimates; final pricing may depend on actual job conditions, access, volume, and scheduling.</p>
            </Block>

            <Block title="Bookings, Deposits &amp; Payment">
              <p>A deposit may be required to reserve your service date and resources. Balances are due as stated on your invoice or booking. We accept card payments (processed by Stripe; card payments include a processing fee), as well as Zelle and Apple Pay/Cash. You are responsible for providing accurate addresses, inventory, and access details; additional charges may apply if actual conditions differ materially from what was provided.</p>
            </Block>

            <Block title="Cancellation &amp; Refund Policy">
              <p>Bookings are subject to our Cancellation &amp; Refund Policy, which you review and accept when confirming a booking. It governs deposits, cancellations, rescheduling, weather delays, completed services, and company cancellations. The version in effect at the time you accept it applies to your booking.</p>
            </Block>

            <Block title="Text Messaging">
              <p>By providing your phone number you may receive transactional, service-related text messages from us. Message and data rates may apply; reply STOP to opt out or HELP for help. See our <Link href="/privacy" style={{ color: 'var(--red)' }}>Privacy Policy</Link> for details on our SMS program.</p>
            </Block>

            <Block title="Right to Refuse Service">
              <p>J Kiss LLC reserves the right to refuse or discontinue service due to unsafe conditions, hazardous materials, illegal activity, threats or violence, dangerous access conditions, or any situation that places workers, equipment, or property at risk.</p>
            </Block>

            <Block title="Limitation of Liability">
              <p>To the maximum extent permitted by law, J Kiss LLC&apos;s liability arising from services is limited to the amount paid for the service in question. We are not liable for indirect or consequential damages.</p>
            </Block>

            <Block title="Contact">
              <p>J Kiss LLC · 2901 East Mayfield Road #2103, Grand Prairie, TX 75052 · (817) 909‑4312 · info@jkissllc.com</p>
            </Block>
          </div>
        </div>
      </section>
    </main>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-lg font-black text-white mb-2" style={{ letterSpacing: '-0.02em' }}>{title}</h2>
      {children}
    </div>
  )
}
