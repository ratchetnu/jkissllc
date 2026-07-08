import { ArrowRight } from 'lucide-react';
import Reveal from '../Reveal';
import { OpsPilotMark, OpsPilotWordmark } from '../opspilot/OpsPilotMark';
import { pickCapabilities, HOMEPAGE_CAPABILITIES } from '../../lib/opspilot';

/**
 * Homepage: "Powered by OpsPilot".
 *
 * Deliberately placed BELOW the conversion path (hero → services → how it works →
 * trust → proof → coverage). A customer who came to book a delivery has already
 * had every chance to convert before they reach this. What it earns us is the
 * second thought on the way out: "these people run real software."
 *
 * Six capabilities, not sixteen. The full catalog lives on /opspilot.
 */
export default function PoweredByOpsPilot() {
  const caps = pickCapabilities(HOMEPAGE_CAPABILITIES);

  return (
    <section className="section section-alt">
      <div className="wrap">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* ── Statement ── */}
          <div>
            <Reveal>
              <span className="eyebrow">Proprietary technology</span>
            </Reveal>

            <Reveal delay={70}>
              <h2 className="display-2" style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--ink)', display: 'inline-flex' }}>
                  <OpsPilotMark size={38} className="ops-mark-in" />
                </span>
                <span>
                  Powered by <OpsPilotWordmark />
                </span>
              </h2>
            </Reveal>

            <Reveal as="p" delay={130} className="lede" style={{ marginTop: 18, maxWidth: '54ch' }}>
              Every quote, dispatch, crew assignment, route confirmation, claim, financial calculation,
              and customer notification is managed through our proprietary operations platform.
            </Reveal>

            <Reveal delay={190}>
              <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span className="ops-badge">Built In-House</span>
                <a
                  href="/opspilot"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    textDecoration: 'none',
                  }}
                >
                  Learn more <ArrowRight size={15} />
                </a>
              </div>
            </Reveal>
          </div>

          {/* ── Instrumentation ── */}
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {caps.map((c, i) => (
              <Reveal key={c.title} delay={100 + Math.min(i, 6) * 55}>
                <div className="ops-card-light" style={{ padding: 18, height: '100%' }}>
                  <span className="ops-icon" style={{ width: 34, height: 34, borderRadius: 9 }}>
                    <c.Icon size={16} strokeWidth={1.6} />
                  </span>
                  <p
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600,
                      fontSize: '0.875rem',
                      letterSpacing: '-0.012em',
                      color: 'var(--ink)',
                      marginTop: 13,
                    }}
                  >
                    {c.title}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
