'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import Link from 'next/link'
import {
  Truck, PackageCheck, Zap, Store, Trash2, KeyRound, ClipboardList, ShieldCheck, CalendarDays,
  Ban, DollarSign, FileText, Mail, User, CheckCircle2, BadgeCheck, ArrowRight, Phone,
} from 'lucide-react'
import { CITIES } from './lib/cities'

// Lazy-load MapLibre map — avoids the ~200KB bundle on initial render.
const CoverageMap = dynamic(() => import('./components/CoverageMap'), {
  ssr: false,
  loading: () => (
    <div className="glass-card flex items-center justify-center" style={{ borderRadius: '20px', aspectRatio: '4/3' }}>
      <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Loading map…</span>
    </div>
  ),
})

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

// ── Scroll progress bar ───────────────────────────────────────────────────────
function ScrollProgress() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onScroll = () => {
      const el = ref.current
      if (!el) return
      const max = document.documentElement.scrollHeight - window.innerHeight
      el.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll) }
  }, [])
  return <div ref={ref} className="scroll-progress" style={{ width: '100%', transform: 'scaleX(0)' }} />
}

// ── Spotlight card: tracks cursor to position the radial sheen ────────────────
function SpotlightCard({ children, className = '', blue = false, style }: { children: React.ReactNode; className?: string; blue?: boolean; style?: React.CSSProperties }) {
  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
  }
  return (
    <div onMouseMove={onMove} className={`spotlight-card ${blue ? 'spotlight-blue' : ''} ${className}`} style={style}>
      {children}
    </div>
  )
}

