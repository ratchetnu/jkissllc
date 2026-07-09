import type { Metadata } from 'next'
import { COMPANY, CREDENTIALS_DOT } from '../../lib/company';
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CITIES, findCity } from '../../lib/cities'

const SITE_URL = COMPANY.siteUrl

export function generateStaticParams() {
  return CITIES.map(c => ({ city: c.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const { city: slug } = await params
  const city = findCity(slug)
  if (!city) return {}
  const title = `Box-Truck Delivery in ${city.name}, TX | ${COMPANY.legalName}`
  const description = `Box-truck freight, white-glove last-mile, and same-day delivery throughout ${city.name}. Furniture, appliances, building materials. Trusted by major retailers across DFW. USDOT ${COMPANY.usdot}.`
  return {
    title,
    description,
    keywords: [
      `box truck delivery ${city.name}`,
      `last mile delivery ${city.name} TX`,
      `furniture delivery ${city.name}`,
      `appliance delivery ${city.name}`,
      `white glove delivery ${city.name}`,
      ...city.neighborhoods.map(n => `${n} ${city.name} delivery`),
    ].join(', '),
    alternates: { canonical: `${SITE_URL}/box-truck-delivery/${city.slug}` },
    openGraph: {
      type: 'website',
      url: `${SITE_URL}/box-truck-delivery/${city.slug}`,
      title,
      description,
      siteName: COMPANY.legalName,
      images: [{ url: '/og-image.jpg', width: 1200, height: 630, alt: title }],
    },
    twitter: { card: 'summary_large_image', title, description, images: ['/og-image.jpg'] },
  }
}

export default async function CityPage({ params }: { params: Promise<{ city: string }> }) {
  const { city: slug } = await params
  const city = findCity(slug)
  if (!city) notFound()

  const services = [
    { icon: '🚚', title: 'Box-Truck Freight', desc: `Palletized freight delivery throughout ${city.name} in 16–26 ft straight trucks. Dock-to-dock or dock-to-door, scheduled or same-day.` },
    { icon: '📦', title: 'White-Glove Last-Mile', desc: `Two-person crew delivery direct into ${city.name} homes. Room-of-choice placement, unbox, and packaging removal.` },
    { icon: '⏱', title: 'Same-Day & Next-Day Runs', desc: `Time-critical delivery within ${city.name} and surrounding suburbs. Real-time driver updates and live appointment tracking.` },
    { icon: '🏬', title: 'Retail Replenishment', desc: `Store-to-store transfers, dock-to-store replenishment, and customer pickups across ${city.name} retail locations.` },
  ]

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Local-business JSON-LD scoped to this city */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'MovingCompany',
            name: `${COMPANY.legalName} — ${city.name} Box-Truck Delivery`,
            description: `Box-truck delivery and white-glove last-mile service throughout ${city.name}, Texas.`,
            url: `${SITE_URL}/box-truck-delivery/${city.slug}`,
            email: COMPANY.email,
            identifier: [
              { '@type': 'PropertyValue', propertyID: 'USDOT', value: COMPANY.usdot },
              { '@type': 'PropertyValue', propertyID: 'MC', value: COMPANY.mc },
            ],
            areaServed: { '@type': 'City', name: `${city.name}, TX` },
            address: { '@type': 'PostalAddress', addressLocality: city.name, addressRegion: 'TX', addressCountry: 'US' },
            geo: { '@type': 'GeoCoordinates', latitude: city.lat, longitude: city.lon },
            knowsAbout: [
              'Box Truck Delivery',
              'White-Glove Last-Mile Delivery',
              'Furniture Delivery',
              'Appliance Delivery',
              'Building Materials Delivery',
              ...city.neighborhoods,
            ],
          }),
        }}
      />

      {/* Nav strip */}
      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
          </Link>
          <Link href="/#contact" className="btn" style={{ padding: '10px 20px', fontSize: '13px' }}>Get a Quote</Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative pt-40 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #0b0b0c 0%, #1a0508 100%)' }} />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 70% 30%, rgba(224,0,42,0.18), transparent 55%)' }} />
        <div className="relative max-w-4xl mx-auto">
          <Link href="/#coverage" className="text-xs font-bold uppercase tracking-widest mb-6 inline-block transition hover:text-white" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>
            ← All DFW Coverage
          </Link>
          <div className="label mb-6">Service Area · {city.name}, TX</div>
          <h1 className="font-black text-white mb-6" style={{ fontSize: 'clamp(2.4rem, 5vw, 4rem)', lineHeight: 1.05, letterSpacing: '-0.045em', fontFamily: 'var(--font-display)' }}>
            Box-Truck Delivery<br />
            in <span style={{ color: 'var(--red)' }}>{city.name}</span>
          </h1>
          <p className="text-lg max-w-2xl mb-8" style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
            {city.blurb}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/#contact" className="btn">Schedule a Delivery →</Link>
            <Link href="/#services" className="btn-ghost">All Services</Link>
          </div>
          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-xs font-mono" style={{ color: 'rgba(255,255,255,.4)' }}>
            <span>US DOT {COMPANY.usdot}</span>
            <span>MC {COMPANY.mc}</span>
            <span>Licensed &amp; Insured · TX</span>
          </div>
        </div>
      </section>

      {/* Services in this city */}
      <section className="py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="label mb-4">What We Deliver in {city.name}</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-12" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
            Four Services. <span style={{ color: 'var(--red)' }}>One Box Truck.</span>
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {services.map(s => (
              <div key={s.title} className="glass-card p-8" style={{ borderRadius: '20px' }}>
                <span className="text-3xl mb-4 block">{s.icon}</span>
                <h3 className="text-lg font-black text-white mb-3" style={{ letterSpacing: '-0.02em' }}>{s.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Neighborhoods we serve */}
      <section className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <div className="label mb-4">Neighborhoods</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
            Where We Run in {city.name}
          </h2>
          <p className="text-base mb-10 max-w-xl" style={{ color: 'var(--muted)' }}>
            Daily box-truck routes throughout these {city.name} neighborhoods. Don&apos;t see yours? Most {city.name} addresses are still well within our service radius.
          </p>
          <div className="flex flex-wrap gap-2">
            {city.neighborhoods.map(n => (
              <span key={n} className="px-4 py-2 rounded-full text-sm font-semibold" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: '#fff' }}>
                {n}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Cross-link to other cities */}
      <section className="py-16 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <p className="text-xs font-bold uppercase tracking-widest mb-5" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Also Serving</p>
          <div className="flex flex-wrap gap-2">
            {CITIES.filter(c => c.slug !== city.slug).map(c => (
              <Link key={c.slug} href={`/box-truck-delivery/${c.slug}`}
                className="px-4 py-2 rounded-full text-sm font-semibold transition-colors hover:bg-white/10"
                style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--muted)' }}>
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="label mb-5 mx-auto">Ready When You Are</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-5" style={{ letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
            Schedule a {city.name} Delivery.
          </h2>
          <p className="text-base mb-8" style={{ color: 'var(--muted)' }}>
            Get a quote in one business day. Same-day capacity available for time-critical runs.
          </p>
          <Link href="/#contact" className="btn">Get a Quote →</Link>
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT} ·{' '}
        <Link href="/" className="hover:text-white">{COMPANY.domain}</Link>
      </footer>
    </main>
  )
}
