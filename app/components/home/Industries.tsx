import { Home, Building2, HardHat, Hammer, Store, KeyRound, Warehouse, Briefcase, ShoppingBag, LineChart } from 'lucide-react';
import Reveal from '../Reveal';

const INDUSTRIES = [
  { icon: Home, name: 'Homeowners', line: 'Cleanouts, delivery, and hauling done with respect for your home.' },
  { icon: Building2, name: 'Apartment Communities', line: 'Fast unit turnovers and bulk trash-outs between residents.' },
  { icon: HardHat, name: 'Contractors', line: 'Material drop-offs and jobsite debris hauled on your schedule.' },
  { icon: Hammer, name: 'Builders', line: 'Punch-list runs and post-build cleanup, ready for handover.' },
  { icon: Store, name: 'Retailers', line: 'Store-to-store transfers, replenishment, and customer delivery.' },
  { icon: KeyRound, name: 'Property Managers', line: 'Discreet eviction and foreclosure cleanouts, broom-clean.' },
  { icon: Warehouse, name: 'Warehouses', line: 'Overflow moves and box-truck runs where a 53-footer won’t fit.' },
  { icon: Briefcase, name: 'Commercial Offices', line: 'Furniture moves, decommissions, and clear-outs after hours.' },
  { icon: ShoppingBag, name: 'Small Businesses', line: 'Reliable local delivery without your own truck or crew.' },
  { icon: LineChart, name: 'Real Estate Investors', line: 'Turn properties faster — cleared, cleaned, and ready to list.' },
];

/** Light "Industries We Serve" — a compact, credible grid of who we help. */
export default function Industries() {
  return (
    <section className="section section-light">
      <div className="wrap">
        <Reveal><span className="eyebrow">Who we serve</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, maxWidth: '20ch' }}>
          One crew, built for every kind of job.
        </Reveal>
        <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '52ch' }}>
          From a single-item pickup to a standing commercial route, the same standards apply:
          show up, communicate, and get it done right.
        </Reveal>

        <div style={{ marginTop: 44, display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))' }}>
          {INDUSTRIES.map((ind, i) => (
            <Reveal key={ind.name} delay={Math.min(i, 6) * 45}>
              <div
                className="card-light"
                style={{ padding: 22, height: '100%', display: 'flex', gap: 14, alignItems: 'flex-start' }}
              >
                <div
                  aria-hidden
                  style={{ width: 42, height: 42, flexShrink: 0, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', border: '1px solid var(--line-ink)', color: 'var(--red)' }}
                >
                  <ind.icon size={19} />
                </div>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '1rem', color: 'var(--ink)' }}>{ind.name}</h3>
                  <p style={{ color: 'var(--ink-muted)', fontSize: 13.5, lineHeight: 1.5, marginTop: 5 }}>{ind.line}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