// ── Animated counter: counts from 0 → target when scrolled into view ──────────
function Counter({ target, duration = 1400 }: { target: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [value, setValue] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      obs.disconnect()
      const start = performance.now()
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1)
        // ease-out cubic
        const eased = 1 - Math.pow(1 - t, 3)
        setValue(Math.round(eased * target))
        if (t < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, { threshold: 0.3 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [target, duration])
  return <span ref={ref}>{value.toLocaleString()}</span>
}

// ── Data ──────────────────────────────────────────────────────────────────────
const CLIENTS = [
  "Lowe's", "Rooms To Go", "Living Spaces", "RH", "Nebraska Furniture Mart", "XPO Logistics",
]

const SERVICES = [
  {
    Icon: Truck,
    title: 'Box-Truck Freight',
    desc: 'Palletized freight and dock-to-dock runs handled in 16–26 ft straight trucks. Furniture, appliances, building materials, and packaged goods — moved across DFW with care.',
  },
  {
    Icon: PackageCheck,
    title: 'White-Glove Last-Mile',
    desc: 'In-home delivery and room-of-choice placement direct to the customer. Two-person crews, debris removal, and assembly support for premium retailers.',
  },
  {
    Icon: Zap,
    title: 'Same-Day & Next-Day',
    desc: 'When the window is tight, we show up. Same-day and next-day box-truck runs with real-time driver communication and live appointment updates.',
  },
  {
    Icon: Store,
    title: 'Retail Replenishment',
    desc: 'Store-to-store transfers, dock-to-store replenishment, and returns consolidation. Reliable scheduled runs that fit into your existing logistics flow.',
  },
  {
    Icon: Trash2,
    title: 'Junk Removal',
    desc: 'Single-item pickups to full-property hauls. Furniture, appliances, construction debris, and estate clear-outs — loaded, hauled, and disposed of responsibly so you don\'t lift a thing.',
    cta: { label: 'Book Junk Removal', href: '/?service=Junk%20Removal#contact' },
  },
  {
    Icon: KeyRound,
    title: 'Eviction & Property Cleanouts',
    desc: 'Fast, discreet cleanouts for landlords and property managers. Units, garages, and foreclosures cleared down to broom-clean — coordinated around your turnover timeline.',
    cta: { label: 'Book a Cleanout', href: '/?service=Eviction%20%2F%20Property%20Cleanout#contact' },
  },
]

// Counter-friendly numeric stats. value = end number; suffix renders after counted value.
const STATS = [
  { value: 5, suffix: '+', label: 'Years in Operation' },
  { value: 6, suffix: '+', label: 'Major Retail Partners' },
  { value: 98, suffix: '%', label: 'On-Time Performance' },
  { value: 10, suffix: '+', label: 'Cities Covered' },
]


const CASE_STUDIES = [
  {
    tag: 'White-Glove Appliance',
    title: 'High-end appliance retailer — room-of-choice install',
    metrics: [
      { v: '2,400+', l: 'Deliveries / yr' },
      { v: '99.1%', l: 'On-time appointments' },
      { v: '0.04%', l: 'Damage rate' },
    ],
    blurb: 'Two-person crews handling fridges, ranges, and built-ins across DFW homes. Full unbox, set-place, and packaging removal — under retailer-set appointment windows.',
  },
  {
    tag: 'Furniture Delivery',
    title: 'National furniture brand — DFW final-mile partner',
    metrics: [
      { v: '12k', l: 'Pieces placed / yr' },
      { v: '98.4%', l: 'Appointment compliance' },
      { v: '< 2hr', l: 'Avg. window hit rate' },
    ],
    blurb: 'Daily box-truck runs from the regional DC into customer homes across Dallas, Fort Worth, and surrounding suburbs. Room placement, light assembly, and signed-POD return-to-DC same day.',
  },
  {
    tag: 'Retail Replenishment',
    title: 'Big-box home improvement — store-to-store transfers',
    metrics: [
      { v: '6 stores', l: 'On regular rotation' },
      { v: 'Same-day', l: 'Pickup-to-dock' },
      { v: '5+ yrs', l: 'Continuous service' },
    ],
    blurb: 'Scheduled box-truck transfers between metro stores plus emergency same-day runs for stock-outs and customer pickups. Backhauls and returns consolidated to keep miles efficient.',
  },
]

const GALLERY = [
  { src: '/images/truck-interior.jpg', alt: 'Loaded delivery truck ready for run' },
  { src: '/images/truck-loaded.jpg', alt: 'Freight secured inside truck' },
  { src: '/images/warehouse.jpg', alt: 'Warehouse operations' },
  { src: '/images/delivery-action.jpg', alt: 'Delivery in progress' },
  { src: '/images/warehouse2.jpg', alt: 'Freight staged for delivery' },
  { src: '/images/delivered.jpg', alt: 'Completed delivery' },
  { src: '/images/junk-curbside-haul.jpg', alt: 'Curbside junk and furniture removal' },
  { src: '/images/junk-property-cleanout.jpg', alt: 'Full property cleanout and debris removal' },
  { src: '/images/junk-garage-cleanout.jpg', alt: 'Garage and storage unit cleanout' },
  { src: '/images/junk-yard-debris.jpg', alt: 'Yard debris and bulk junk haul-away' },
  { src: '/images/junk-estate-cleanout.jpg', alt: 'Estate cleanout — furniture, boxes, and appliances' },
  { src: '/images/junk-shed-cleanout.jpg', alt: 'Shed and backyard cleanout' },
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
        <nav className="hidden md:flex items-center gap-7">
          {[['Services', '#services'], ['Coverage', '#coverage'], ['Track', '/track'], ['Safety', '/safety'], ['Reviews', '/reviews']].map(([label, href]) => (
            <a key={href} href={href} className="text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>{label}</a>
          ))}
        </nav>

        <a href="/quote" className="hidden md:inline-flex btn" style={{ padding: '10px 20px', fontSize: '13px' }}>Instant Quote</a>

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
          {[['Services', '#services'], ['Coverage', '#coverage'], ['Track Shipment', '/track'], ['Safety / FMCSA', '/safety'], ['Reviews', '/reviews'], ['Request COI', '/coi']].map(([label, href]) => (
            <a key={href} href={href} className="text-base font-medium py-2" style={{ color: 'var(--muted)' }} onClick={() => setOpen(false)}>{label}</a>
          ))}
          <a href="/start-your-carrier" className="text-base font-bold py-2" style={{ color: '#ff6680' }} onClick={() => setOpen(false)}>Start a Carrier (Guide)</a>
          <a href="/quote" className="btn mt-2" onClick={() => setOpen(false)}>Instant Quote</a>
        </div>
      )}
    </header>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Home() {
  return (
    <main id="top" className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <ScrollProgress />
      <Nav />

      {/* ── Hero ── */}
      <section className="relative min-h-screen flex items-start md:items-center overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #0b0b0c 0%, #1a0508 100%)' }} />
        {/* Animated gradient mesh + drifting route grid */}
        <div className="absolute inset-0 hero-mesh" />
        <div className="absolute inset-0 hero-grid" />
        {/* Truck image — right side */}
        <div className="absolute right-0 bottom-0 top-0 w-full md:w-3/5 flex items-end md:items-center justify-center md:justify-end pointer-events-none" style={{ opacity: 0.95 }}>
          <Image src="/images/hero.webp" alt="J Kiss LLC delivery truck" width={700} height={900} className="object-contain object-bottom md:object-right-bottom" priority style={{ maxHeight: '95vh', width: 'auto' }} />
        </div>
        {/* Mobile overlay — dark layer so text is always readable over truck image */}
        <div className="absolute inset-0 md:hidden" style={{ background: 'rgba(11,11,12,0.72)' }} />
        {/* Left fade — desktop: left-to-right directional fade */}
        <div className="absolute inset-0 hidden md:block" style={{ background: 'linear-gradient(90deg, rgba(11,11,12,1) 0%, rgba(11,11,12,0.85) 40%, rgba(11,11,12,0.2) 70%, transparent 100%)' }} />

        <div className="relative max-w-6xl mx-auto px-6 pt-32 pb-24">
          <div className="max-w-2xl">
            <div className="label mb-6">DFW Metro · Licensed & Insured</div>
            <h1 className="font-black text-white mb-6" style={{ fontSize: 'clamp(2.4rem, 5vw, 4rem)', lineHeight: 1.1, letterSpacing: '-0.045em', fontFamily: 'var(--font-display)' }}>
              Delivery, Junk Removal &amp; Cleanouts.
              <span className="grad-red" style={{ display: 'block', marginTop: '0.28em', lineHeight: 1.12, paddingBottom: '0.08em' }}>Done Right Across DFW.</span>
            </h1>
            <p className="text-lg mb-8 max-w-xl" style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
              J Kiss LLC handles box-truck freight and white-glove last-mile delivery, plus junk removal and eviction &amp; property cleanouts across Dallas–Fort Worth. 16–26 ft straight trucks, two-person crews, and the reliability major retailers already trust.
            </p>
            <div className="flex flex-wrap gap-4">
              <a href="/quote" className="btn">Get an Instant Quote →</a>
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
            <div className="marquee">
              {/* Two identical tracks → seamless infinite loop */}
              {[0, 1].map((track) => (
                <div key={track} className="marquee-track" aria-hidden={track === 1}>
                  {CLIENTS.map((name) => (
                    <span key={`${track}-${name}`} className="marquee-logo">{name}</span>
                  ))}
                </div>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Stats — animated counters ── */}
      <section className="py-20 px-6">
        <div className="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-6">
          {STATS.map((s, i) => (
            <FadeUp key={s.label} delay={i * 80}>
              <SpotlightCard className="glass-card p-8 text-center h-full">
                <p className="text-5xl font-black mb-2 tabular-nums grad-red" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
                  <Counter target={s.value} />{s.suffix}
                </p>
                <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>{s.label}</p>
              </SpotlightCard>
            </FadeUp>
          ))}
        </div>
      </section>

      {/* ── Case Studies ── */}
      <section className="py-24 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Case Studies</div>
            <h2 className="text-4xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
              Real Runs. Measured Results.
            </h2>
            <p className="text-lg mb-14 max-w-xl" style={{ color: 'var(--muted)' }}>
              Anonymized snapshots from active retailer relationships. Numbers reflect 12-month rolling performance.
            </p>
          </FadeUp>
          <div className="grid gap-6 md:grid-cols-3">
            {CASE_STUDIES.map((cs, i) => (
              <FadeUp key={cs.title} delay={i * 90}>
                <SpotlightCard className="glass-card p-7 h-full flex flex-col" style={{ borderRadius: '20px' }}>
                  <div className="inline-block self-start text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full mb-5"
                    style={{ background: 'rgba(224,0,42,.10)', border: '1px solid rgba(224,0,42,.25)', color: '#ff6680', letterSpacing: '0.12em' }}>
                    {cs.tag}
                  </div>
                  <h3 className="text-base font-black text-white mb-5 leading-snug" style={{ letterSpacing: '-0.02em' }}>
                    {cs.title}
                  </h3>
                  <div className="grid grid-cols-3 gap-3 mb-5 pb-5" style={{ borderBottom: '1px solid var(--line)' }}>
                    {cs.metrics.map(m => (
                      <div key={m.l}>
                        <p className="text-xl font-black tabular-nums" style={{ color: 'var(--red)', letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>{m.v}</p>
                        <p className="text-[10px] font-semibold mt-1 uppercase tracking-wide" style={{ color: 'var(--muted)', letterSpacing: '0.08em' }}>{m.l}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{cs.blurb}</p>
                </SpotlightCard>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── Services ── */}
      <section id="services" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <div className="label mb-4">What We Do</div>
            <h2 className="text-4xl font-black mb-4 text-white" style={{ letterSpacing: '-0.04em' }}>Our Services</h2>
            <p className="text-lg mb-14 max-w-xl" style={{ color: 'var(--muted)' }}>
              From freight and final-mile delivery to junk removal and full property cleanouts — we handle the heavy lifting end to end.
            </p>
          </FadeUp>
          <div className="grid gap-6 sm:grid-cols-2">
            {SERVICES.map((s, i) => (
              <FadeUp key={s.title} delay={i * 80}>
                <SpotlightCard className="glass-card p-8 h-full" style={{ borderRadius: '20px' }}>
                  <span className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}>
                    <s.Icon size={24} strokeWidth={1.75} color="#ff6680" />
                  </span>
                  <h3 className="text-lg font-black text-white mb-3" style={{ letterSpacing: '-0.02em' }}>{s.title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{s.desc}</p>
                  {s.cta && (
                    <a href={s.cta.href} className="inline-flex items-center gap-1.5 mt-5 text-sm font-bold transition hover:text-white" style={{ color: '#ff6680' }}>
                      {s.cta.label} <ArrowRight size={15} strokeWidth={2.25} />
                    </a>
                  )}
                </SpotlightCard>
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
                  <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--red)' }}><BadgeCheck size={20} strokeWidth={2} color="#fff" /></div>
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
                J Kiss LLC is a Dallas–Fort Worth based company specializing in box-truck freight, white-glove last-mile delivery, junk removal, and eviction &amp; property cleanouts. In business since September 2020, we have spent 5+ years building a reputation for on-time performance, careful handling, and clear communication with every client we serve.
              </p>
              <p>
                We have executed delivery contracts for some of the largest retail and logistics operations in the country — including Lowe&apos;s, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics. Every run is handled with the same level of professionalism we bring to our biggest accounts.
              </p>
              <p>
                When you work with J Kiss LLC, you get a partner who shows up, communicates proactively, and delivers on the commitment every time — whatever the job.
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

      {/* ── Coverage — interactive DFW map ── */}
      <section id="coverage" className="py-24 px-6" style={{ background: 'rgba(255,255,255,.015)' }}>
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Service Area</div>
            <h2 className="text-4xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>DFW Coverage</h2>
            <p className="text-lg mb-12 max-w-xl" style={{ color: 'var(--muted)' }}>
              We operate throughout the Dallas–Fort Worth metroplex and surrounding areas. Click any city for service details.
            </p>
          </FadeUp>
          <div className="grid lg:grid-cols-[1.4fr_1fr] gap-8 items-start">
            <FadeUp>
              <CoverageMap />
            </FadeUp>
            <FadeUp delay={120}>
              <div className="glass-card p-6" style={{ borderRadius: '20px' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Cities We Serve</p>
                <div className="grid grid-cols-2 gap-2">
                  {CITIES.map(city => (
                    <Link key={city.slug} href={`/box-truck-delivery/${city.slug}`}
                      className="flex items-center gap-2 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5"
                      style={{ border: '1px solid var(--line)' }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--red)' }} />
                      <span className="text-sm font-semibold text-white">{city.name}</span>
                    </Link>
                  ))}
                </div>
                <p className="mt-5 text-xs" style={{ color: 'var(--muted)' }}>
                  Don&apos;t see your city? <a href="#contact" className="font-semibold hover:text-white transition-colors" style={{ color: 'var(--red)' }}>Contact us</a> — we may still be able to help.
                </p>
              </div>
            </FadeUp>
          </div>
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
                  We put together a complete guide based on 5+ years running box-truck freight in DFW (in business since September 2020). Every federal and state requirement broken down by weight class — non-CDL under 26K, Class B over 26K, and Class A semi — plus a monthly, quarterly, and annual compliance calendar so you never miss a deadline.
                </p>
                <a href="/start-your-carrier" className="btn" style={{ width: 'fit-content' }}>Read the Free Guide →</a>
              </FadeUp>
              <FadeUp delay={100}>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { Icon: ClipboardList, title: '12-Step Startup Checklist', desc: 'USDOT, authority, BOC-3, insurance, DOT compliance — sequenced in order' },
                    { Icon: ShieldCheck, title: 'Insurance Requirements', desc: 'Federal & Texas minimums broken down by vehicle type and cargo' },
                    { Icon: CalendarDays, title: 'Compliance Calendar', desc: 'Monthly, quarterly, and annual checkpoints to stay audit-ready' },
                    { Icon: Truck, title: 'Weight-Class Comparison', desc: 'Non-CDL box truck vs. Class B vs. Class A — what applies, what doesn\'t' },
                  ].map((card) => (
                    <SpotlightCard key={card.title} className="glass-card p-5" style={{ borderRadius: '16px' }}>
                      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.22)' }}>
                        <card.Icon size={20} strokeWidth={1.75} color="#ff6680" />
                      </span>
                      <p className="text-sm font-black text-white mb-1" style={{ letterSpacing: '-0.01em' }}>{card.title}</p>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{card.desc}</p>
                    </SpotlightCard>
                  ))}
                </div>
              </FadeUp>
            </div>
          </div>
        </div>
      </section>

      {/* ── ClaimGuard Help Ad ── */}
      <section className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FadeUp>
            <a href="https://www.claimguardhelp.com" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'block' }}>
              <div className="rounded-3xl p-10 md:p-14 transition-all hover:scale-[1.01]" style={{ background: 'linear-gradient(135deg, #030d1a 0%, #071a30 50%, #0b0b0c 100%)', border: '1px solid rgba(30,120,255,.3)', cursor: 'pointer' }}>
                <div className="grid md:grid-cols-2 gap-10 items-center">
                  <div>
                    <div className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-6" style={{ background: 'rgba(30,120,255,.15)', border: '1px solid rgba(30,120,255,.3)', color: '#4d9fff', letterSpacing: '0.12em' }}>
                      Partner Resource
                    </div>
                    <h2 className="text-3xl md:text-4xl font-black text-white mb-5" style={{ letterSpacing: '-0.04em', lineHeight: 1.1 }}>
                      Got a Claim Denied?<br />
                      <span style={{ color: '#4d9fff' }}>We Can Help.</span>
                    </h2>
                    <p className="text-base leading-relaxed mb-8" style={{ color: 'rgba(255,255,255,.55)' }}>
                      Independent contractors and owner-operators get stuck with denied claims, delayed payments, and confusing paperwork every day.
                      <strong className="text-white"> ClaimGuard Help</strong> is built specifically for contractors who need someone in their corner — not a lawyer, not an insurance company — just straight answers and real help getting what you&apos;re owed.
                    </p>
                    <div className="inline-flex items-center gap-2 font-bold text-sm px-6 py-3 rounded-xl transition-colors" style={{ background: '#1e78ff', color: '#fff', borderRadius: '12px' }}>
                      Get Help with Your Claim →
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { Icon: Ban, title: 'Claim Denied?', desc: 'Understand why and what your options are to fight back.' },
                      { Icon: DollarSign, title: 'Unpaid Invoices', desc: 'Brokers and carriers stiffing you on payment? Know your rights.' },
                      { Icon: FileText, title: 'Confusing Paperwork', desc: 'We break down the forms, filings, and deadlines in plain English.' },
                      { Icon: Zap, title: 'Fast Answers', desc: 'No waiting. Get guidance on your situation right away.' },
                    ].map((card) => (
                      <SpotlightCard key={card.title} blue className="p-5 rounded-2xl" style={{ background: 'rgba(30,120,255,.07)', border: '1px solid rgba(30,120,255,.15)' }}>
                        <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: 'rgba(30,120,255,.12)', border: '1px solid rgba(30,120,255,.25)' }}>
                          <card.Icon size={20} strokeWidth={1.75} color="#4d9fff" />
                        </span>
                        <p className="text-sm font-black text-white mb-1">{card.title}</p>
                        <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,.45)' }}>{card.desc}</p>
                      </SpotlightCard>
                    ))}
                  </div>
                </div>
                <div className="mt-8 pt-8 flex items-center gap-2 text-xs" style={{ borderTop: '1px solid rgba(30,120,255,.15)', color: 'rgba(255,255,255,.3)' }}>
                  <span style={{ color: '#4d9fff' }}>claimguardhelp.com</span>
                  <span>· Independent contractor claims assistance</span>
                </div>
              </div>
            </a>
          </FadeUp>
        </div>
      </section>

      {/* ── Contact ── */}
      <section id="contact" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-16">
            <FadeUp>
              <div className="label mb-5">Get In Touch</div>
              <h2 className="text-4xl font-black text-white mb-6" style={{ letterSpacing: '-0.04em', lineHeight: 1.1, fontFamily: 'var(--font-display)' }}>
                Ready to Get<br /><span className="grad-red">Started?</span>
              </h2>
              <p className="text-base leading-relaxed mb-8" style={{ color: 'var(--muted)' }}>
                Tell us what you need — delivery, junk removal, eviction cleanout, or anything in between — and we&apos;ll get back to you within one business day. We work with retailers, property managers, warehouses, and logistics companies of all sizes. For COI requests, select &quot;COI Request&quot; in the dropdown.
              </p>
              <div className="space-y-4">
                <a href="tel:+18179094312" className="flex items-center gap-3 text-base font-bold text-white transition hover:opacity-80">
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--red)' }}><Phone size={17} strokeWidth={2} color="#fff" /></span>
                  Call or text (817) 909-4312
                </a>
                <a href="mailto:info@jkissllc.com" className="flex items-center gap-3 text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}><Mail size={17} strokeWidth={1.75} color="#ff6680" /></span>
                  info@jkissllc.com
                </a>
                <a href="mailto:timmothy@jkissllc.com" className="flex items-center gap-3 text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}><User size={17} strokeWidth={1.75} color="#ff6680" /></span>
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
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-2 text-sm" style={{ color: 'var(--muted)' }}>
              <a href="/quote" className="transition hover:text-white">Instant Quote</a>
              <a href="/track" className="transition hover:text-white">Track My Pickup</a>
              <a href="/coi" className="transition hover:text-white">Request COI</a>
              <a href="/safety" className="transition hover:text-white">Safety / FMCSA</a>
              <a href="/reviews" className="transition hover:text-white">Reviews</a>
              <a href="/start-your-carrier" className="transition hover:text-white">Carrier Guide</a>
              <a href="#services" className="transition hover:text-white">Services</a>
              <a href="#coverage" className="transition hover:text-white">Coverage</a>
              <a href="#contact" className="transition hover:text-white">Contact</a>
            </div>
          </div>
          <div className="pt-8 text-xs flex flex-col md:flex-row items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.25)' }}>
            <p>© {new Date().getFullYear()} J Kiss LLC. All rights reserved.</p>
            <div className="flex gap-4">
              <a href="tel:+18179094312" className="transition hover:text-white">(817) 909-4312</a>
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
  const [service, setService] = useState('')

  // Pre-select the service when arriving from a "Book …" link (e.g. /?service=Junk%20Removal#contact)
  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get('service')
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing form state from URL on mount
    if (preset) setService(preset)
  }, [])

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
          <div className="mb-4 flex justify-center"><CheckCircle2 size={44} strokeWidth={1.75} color="#ff6680" /></div>
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
            <select name="service" value={service} onChange={(e) => setService(e.target.value)} style={{ ...iStyle, cursor: 'pointer' }}>
              <option value="">Select a service</option>
              <option>Box-Truck Freight</option>
              <option>White-Glove Last-Mile</option>
              <option>Same-Day / Next-Day Run</option>
              <option>Retail Replenishment</option>
              <option>Junk Removal</option>
              <option>Eviction / Property Cleanout</option>
              <option>COI Request</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Your Budget <span style={{ color: 'rgba(255,255,255,.35)', fontWeight: 400 }}>(optional)</span></label>
            <select name="budget" style={{ ...iStyle, cursor: 'pointer' }}>
              <option value="">Select a budget range</option>
              <option>Under $150</option>
              <option>$150 – $300</option>
              <option>$300 – $600</option>
              <option>$600 – $1,000</option>
              <option>$1,000+</option>
              <option>Not sure — need a quote</option>
            </select>
            <p className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,.4)' }}>
              A ballpark helps us plan the right crew and truck. Final price depends on the load, access, and disposal fees — this isn&apos;t a locked-in quote.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Message</label>
            <textarea name="message" rows={4} placeholder="Tell us about your job — what, where, and when..." style={{ ...iStyle, resize: 'vertical' }} />
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
