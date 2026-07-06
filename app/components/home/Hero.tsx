import Link from 'next/link';
import { ShieldCheck, MapPin, MessageSquare, BadgeDollarSign, Zap } from 'lucide-react';
import Reveal from '../Reveal';

const BADGES = [
  { icon: ShieldCheck, label: 'Licensed & Insured' },
  { icon: MapPin, label: 'DFW Coverage' },
  { icon: MessageSquare, label: 'Professional Communication' },
  { icon: BadgeDollarSign, label: 'Transparent Pricing' },
  { icon: Zap, label: 'Fast Response' },
];

/** Cinematic dark hero — the "logistics you can see" opening statement. */
export default function Hero() {
  return (
    <section
      className="section-dark"
      style={{ position: 'relative', overflow: 'hidden', minHeight: '100svh', display: 'flex', alignItems: 'center' }}
    >
      {/* Animated backdrop (defined in globals.css) */}
      <div className="hero-mesh" aria-hidden style={{ position: 'absolute', inset: 0 }} />
      <div className="hero-grid" aria-hidden style={{ position: 'absolute', inset: 0 }} />
      {/* Fade the backdrop into the content + into the next (light) section */}
      <div
        aria-hidden
        style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(11,11,12,.35) 0%, rgba(11,11,12,.15) 45%, var(--bg) 100%)' }}
      />

      <div className="wrap" style={{ position: 'relative', paddingTop: 128, paddingBottom: 88 }}>
        <Reveal>
          <span className="eyebrow">Box-Truck&nbsp;Delivery ·&nbsp;Junk&nbsp;Removal ·&nbsp;Cleanouts</span>
        </Reveal>

        <Reveal as="h1" delay={80} className="display-1" style={{ marginTop: 22, maxWidth: '15ch' }}>
          Professional hauling <span className="grad-red">without the headaches.</span>
        </Reveal>

        <Reveal as="p" delay={160} className="lede" style={{ marginTop: 24, maxWidth: '58ch' }}>
          We move what matters — junk removal, brush, appliance &amp; furniture delivery, local moves,
          and commercial box-truck runs across Dallas–Fort Worth. Booked in minutes, and communicated
          the whole way through.
        </Reveal>

        <Reveal delay={240} style={{ marginTop: 36, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Link href="/quote" className="btn" style={{ padding: '16px 32px', fontSize: 15 }}>
            Get My Quote
          </Link>
          <a href="#services" className="btn-ghost" style={{ padding: '16px 32px', fontSize: 15 }}>
            See Our Services
          </a>
        </Reveal>

        <Reveal delay={320} style={{ marginTop: 48, display: 'flex', gap: '12px 28px', flexWrap: 'wrap' }}>
          {BADGES.map((b) => (
            <span key={b.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13, fontWeight: 600 }}>
              <b.icon size={16} style={{ color: 'var(--red-glow)' }} aria-hidden />
              {b.label}
            </span>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
