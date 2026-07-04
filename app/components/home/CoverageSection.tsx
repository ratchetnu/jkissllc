'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { CITIES } from '../../lib/cities';
import Reveal from '../Reveal';

const CoverageMap = dynamic(() => import('../CoverageMap'), {
  ssr: false,
  loading: () => (
    <div className="glass-card flex items-center justify-center" style={{ borderRadius: '20px', aspectRatio: '4/3' }}>
      <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Loading map…</span>
    </div>
  ),
});

/** Dark Coverage band — interactive DFW map + city list (map is dark-styled). */
export default function CoverageSection() {
  return (
    <section id="coverage" className="section section-dark">
      <div className="wrap">
        <Reveal><span className="eyebrow">Service area</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, color: '#fff' }}>
          Across the DFW metroplex.
        </Reveal>
        <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '48ch' }}>
          We run throughout Dallas–Fort Worth and the surrounding cities. Tap any city for local details.
        </Reveal>

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-8 items-start" style={{ marginTop: 40 }}>
          <Reveal><CoverageMap /></Reveal>
          <Reveal delay={120}>
            <div className="glass-card" style={{ padding: 24, borderRadius: 20 }}>
              <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.14em', marginBottom: 16 }}>Cities we serve</p>
              <div className="grid grid-cols-2 gap-2">
                {CITIES.map((city) => (
                  <Link
                    key={city.slug}
                    href={`/box-truck-delivery/${city.slug}`}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/5"
                    style={{ border: '1px solid var(--line)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--red)' }} />
                    <span className="text-sm font-semibold text-white">{city.name}</span>
                  </Link>
                ))}
              </div>
              <p className="mt-5 text-xs" style={{ color: 'var(--muted)' }}>
                Don&apos;t see your city? <a href="#contact" className="font-semibold hover:text-white transition-colors" style={{ color: 'var(--red)' }}>Ask us</a> — we can often still help.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
