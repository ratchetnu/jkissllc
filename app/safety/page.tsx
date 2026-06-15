import type { Metadata } from 'next'
import Link from 'next/link'

const SITE_URL = 'https://www.jkissllc.com'
const USDOT = '3484556'
const MC = '01155352'

const SAFER_SNAPSHOT_URL = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${USDOT}`
const SMS_URL = `https://ai.fmcsa.dot.gov/SMS/Carrier/${USDOT}/Overview.aspx`

export const metadata: Metadata = {
  title: 'Safety & Authority | J Kiss LLC — USDOT 3484556',
  description: 'J Kiss LLC safety credentials, operating authority, and FMCSA compliance data. USDOT 3484556 · MC 01155352. Verify on SAFER directly.',
  alternates: { canonical: `${SITE_URL}/safety` },
}

const AUTHORITY = [
  { label: 'USDOT Number',         value: USDOT },
  { label: 'MC Number',            value: MC },
  { label: 'Operating Authority',  value: 'Authorized For-Hire' },
  { label: 'Operation Type',       value: 'Interstate · Intrastate (TX)' },
  { label: 'Cargo Carried',        value: 'Household Goods · General Freight · Building Materials' },
  { label: 'In Business Since',    value: 'September 2020' },
]

const BASICS = [
  { code: 'Unsafe Driving',         desc: 'Operating a CMV in a dangerous or careless manner.' },
  { code: 'Hours of Service',       desc: 'Driver fatigue monitoring — duty status and rest compliance.' },
  { code: 'Driver Fitness',         desc: 'Driver qualification — license, medical card, training records.' },
  { code: 'Controlled Substances',  desc: 'DOT drug & alcohol testing program compliance.' },
  { code: 'Vehicle Maintenance',    desc: 'Truck condition — inspection, maintenance, repair records.' },
  { code: 'Hazardous Materials',    desc: 'Not applicable — J Kiss LLC does not haul hazmat.' },
  { code: 'Crash Indicator',        desc: 'Frequency and severity of crashes attributable to the carrier.' },
]

export default function SafetyPage() {
  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      {/* Hero */}
      <section className="pt-32 pb-16 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="label mb-6">Safety · Authority · Compliance</div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
            We Show Our <span style={{ color: 'var(--red)' }}>Numbers.</span>
          </h1>
          <p className="text-lg max-w-2xl mb-8" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            Every carrier&apos;s safety record is a matter of public record. Here are ours, with direct verification links to FMCSA — so you don&apos;t have to take our word for it.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href={SAFER_SNAPSHOT_URL} target="_blank" rel="noopener noreferrer" className="btn">View SAFER Snapshot ↗</a>
            <a href={SMS_URL} target="_blank" rel="noopener noreferrer" className="btn-ghost">FMCSA SMS ↗</a>
          </div>
        </div>
      </section>

      {/* Authority table */}
      <section className="py-12 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-black text-white mb-6" style={{ letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>
            Operating Authority
          </h2>
          <div className="glass-card overflow-hidden" style={{ borderRadius: '20px' }}>
            {AUTHORITY.map((row, i) => (
              <div key={row.label} className="grid grid-cols-[1fr_2fr] px-6 py-4 items-center"
                style={{ borderBottom: i < AUTHORITY.length - 1 ? '1px solid var(--line)' : 'none' }}>
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>{row.label}</span>
                <span className="text-base font-semibold tabular-nums" style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>{row.value}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs" style={{ color: 'rgba(255,255,255,.4)' }}>
            Data above reflects active FMCSA registration. Verify current values on{' '}
            <a href={SAFER_SNAPSHOT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold transition hover:text-white" style={{ color: 'var(--red)' }}>
              FMCSA SAFER Snapshot ↗
            </a>
          </p>
        </div>
      </section>

      {/* CSA BASICs — categories explainer */}
      <section className="py-16 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)' }}>
        <div className="max-w-5xl mx-auto">
          <div className="label mb-4">CSA BASICs</div>
          <h2 className="text-2xl md:text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>
            The Seven Categories FMCSA Tracks.
          </h2>
          <p className="text-base mb-10 max-w-2xl" style={{ color: 'var(--muted)' }}>
            Compliance, Safety, Accountability — the public-facing scoring framework FMCSA uses to monitor every carrier. Each category is updated monthly based on roadside inspections, crashes, and investigations.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {BASICS.map(b => (
              <div key={b.code} className="glass-card p-5" style={{ borderRadius: '16px' }}>
                <p className="text-sm font-black text-white mb-1" style={{ letterSpacing: '-0.01em' }}>{b.code}</p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{b.desc}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 text-sm" style={{ color: 'var(--muted)' }}>
            View live BASIC measures for J Kiss LLC →{' '}
            <a href={SMS_URL} target="_blank" rel="noopener noreferrer" className="font-semibold transition hover:text-white" style={{ color: 'var(--red)' }}>
              FMCSA Safety Measurement System ↗
            </a>
          </p>
        </div>
      </section>

      {/* Why it matters */}
      <section className="py-16 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-black text-white mb-5" style={{ letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>
            Why we publish this.
          </h2>
          <div className="space-y-4 text-base leading-relaxed max-w-3xl" style={{ color: 'var(--muted)' }}>
            <p>
              Most small carriers hide their FMCSA numbers because it&apos;s easier to win business when the customer doesn&apos;t check. We do the opposite — link directly to our SAFER snapshot from this page — because customers who run COI compliance and vendor onboarding need to verify carriers before they cut a contract.
            </p>
            <p>
              If you&apos;re building a vendor file for J Kiss LLC, this page plus our{' '}
              <Link href="/coi" className="font-semibold transition hover:text-white" style={{ color: 'var(--red)' }}>COI request form</Link>{' '}
              should cover everything your compliance team needs in one shot.
            </p>
          </div>
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} J Kiss LLC · US DOT {USDOT} · MC {MC}
      </footer>
    </main>
  )
}
