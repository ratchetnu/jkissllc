import { OpsPilotMark, OpsPilotWordmark } from './OpsPilotMark';
import { OPSPILOT_TAGLINE } from '../../lib/opspilot';

/**
 * The "Powered by OpsPilot™" band that sits above the footer close on every page.
 *
 * This is the quietest possible statement of the platform: a hairline, a mark, a
 * tagline, and a text link. It must never read as an ad. If someone notices it,
 * the intended reaction is "…what are they running?" — not "they're selling me
 * software." Resist adding colour, buttons, or product copy here.
 *
 * `variant="compact"` is for pages with their own slim inline footer (the carrier
 * guide), where the full band would overwhelm the close.
 */
export default function PoweredByBand({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  if (variant === 'compact') {
    return (
      <a
        href="/operion"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          textDecoration: 'none',
          color: 'rgba(255,255,255,.4)',
          fontSize: 12,
          transition: 'color .2s ease',
        }}
      >
        <OpsPilotMark size={14} />
        <span>
          Powered by <OpsPilotWordmark tm style={{ color: 'rgba(255,255,255,.62)', fontWeight: 600 }} />
        </span>
      </a>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
        padding: '26px 0',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        marginBottom: 36,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
        <span style={{ color: 'var(--ops-steel)', display: 'inline-flex' }}>
          <OpsPilotMark size={30} />
        </span>
        <div>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '.16em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,.42)',
            }}
          >
            Powered by
          </p>
          <p style={{ marginTop: 3, lineHeight: 1.25 }}>
            <OpsPilotWordmark tm style={{ fontSize: 18, color: '#fff' }} />
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{OPSPILOT_TAGLINE}</p>
        </div>
      </div>

      <a
        href="/operion"
        className="btn-ghost"
        style={{ padding: '10px 20px', fontSize: 13, borderRadius: 10 }}
      >
        Learn more
      </a>
    </div>
  );
}
