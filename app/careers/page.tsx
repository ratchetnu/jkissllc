import Link from 'next/link'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import type { Metadata } from 'next'
import { POSITIONS, REQUIREMENTS, PAY_NOTICE, type Position } from '../lib/ats-config'

export const metadata: Metadata = {
  title: `Contractor Opportunities — Drivers & Helpers | ${COMPANY.legalName}`,
  description: `${COMPANY.legalName} is accepting independent-contractor applications for Drivers and Driver Helpers serving box-truck delivery, moving, appliance installation, and junk removal across DFW.`,
  alternates: { canonical: `${COMPANY.siteUrl}/careers` },
}

const ORDER: Position[] = ['driver', 'helper']

export default function CareersPage() {
  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Home</Link>
            <Link href="/careers/apply" className="btn" style={{ padding: '10px 20px', fontSize: '13px' }}>Apply Now</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="pt-32 pb-16 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="label mb-6" style={{ display: 'inline-block' }}>Contractor Opportunities in DFW</div>
          <h1 className="text-4xl md:text-6xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.04, fontFamily: 'var(--font-display)' }}>
            Get Paid to Move,<br /><span style={{ color: 'var(--red)' }}>Deliver &amp; Install.</span>
          </h1>
          <p className="text-lg md:text-xl mb-8 max-w-2xl mx-auto" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            {COMPANY.legalName}{' '}works with independent contractors on box-truck delivery, moving, appliance installation, and junk-removal projects across Dallas–Fort Worth.
          </p>
          <Link href="/careers/apply" className="btn" style={{ padding: '16px 40px', fontSize: 16 }}>Start Your Application →</Link>
          <p className="text-xs mt-4" style={{ color: 'rgba(255,255,255,.4)' }}>Takes about 10–15 minutes · No identity or tax documents are collected before approval</p>
        </div>
      </section>

      {/* Positions & pay */}
      <section className="pb-6 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-2 gap-5">
            {ORDER.map(pos => {
              const p = POSITIONS[pos]
              return (
                <div key={pos} className="glass-card p-8" style={{ borderRadius: 20, border: '1px solid rgba(224,0,42,.3)' }}>
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <h2 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.02em' }}>{p.title}</h2>
                    <div className="text-right">
                      <span className="text-3xl font-black tabular-nums" style={{ color: 'var(--red)' }}>${p.payPerDay}</span>
                      <span className="text-sm" style={{ color: 'var(--muted)' }}>/day</span>
                    </div>
                  </div>
                  <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--muted)' }}>Starting pay</p>
                  <p className="text-sm mb-5" style={{ color: 'var(--text)', lineHeight: 1.6 }}>{p.blurb}</p>
                  <Link href={`/careers/apply?position=${pos}`} className="btn-ghost" style={{ fontSize: 14 }}>Apply as {p.title} →</Link>
                </div>
              )
            })}
          </div>
          <div className="glass-card mt-5 p-5" style={{ borderRadius: 14, background: 'rgba(52,211,153,.06)', border: '1px solid rgba(52,211,153,.25)' }}>
            <p className="text-sm text-center" style={{ color: '#a7f3d0', lineHeight: 1.6 }}>💵 {PAY_NOTICE}</p>
          </div>
        </div>
      </section>

      {/* Requirements */}
      <section className="py-14 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <div className="label mb-4" style={{ display: 'inline-block' }}>What You Need</div>
            <h2 className="text-3xl md:text-4xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Position Requirements</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-5">
            {ORDER.map(pos => (
              <div key={pos} className="glass-card p-7" style={{ borderRadius: 18 }}>
                <h3 className="text-lg font-black text-white mb-4">{POSITIONS[pos].title}</h3>
                <ul className="space-y-2.5">
                  {REQUIREMENTS[pos].map((req, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm" style={{ color: 'var(--text)' }}>
                      <span style={{ color: 'var(--red)', fontWeight: 800, lineHeight: 1.4 }}>✓</span>
                      <span style={{ lineHeight: 1.5 }}>{req}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy-first approval + onboarding */}
      <section className="pb-16 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-2 gap-5">
            <div className="glass-card p-7" style={{ borderRadius: 18 }}>
              <div className="label mb-4" style={{ display: 'inline-block' }}>Application Stage</div>
              <h3 className="text-lg font-black text-white mb-2">Apply Without Sensitive Documents</h3>
              <p className="text-sm" style={{ color: 'var(--text)', lineHeight: 1.65 }}>The application asks about contact information, availability, experience, and job scenarios. It does not request a Social Security card, W-9, license image, insurance file, or headshot.</p>
            </div>
            <div className="glass-card p-7" style={{ borderRadius: 18 }}>
              <div className="label mb-4" style={{ display: 'inline-block' }}>After Approval</div>
              <h3 className="text-lg font-black text-white mb-2">Secure Contractor Onboarding</h3>
              <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>Approved contractors receive a time-limited secure link. A W-9 is required before the first payment.</p>
              <ul className="space-y-2">
                {['Completed Form W-9 (SSN or EIN may be used on the form)', 'Signed independent-contractor agreement', 'Driver license and driving authorization when the role requires driving', 'Insurance certificate when using a personal vehicle', 'Crew badge photo'].map((g, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--text)' }}>
                    <span style={{ color: '#34d399', fontWeight: 800 }}>•</span><span style={{ lineHeight: 1.5 }}>{g}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* What to expect */}
      <section className="pb-16 px-6">
        <div className="max-w-4xl mx-auto glass-card p-8" style={{ borderRadius: 20 }}>
          <h3 className="text-xl font-black text-white mb-5 text-center">What the Application Looks Like</h3>
          <div className="grid sm:grid-cols-4 gap-4 text-center">
            {[
              ['1', 'Your info', 'Position, contact, and eligibility'],
              ['2', 'Experience', 'Rate your delivery, appliance, moving & driving skills'],
              ['3', 'Scenarios', 'A few real-world job situations'],
              ['4', 'Admin review', 'Documents are requested only after approval'],
            ].map(([n, t, d]) => (
              <div key={n}>
                <div className="mx-auto mb-3 flex items-center justify-center" style={{ width: 40, height: 40, borderRadius: 999, background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.3)', color: 'var(--red)', fontWeight: 800 }}>{n}</div>
                <p className="text-sm font-bold text-white mb-1">{t}</p>
                <p className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{d}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-8">
            <Link href="/careers/apply" className="btn" style={{ padding: '14px 36px', fontSize: 15 }}>Apply Now →</Link>
          </div>
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT} · Independent-contractor opportunities
      </footer>
    </main>
  )
}
