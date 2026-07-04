import Link from 'next/link';
import { ArrowRight, Clock, Users, Tag } from 'lucide-react';
import Reveal from '../Reveal';
import { SERVICES } from '../../lib/services';

/** Light "Choose Your Service" — large, outcome-first cards that deep-link into the wizard. */
export default function ChooseService() {
  return (
    <section id="services" className="section section-light">
      <div className="wrap">
        <Reveal><span className="eyebrow">What we haul</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, maxWidth: '18ch' }}>
          Pick the job. We handle the rest.
        </Reveal>
        <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '52ch' }}>
          Every service starts the same way — a clear quote, a scheduled window, and a crew that
          keeps you posted from dispatch to done.
        </Reveal>

        <div
          style={{
            marginTop: 44,
            display: 'grid',
            gap: 18,
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(304px, 100%), 1fr))',
          }}
        >
          {SERVICES.map((s, i) => (
            <Reveal key={s.id} delay={Math.min(i, 6) * 55}>
              <Link
                href={`/quote?service=${s.id}`}
                className="card-light"
                style={{ display: 'flex', flexDirection: 'column', padding: 26, height: '100%', textDecoration: 'none' }}
              >
                <div
                  aria-hidden
                  style={{
                    width: 48, height: 48, borderRadius: 13, display: 'grid', placeItems: 'center',
                    background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.16)', color: 'var(--red)',
                  }}
                >
                  <s.icon size={22} />
                </div>

                <div style={{ marginTop: 18, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--red)' }}>
                  {s.name}
                </div>
                <h3 className="display-2" style={{ fontSize: '1.32rem', lineHeight: 1.15, marginTop: 6 }}>
                  {s.outcome}
                </h3>
                <p style={{ color: 'var(--ink-muted)', fontSize: 14.5, lineHeight: 1.55, marginTop: 10, flex: 1 }}>
                  {s.blurb}
                </p>

                <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, color: 'var(--ink-body)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Users size={14} style={{ color: 'var(--ink-muted)' }} aria-hidden /> {s.forWho}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Clock size={14} style={{ color: 'var(--ink-muted)' }} aria-hidden /> {s.turnaround}</span>
                  {s.from && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700, color: 'var(--ink)' }}><Tag size={14} style={{ color: 'var(--red)' }} aria-hidden /> {s.from}</span>}
                </div>

                <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line-ink)' }}>
                  {s.bookable ? (
                    <span
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 8,
                        padding: '11px 20px', background: 'var(--red)', color: '#fff',
                        borderRadius: 10, fontWeight: 700, fontSize: 14,
                      }}
                    >
                      Book Now
                      <ArrowRight size={16} aria-hidden />
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>
                      Get a quote
                      <ArrowRight size={16} style={{ color: 'var(--red)' }} aria-hidden />
                    </span>
                  )}
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
