import Link from 'next/link'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import type { Metadata } from 'next'
import { POSITIONS, REQUIREMENTS, REQUIRED_DOCS, HEADSHOT_GUIDELINES, PAY_NOTICE, type Position } from '../lib/ats-config'

export const metadata: Metadata = {
  title: `Careers — Drivers & Helpers | ${COMPANY.legalName}`,
  description: `${COMPANY.legalName} is hiring Drivers ($175/day starting) and Driver Helpers ($150/day starting) for box-truck delivery, moving, appliance installation, and junk removal across DFW. Apply online in minutes.`,
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
          <div className="label mb-6" style={{ display: 'inline-block' }}>We&apos;re Hiring in DFW</div>
          <h1 className="text-4xl md:text-6xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.04, fontFamily: 'var(--font-display)' }}>
            Get Paid to Move,<br /><span style={{ color: 'var(--red)' }}>Deliver &amp; Install.</span>
          </h1>
          <p className="text-lg md:text-xl mb-8 max-w-2xl mx-auto" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            {COMPANY.legalName}{' '}runs box-truck delivery, moving, appliance installations, and junk-removal crews across Dallas–Fort Worth. If you work hard, show up, and take care of the customer, there&apos;s a spot and a paycheck for you.
          </p>
          <Link href="/careers/apply" className="btn" style={{ padding: '16px 40px', fontSize: 16 }}>Start Your Application →</Link>
          <p className="text-xs mt-4" style={{ color: 'rgba(255,255,255,.4)' }}>Takes about 10–15 minutes · You&apos;ll need a photo ID, Social Security card, and a headshot ready</p>
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

      {/* Required documents + headshot */}
      <section className="pb-16 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-2 gap-5">
            <div className="glass-card p-7" style={{ borderRadius: 18 }}>
              <div className="label mb-4" style={{ display: 'inline-block' }}>Have These Ready</div>
              <h3 className="text-lg font-black text-white mb-2">Documents You&apos;ll Upload</h3>
              <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>You can&apos;t submit until every required document is attached. Clear phone photos are fine.</p>
              <div className="space-y-3">
                {(['driver', 'helper'] as Position[]).map(pos => (
                  <div key={pos}>
                    <p className="text-xs font-bold uppercase tracking-widest mb-1.5" style={{ color: 'var(--red)' }}>{POSITIONS[pos].title}</p>
                    <ul className="space-y-1.5">
                      {REQUIRED_DOCS[pos].map(d => (
                        <li key={d.kind} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
                          <span style={{ color: 'var(--muted)' }}>📎</span><span style={{ lineHeight: 1.5 }}>{d.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass-card p-7" style={{ borderRadius: 18 }}>
              <div className="label mb-4" style={{ display: 'inline-block' }}>Badge Photo</div>
              <h3 className="text-lg font-black text-white mb-2">Headshot Requirements</h3>
              <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>Your approved photo becomes your crew ID badge — treat it like a passport photo.</p>
              <ul className="space-y-2">
                {HEADSHOT_GUIDELINES.map((g, i) => (
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
              ['4', 'Documents', 'ID, SS card, and badge headshot'],
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
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT} · Equal-opportunity employer
      </footer>
    </main>
  )
}
