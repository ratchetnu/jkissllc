import Reveal from '../Reveal';
import { CAPABILITIES, type Capability } from '../../lib/opspilot';

/**
 * The OpsPilot capability grid. Rendered on /opspilot and /start-your-carrier
 * from the same catalog (lib/opspilot.ts) so the two never disagree.
 *
 * `tone` picks the card treatment for the surrounding surface — dark bands get
 * the translucent card, light sections get the paper card.
 */
export default function CapabilityGrid({
  tone = 'dark',
  capabilities = CAPABILITIES,
  minColumn = 232,
}: {
  tone?: 'dark' | 'light';
  capabilities?: Capability[];
  /** Min card width before the grid drops a column. */
  minColumn?: number;
}) {
  const cardClass = tone === 'dark' ? 'ops-card' : 'ops-card-light';
  const titleColor = tone === 'dark' ? '#fff' : 'var(--ink)';
  const descColor = tone === 'dark' ? 'var(--muted)' : 'var(--ink-muted)';

  return (
    <div
      style={{
        display: 'grid',
        gap: 14,
        gridTemplateColumns: `repeat(auto-fill, minmax(${minColumn}px, 1fr))`,
      }}
    >
      {capabilities.map((c, i) => (
        // Stagger caps at 8 so the last cards in a 16-card grid don't crawl in.
        <Reveal key={c.title} delay={Math.min(i, 8) * 45}>
          <div className={cardClass} style={{ padding: 20, height: '100%' }}>
            <span className="ops-icon">
              <c.Icon size={18} strokeWidth={1.6} />
            </span>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 600,
                fontSize: '0.95rem',
                letterSpacing: '-0.015em',
                color: titleColor,
                marginTop: 15,
              }}
            >
              {c.title}
            </h3>
            <p style={{ color: descColor, fontSize: 13.2, lineHeight: 1.55, marginTop: 7 }}>{c.desc}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
