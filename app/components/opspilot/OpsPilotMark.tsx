/**
 * OpsPilot visual identity.
 *
 * The mark is a compass needle inside a control-center aperture: navigation +
 * instrumentation, drawn from primitives only. Deliberately NOT a truck, box,
 * gear, or anything freight-specific — OpsPilot is the platform layer, and one
 * day it will run businesses that have never touched a box truck.
 *
 * Everything is stroked/filled with `currentColor`, so the mark inherits the
 * colour of whatever surface it lands on (white on dark bands, ink on light
 * sections, red when it needs to tie back to J KISS). No hardcoded fills.
 */

type MarkProps = {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Decorative by default; pass a title to expose it to assistive tech. */
  title?: string;
};

export function OpsPilotMark({ size = 24, className, style, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      style={style}
      fill="none"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* Aperture ring — the control center */}
      <circle cx="16" cy="16" r="12.25" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      {/* Needle, north — the bearing */}
      <path d="M16 5.6 L18.7 16 L13.3 16 Z" fill="currentColor" />
      {/* Needle, south — the counterweight */}
      <path d="M16 26.4 L18.7 16 L13.3 16 Z" fill="currentColor" opacity="0.32" />
    </svg>
  );
}

/**
 * "OpsPilot" set in the display face with optical tracking. `tm` renders the
 * trademark at a size that reads as a legal mark, not a design element.
 */
export function OpsPilotWordmark({
  tm = false,
  className,
  style,
}: {
  tm?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--font-display)',
        fontWeight: 700,
        letterSpacing: '-0.03em',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      OpsPilot
      {tm && (
        <sup style={{ fontSize: '0.5em', fontWeight: 600, marginLeft: '0.12em', top: '-0.55em', position: 'relative' }}>
          ™
        </sup>
      )}
    </span>
  );
}

/** Mark + wordmark, optically aligned. The canonical way to show the brand. */
export function OpsPilotLockup({
  size = 22,
  tm = false,
  gap = 9,
  className,
  style,
  wordmarkStyle,
}: {
  size?: number;
  tm?: boolean;
  gap?: number;
  className?: string;
  style?: React.CSSProperties;
  wordmarkStyle?: React.CSSProperties;
}) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap, ...style }}>
      <OpsPilotMark size={size} />
      <OpsPilotWordmark tm={tm} style={{ fontSize: size * 0.86, lineHeight: 1, ...wordmarkStyle }} />
    </span>
  );
}
