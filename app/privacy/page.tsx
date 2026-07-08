import Link from 'next/link'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: `Privacy Policy — ${COMPANY.legalName}`,
  description: `${COMPANY.legalName} privacy policy, including our SMS/text messaging program terms.`,
  alternates: { canonical: `${COMPANY.siteUrl}/privacy` },
}

const EFFECTIVE = 'June 19, 2026'

export default function PrivacyPage() {
  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
          {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
        </Link>
        <Link href="/" className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>← Home</Link>
      </header>

      <section className="pt-32 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="label mb-6">Privacy</div>
          <h1 className="text-4xl font-black text-white mb-3" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>Privacy Policy</h1>
          <p className="text-sm mb-10" style={{ color: 'var(--muted)' }}>Effective {EFFECTIVE} · {COMPANY.legalName} · 2901 East Mayfield Road #2103, Grand Prairie, TX 75052 · (817) 909‑4312 · info@jkissllc.com</p>

          <div className="space-y-8" style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
            <Block title="Overview">
              <p>{COMPANY.legalName} (&quot;J Kiss,&quot; &quot;we,&quot; &quot;us&quot;) provides moving, delivery, junk removal, and eviction/property cleanout services across the Dallas–Fort Worth metroplex. This policy explains what information we collect, how we use it, and your choices — including our text-messaging (SMS) program.</p>
            </Block>

            <Block title="Information We Collect">
              <ul className="list-disc pl-5 space-y-1">
                <li>Contact details you provide (name, phone number, email, company).</li>
                <li>Service details (pickup/drop-off or job-site addresses, item lists, scheduling preferences, access notes).</li>
                <li>Booking and payment records (invoice amounts, payments, status). Card payments are processed by Stripe; we do not store full card numbers.</li>
                <li>Basic technical data (e.g., IP address and browser) when you confirm a booking, used to maintain records and prevent fraud.</li>
              </ul>
            </Block>

            <Block title="How We Use Information">
              <ul className="list-disc pl-5 space-y-1">
                <li>To prepare quotes, schedule and perform services, and process payments.</li>
                <li>To send booking and service-related communications (confirmations, scheduling, updates, receipts).</li>
                <li>To maintain business records and comply with legal obligations.</li>
              </ul>
            </Block>

            <Block title="SMS / Text Messaging Program">
              <p>If you provide your mobile number, you may receive transactional text messages from {COMPANY.legalName} related to a service you requested or booked — including booking confirmation links, service-date and arrival-window verification, payment receipts, and job-completion notices.</p>
              <ul className="list-disc pl-5 space-y-1 mt-3">
                <li><strong className="text-white">How you opt in:</strong> by providing your mobile number to us when you request a quote or book a service — through our online form at <Link href="/quote" style={{ color: 'var(--red)' }}>jkissllc.com/quote</Link>, by phone, or in person — and agreeing to receive service-related texts.</li>
                <li><strong className="text-white">Message types &amp; frequency:</strong> transactional messages tied to your specific job. Frequency varies by your booking activity. We do not send marketing texts.</li>
                <li><strong className="text-white">Opt out:</strong> reply <strong className="text-white">STOP</strong> to any message to stop receiving texts. Reply <strong className="text-white">HELP</strong> for help, or contact us at (817) 909‑4312.</li>
                <li><strong className="text-white">Cost:</strong> message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</li>
              </ul>
              <p className="mt-3"><strong className="text-white">No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</strong> Information sharing with subcontractors that support our services (such as our messaging provider, Twilio) is solely to deliver the messages you requested. Text-messaging originator opt-in data and consent are never shared with any third parties for their own use.</p>
            </Block>

            <Block title="How We Share Information">
              <p>We share information only with service providers that help us operate (e.g., Stripe for payments, Twilio for SMS, Resend for email, and crews/subcontractors performing your job), and when required by law. We do not sell your personal information.</p>
            </Block>

            <Block title="Data Retention &amp; Security">
              <p>We retain booking and payment records as needed for business, tax, and legal purposes, and to resolve disputes. We use reasonable safeguards to protect your information.</p>
            </Block>

            <Block title="Your Choices">
              <p>You may request access to or correction of your information, or opt out of texts (reply STOP) or emails at any time, by contacting info@jkissllc.com or (817) 909‑4312.</p>
            </Block>

            <Block title="Contact Us">
              <p>{COMPANY.legalName} · 2901 East Mayfield Road #2103, Grand Prairie, TX 75052 · (817) 909‑4312 · info@jkissllc.com</p>
              <p className="mt-2">See also our <Link href="/terms" style={{ color: 'var(--red)' }}>Terms of Service</Link>.</p>
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
