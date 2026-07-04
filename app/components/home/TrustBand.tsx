import { MessageSquare, BadgeDollarSign, Clock, ShieldCheck, BadgeCheck, Sparkles, Wrench, Receipt } from 'lucide-react';
import Reveal from '../Reveal';

const TRUST = [
  { icon: MessageSquare, title: 'Professional Communication', body: 'Texts and updates at every step — you’re never left wondering where your job stands.' },
  { icon: BadgeDollarSign, title: 'Transparent Quotes', body: 'An honest range up front, based on the real job — not a lowball you regret later.' },
  { icon: Clock, title: 'On-Time Arrival', body: 'We show up in the window we promised, and we tell you the moment we’re rolling.' },
  { icon: ShieldCheck, title: 'Careful Handling', body: 'Padded, wrapped, and placed with care — your belongings and property get respect.' },
  { icon: BadgeCheck, title: 'Licensed & Insured', body: 'Fully licensed and insured, so you’re covered before we ever lift a thing.' },
  { icon: Sparkles, title: 'Respect for Your Property', body: 'Floors protected, doorways cleared, and nothing left behind but clean space.' },
  { icon: Wrench, title: 'Problem Solvers', body: 'Tight stairs, heavy items, odd layouts — we figure it out instead of walking away.' },
  { icon: Receipt, title: 'No Surprise Fees', body: 'The number we quote is the number you pay — barring changes you approve first.' },
];

/** Dark "Why Customers Choose J KISS" trust band — evidence of the experience. */
export default function TrustBand() {
  return (
    <section className="section section-dark" style={{ position: 'relative', overflow: 'hidden' }}>
      <div className="hero-mesh" aria-hidden style={{ position: 'absolute', inset: 0, opacity: 0.5 }} />
      <div className="wrap" style={{ position: 'relative' }}>
        <Reveal><span className="eyebrow">Why customers choose us</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, maxWidth: '18ch', color: '#fff' }}>
          Trust, shown — not claimed.
        </Reveal>
        <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '52ch' }}>
          Anyone can say they’re professional. Here’s what it actually looks like on every job.
        </Reveal>

        <div style={{ marginTop: 44, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))' }}>
          {TRUST.map((t, i) => (
            <Reveal key={t.title} delay={Math.min(i, 6) * 50}>
              <div className="glass-card" style={{ padding: 24, height: '100%' }}>
                <div
                  aria-hidden
                  style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)', color: 'var(--red-glow)' }}
                >
                  <t.icon size={20} />
                </div>
                <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.02rem', color: '#fff', marginTop: 16, letterSpacing: '-0.01em' }}>{t.title}</h3>
                <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.55, marginTop: 8 }}>{t.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
