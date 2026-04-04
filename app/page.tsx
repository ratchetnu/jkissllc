'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'

// ── Fade-up animation hook ────────────────────────────────────────────────────
function useFadeUp() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.classList.add('visible'); obs.disconnect() }
    }, { threshold: 0.12 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return ref
}

function FadeUp({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useFadeUp()
  return (
    <div ref={ref} className={`fade-up ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

// ── Data ──────────────────────────────────────────────────────────────────────
const CLIENTS = [
  "Lowe's", "Rooms To Go", "Living Spaces", "RH", "Nebraska Furniture Mart", "XPO Logistics",
]

const SERVICES = [
  {
    icon: '🚚',
    title: 'Freight Delivery',
    desc: 'Full truckload and LTL freight delivery across the DFW metroplex. We handle oversized, heavy, and time-sensitive loads with precision.',
  },
  {
    icon: '📦',
    title: 'Last-Mile Delivery',
    desc: 'White-glove last-mile service direct to the customer\'s door. Furniture, appliances, building materials — delivered and placed.',
  },
  {
    icon: '⏱',
    title: 'Time-Sensitive Loads',
    desc: 'When the delivery window is tight, we show up. Same-day and next-day freight runs with real-time driver communication.',
  },
  {
    icon: '📋',
    title: 'Dispatch Coordination',
    desc: 'Route planning, driver dispatch, and load management. We integrate seamlessly into your existing logistics operations.',
  },
]

const STATS = [
  { value: '5+', label: 'Years in Operation' },
  { value: '6+', label: 'Major Retail Partners' },
  { value: 'DFW', label: 'Metro Coverage' },
  { value: '100%', label: 'Licensed & Insured' },
]

const COVERAGE = [
  'Dallas', 'Fort Worth', 'Arlington', 'Irving', 'Plano',
  'Garland', 'Frisco', 'McKinney', 'Denton', 'Mesquite',
]

const GALLERY = [
  { src: '/images/truck-interior.jpg', alt: 'Loaded delivery truck ready for run' },
  { src: '/images/truck-loaded.jpg', alt: 'Freight secured inside truck' },
  { src: '/images/warehouse.jpg', alt: 'Warehouse operations' },
  { src: '/images/delivery-action.jpg', alt: 'Delivery in progress' },
  { src: '/images/warehouse2.jpg', alt: 'Freight staged for delivery' },
  { src: '/images/delivered.jpg', alt: 'Completed delivery' },
]

// ── Nav ───────────────────────────────────────────────────────────────────────
function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className="fixed top-0 left-0 right-0 z-50 transition-all duration-300"
      style={{ background: scrolled ? 'rgba(11,11,12,0.95)' : 'transparent', backdropFilter: scrolled ? 'blur(12px)' : 'none', borderBottom: scrolled ? '1px solid rgba(255,255,255,.08)' : 'none' }}>
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href="#top" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
          J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-8">
          {[['Services', '#services'], ['About', '#about'], ['Coverage', '#coverage'], ['Contact', '#contact']].map(([label, href]) => (
            <a key={href} href={href} className="text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>{label}</a>
          ))}
          <a href="/start-your-carrier" className="text-sm font-bold transition hover:text-white" style={{ color: '#ff6680' }}>Start a Carrier</a>
        </nav>

        <a href="#contact" className="hidden md:inline-flex btn" style={{ padding: '10px 20px', fontSize: '13px' }}>Get a Quote</a>

        {/* Mobile hamburger */}
        <button className="md:hidden flex flex-col gap-1.5 p-2" onClick={() => setOpen(!open)}>
          <span className="block w-6 h-0.5 bg-white transition-all" style={{ transform: open ? 'rotate(45deg) translate(4px, 4px)' : 'none' }} />
          <span className="block w-6 h-0.5 bg-white transition-all" style={{ opacity: open ? 0 : 1 }} />
          <span className="block w-6 h-0.5 bg-white transition-all" style={{ transform: open ? 'rotate(-45deg) translate(4px, -4px)' : 'none' }} />
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden px-6 pb-6 flex flex-col gap-4" style={{ background: 'rgba(11,11,12,0.98)' }}>
          {[['Services', '#services'], ['About', '#about'], ['Coverage', '#coverage'], ['Contact', '#contact']].map(([label, href]) => (
            <a key={href} href={href} className="text-base font-medium py-2" style={{ color: 'var(--muted)' }} onClick={() => setOpen(false)}>{label}</a>
          ))}
          <a href="/start-your-carrier" className="text-base font-bold py-2" style={{ color: '#ff6680' }} onClick={() => setOpen(false)}>Start a Carrier</a>
          <a href="#contact" className="btn mt-2" onClick={() => setOpen(false)}>Get a Quote</a>
        </div>
      )}
    </header>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Home() {
  return (
    <main id="top" className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <Nav />

      {/* ── Hero ── */}
      <section className="relative min-h-screen flex items-center overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #0b0b0c 0%, #1a0508 100%)' }} />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 20% 50%, rgba(224,0,42,0.18), transparent 55%)' }} />
        {/* Truck image — right side */}
        <div className="absolute right-0 bottom-0 top-0 w-full md:w-3/5 flex items-end md:items-center justify-center md:justify-end pointer-events-none" style={{ opacity: 0.95 }}>
          <Image src="/images/hero.png" alt="J Kiss LLC delivery truck" width={700} height={900} className="object-contain object-bottom md:object-right-bottom" priority style={{ maxHeight: '95vh', width: 'auto' }} />
        </div>
        {/* Left fade so text stays readable */}
        <div className="absolute inset-0 hidden md:block" style={{ background: 'linear-gradient(90deg, rgba(11,11,12,1) 0%, rgba(11,11,12,0.85) 40%, rgba(11,11,12,0.2) 70%, transparent 100%)' }} />

        <div className="relative max-w-6xl mx-auto px-6 pt-32 pb-24">
          <div className="max-w-2xl">
            <div className="label mb-6">DFW Metro · Licensed & Insured</div>
            <h1 className="font-black text-white mb-6" style={{ fontSize: 'clamp(2.4rem, 5vw, 4rem)', lineHeight: 1.1, letterSpacing: '-0.04em' }}>
              The Freight Partner<br />
              Major Retailers <span style={{ color: 'var(--red)' }}>Trust.</span>
            </h1>
            <p className="text-lg mb-8 max-w-xl" style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
              J Kiss LLC delivers freight, furniture, appliances, and building materials across the Dallas–Fort Worth metroplex. Fast. Safe. Professional.
            </p>
            <div className="flex flex-wrap gap-4">
              <a href="#contact" className="btn">Request a Quote →</a>
              <a href="#services" className="btn-ghost">Our Services</a>
            </div>

            {/* Credentials */}
            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-xs font-mono" style={{ color: 'rgba(255,255,255,.4)' }}>
              <span>US DOT 3484556</span>
              <span>MC 01155352</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trusted By ── */}
      <section className="py-14 px-6" style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <p className="text-center text-xs font-bold uppercase tracking-widest mb-8" style={{ color: 'rgba(255,255,255,.3)', letterSpacing: '0.14em' }}>
              Trusted by major retailers &amp; logistics companies
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
              {CLIENTS.map((name) => (
                <span key={name} className="text-base font-black uppercase tracking-wide transition-colors hover:text-white"
                  style={{ color: 'rgba(255,255,255,.25)', letterSpacing: '0.06em', fontSize: '13px' }}>
                  {name}
                </span>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="py-20 px-6">
        <div className="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-6">
          {STATS.map((s, i) => (
            <FadeUp key={s.label} delay={i * 80}>
              <div className="glass-card p-8 text-center">
                <p className="text-4xl font-black mb-2" style={{ color: 'var(--red)', letterSpacing: '-0.04em' }}>{s.value}</p>
                <p className="text-sm font-medium" style={{ color: 'var(--muted)' }}>{s.label}</p>
              </div>
            </FadeUp>
          ))}
        </div>
      </section>

      {/* ── Services ── */}
      <section id="services" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <div className="label mb-4">What We Do</div>
            <h2 className="text-4xl font-black mb-4 text-white" style={{ letterSpacing: '-0.04em' }}>Our Services</h2>
            <p className="text-lg mb-14 max-w-xl" style={{ color: 'var(--muted)' }}>
              From warehouse pickup to final-mile placement, we handle the full delivery chain.
            </p>
          </FadeUp>
          <div className="grid gap-6 sm:grid-cols-2">
            {SERVICES.map((s, i) => (
              <FadeUp key={s.title} delay={i * 80}>
                <div className="glass-card p-8 h-full" style={{ borderRadius: '20px' }}>
                  <span className="text-3xl mb-4 block">{s.icon}</span>
                  <h3 className="text-lg font-black text-white mb-3" style={{ letterSpacing: '-0.02em' }}>{s.title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{s.desc}</p>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── Photo Gallery ── */}
      <section className="py-24 px-6" style={{ background: 'rgba(255,255,255,.015)' }}>
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <div className="label mb-4">In The Field</div>
            <h2 className="text-4xl font-black mb-14 text-white" style={{ letterSpacing: '-0.04em' }}>Real Runs. Real Results.</h2>
          </FadeUp>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {GALLERY.map((img, i) => (
              <FadeUp key={img.src} delay={i * 60}>
                <div className="relative overflow-hidden rounded-2xl aspect-[4/3]">
                  <Image src={img.src} alt={img.alt} fill className="object-cover transition-transform duration-500 hover:scale-105" />
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.4), transparent)' }} />
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── About ── */}
      <section id="about" className="py-24 px-6">
        <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-16 items-center">
          <FadeUp>
            <div className="relative rounded-3xl overflow-hidden" style={{ aspectRatio: '4/3' }}>
              <Image src="/images/appliance-delivery.jpg" alt="J Kiss LLC delivery operation" fill className="object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(224,0,42,0.15), transparent)' }} />
              {/* Credentials badge */}
              <div className="absolute bottom-6 left-6 right-6 glass-card p-5" style={{ borderRadius: '14px' }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-lg" style={{ background: 'var(--red)' }}>✓</div>
                  <div>
                    <p className="text-sm font-bold text-white">Fully Licensed &amp; Insured</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>DOT 3484556 · MC 01155352</p>
                  </div>
                </div>
              </div>
            </div>
          </FadeUp>

          <FadeUp delay={100}>
            <div className="label mb-5">About J Kiss LLC</div>
            <h2 className="text-4xl font-black text-white mb-6" style={{ letterSpacing: '-0.04em', lineHeight: 1.1 }}>
              Built on Reliability.<br />Proven by <span style={{ color: 'var(--red)' }}>Results.</span>
            </h2>
            <div className="space-y-4 text-base leading-relaxed" style={{ color: 'var(--muted)' }}>
              <p>
                J Kiss LLC is a Dallas–Fort Worth based freight and last-mile delivery company. In business since September 2020, we have spent 5+ years building a reputation for on-time performance, careful handling, and clear communication with every client we serve.
              </p>
              <p>
                We have executed delivery contracts for some of the largest retail and logistics operations in the country — including Lowe's, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics. Every run is handled with the same level of professionalism we bring to our biggest accounts.
              </p>
              <p>
                When you work with J Kiss LLC, you get a freight partner who shows up, communicates proactively, and delivers on the commitment every time.
              </p>
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              {['On-Time Performance', 'Careful Handling', 'Clear Communication', 'Full Coverage'].map(tag => (
                <span key={tag} className="text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: 'rgba(224,0,42,.10)', border: '1px solid rgba(224,0,42,.25)', color: '#ff6680' }}>
                  {tag}
                </span>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Coverage ── */}
      <section id="coverage" className="py-24 px-6" style={{ background: 'rgba(255,255,255,.015)' }}>
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Service Area</div>
            <h2 className="text-4xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>DFW Coverage</h2>
            <p className="text-lg mb-12 max-w-xl" style={{ color: 'var(--muted)' }}>
              We operate throughout the Dallas–Fort Worth metroplex and surrounding areas.
            </p>
          </FadeUp>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            {COVERAGE.map((city, i) => (
              <FadeUp key={city} delay={i * 50}>
                <div className="glass-card p-5 text-center">
                  <span className="text-sm font-bold text-white">{city}</span>
                </div>
              </FadeUp>
            ))}
          </div>
          <FadeUp delay={200}>
            <p className="mt-8 text-sm text-center" style={{ color: 'var(--muted)' }}>
              Don&apos;t see your city? <a href="#contact" className="font-semibold hover:text-white transition-colors" style={{ color: 'var(--red)' }}>Contact us</a> — we may still be able to help.
            </p>
          </FadeUp>
        </div>
      </section>

      {/* ── Start Your Carrier Guide Promo ── */}
      <section className="py-24 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <div className="rounded-3xl overflow-hidden p-10 md:p-14" style={{ background: 'linear-gradient(135deg, #1a0508 0%, #0b0b0c 60%)', border: '1px solid rgba(224,0,42,.25)' }}>
            <div className="grid md:grid-cols-2 gap-10 items-center">
              <FadeUp>
                <div className="label mb-5">Free Industry Guide</div>
                <h2 className="text-3xl md:text-4xl font-black text-white mb-5" style={{ letterSpacing: '-0.04em', lineHeight: 1.1 }}>
                  Starting a Motor Carrier<br />
                  Business in <span style={{ color: 'var(--red)' }}>Texas?</span>
                </h2>
                <p className="text-base leading-relaxed mb-8" style={{ color: 'var(--muted)' }}>
                  We put together a complete guide based on 5+ years running freight in DFW (in business since September 2020). Every federal and state requirement, insurance minimums, IFTA, IRP, ELD rules, drug testing — plus a monthly, quarterly, and annual compliance calendar so you never miss a deadline.
                </p>
                <a href="/start-your-carrier" className="btn" style={{ width: 'fit-content' }}>Read the Free Guide →</a>
              </FadeUp>
              <FadeUp delay={100}>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { icon: '📋', title: '12-Step Startup Checklist', desc: 'USDOT, authority, BOC-3, insurance, IRP, IFTA and more' },
                    { icon: '🛡️', title: 'Insurance Requirements', desc: 'Federal & Texas minimums broken down by vehicle type and cargo' },
                    { icon: '📅', title: 'Compliance Calendar', desc: 'Monthly, quarterly, and annual checkpoints to stay audit-ready' },
                    { icon: '🔗', title: 'Official Agency Links', desc: 'Direct links to FMCSA, TxDMV, UCR, IFTA, and more' },
                  ].map((card, i) => (
                    <div key={card.title} className="glass-card p-5" style={{ borderRadius: '16px' }}>
                      <span className="text-2xl mb-3 block">{card.icon}</span>
                      <p className="text-sm font-black text-white mb-1" style={{ letterSpacing: '-0.01em' }}>{card.title}</p>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{card.desc}</p>
                    </div>
                  ))}
                </div>
              </FadeUp>
            </div>
          </div>
        </div>
      </section>

      {/* ── Contact ── */}
      <section id="contact" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-16">
            <FadeUp>
              <div className="label mb-5">Get In Touch</div>
              <h2 className="text-4xl font-black text-white mb-6" style={{ letterSpacing: '-0.04em', lineHeight: 1.1 }}>
                Ready to Move<br /><span style={{ color: 'var(--red)' }}>Your Freight?</span>
              </h2>
              <p className="text-base leading-relaxed mb-8" style={{ color: 'var(--muted)' }}>
                Tell us about your delivery needs and we&apos;ll get back to you within one business day. We work with retailers, warehouses, and logistics companies of all sizes.
              </p>
              <div className="space-y-4">
                <a href="mailto:info@jkissllc.com" className="flex items-center gap-3 text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}>✉</span>
                  info@jkissllc.com
                </a>
                <a href="mailto:timmothy@jkissllc.com" className="flex items-center gap-3 text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}>👤</span>
                  timmothy@jkissllc.com
                </a>
              </div>
            </FadeUp>

            <FadeUp delay={100}>
              <ContactForm />
            </FadeUp>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-12 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-start justify-between gap-8 mb-10">
            <div>
              <p className="text-xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>
                J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
              </p>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>Freight &amp; Last-Mile Delivery · Dallas–Fort Worth</p>
              <p className="text-xs mt-3 font-mono" style={{ color: 'rgba(255,255,255,.3)' }}>
                US DOT 3484556 · MC 01155352
              </p>
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm" style={{ color: 'var(--muted)' }}>
              {[['Services', '#services'], ['About', '#about'], ['Coverage', '#coverage'], ['Contact', '#contact']].map(([label, href]) => (
                <a key={href} href={href} className="transition hover:text-white">{label}</a>
              ))}
            </div>
          </div>
          <div className="pt-8 text-xs flex flex-col md:flex-row items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.25)' }}>
            <p>© {new Date().getFullYear()} J Kiss LLC. All rights reserved.</p>
            <div className="flex gap-4">
              <a href="mailto:info@jkissllc.com" className="transition hover:text-white">info@jkissllc.com</a>
              <a href="mailto:timmothy@jkissllc.com" className="transition hover:text-white">timmothy@jkissllc.com</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  )
}

// ── Contact Form ──────────────────────────────────────────────────────────────
function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    const form = e.currentTarget
    const data = Object.fromEntries(new FormData(form))
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) { setStatus('sent'); form.reset() }
      else setStatus('error')
    } catch { setStatus('error') }
  }

  const iStyle = {
    width: '100%',
    padding: '12px 14px',
    background: 'rgba(255,255,255,.04)',
    border: '1px solid rgba(255,255,255,.10)',
    borderRadius: '10px',
    color: '#f3f4f6',
    fontSize: '14px',
    outline: 'none',
  } as React.CSSProperties

  return (
    <div className="glass-card p-8">
      {status === 'sent' ? (
        <div className="text-center py-8">
          <div className="text-4xl mb-4">✓</div>
          <p className="text-lg font-black text-white mb-2">Message sent!</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>We&apos;ll get back to you within one business day.</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Name</label>
              <input name="name" required placeholder="Your name" style={iStyle} />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Company</label>
              <input name="company" placeholder="Company name" style={iStyle} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Email</label>
            <input name="email" type="email" required placeholder="you@company.com" style={iStyle} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Phone</label>
            <input name="phone" type="tel" placeholder="(555) 000-0000" style={iStyle} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Service Needed</label>
            <select name="service" style={{ ...iStyle, cursor: 'pointer' }}>
              <option value="">Select a service</option>
              <option>Freight Delivery</option>
              <option>Last-Mile Delivery</option>
              <option>Time-Sensitive Load</option>
              <option>Dispatch Coordination</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Message</label>
            <textarea name="message" rows={4} placeholder="Tell us about your delivery needs..." style={{ ...iStyle, resize: 'vertical' }} />
          </div>
          {status === 'error' && (
            <p className="text-sm text-red-400">Something went wrong. Please email us directly at info@jkissllc.com</p>
          )}
          <button type="submit" disabled={status === 'sending'} className="btn w-full" style={{ justifyContent: 'center' }}>
            {status === 'sending' ? 'Sending…' : 'Send Message →'}
          </button>
        </form>
      )}
    </div>
  )
}
