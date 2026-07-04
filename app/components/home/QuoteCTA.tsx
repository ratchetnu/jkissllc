import Link from 'next/link';
import { ArrowRight, Phone } from 'lucide-react';
import Reveal from '../Reveal';

/** Dark conversion band driving to the wizard, with a call fallback. */
export default function QuoteCTA() {
  return (
    <section className="section section-dark" style={{ position: 'relative', overflow: 'hidden' }}>
      <div className="hero-mesh" aria-hidden style={{ position: 'absolute', inset: 0 }} />
      <div className="hero-grid" aria-hidden style={{ position: 'absolute', inset: 0 }} />
      <div className="wrap" style={{ position: 'relative', textAlign: 'center', maxWidth: '56rem' }}>
        <Reveal><span className="eyebrow" style={{ justifyContent: 'center' }}>Let’s plan your job</span></Reveal>
        <Reveal as="h2" delay={70} className="display-1" style={{ marginTop: 18, color: '#fff', fontSize: 'clamp(2.2rem, 5vw, 3.6rem)' }}>
          Ready to get it <span className="grad-red">handled?</span>
        </Reveal>
        <Reveal as="p" delay={140} className="lede" style={{ marginTop: 18, marginLeft: 'auto', marginRight: 'auto', maxWidth: '46ch' }}>
          Build your quote in about two minutes. See an honest price range, pick your window, and
          we’ll take it from there.
        </Reveal>
        <Reveal delay={210} style={{ marginTop: 34, display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/quote" className="btn" style={{ padding: '16px 34px', fontSize: 15 }}>
            Get My Quote <ArrowRight size={17} aria-hidden />
          </Link>
          <a href="tel:+18179094312" className="btn-ghost" style={{ padding: '16px 34px', fontSize: 15 }}>
            <Phone size={16} aria-hidden /> (817) 909-4312
          </a>
        </Reveal>
      </div>
    </section>
  );
}
