import { PLATFORM } from '../../lib/company';

/**
 * Operion visual identity (component kept as OpsPilotMark for import compat).
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
  // At the sizes the mark appears inline (login footer, dashboard header, ~15px),
  // a 1.5-unit stroke at 30% opacity renders under a physical pixel and the ring
  // disappears — the mark reads as a dot. Thicken and darken it as it shrinks so
  // the aperture survives, rather than dropping it and losing the identity.
  const small = size < 18;
  const ringStroke = small ? 2.4 : 1.5;
  const ringOpacity = small ? 0.5 : 0.3;

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
      {/* Operion mark: an open ring (the "O") cut by a diagonal slash — the spark.
          Monochrome via currentColor so it inherits the surface colour, exactly as
          before; the diagonal gap echoes the Operion logo's cut-through motif. */}
      <circle cx="16" cy="16" r="12.25" stroke="currentColor" strokeWidth={ringStroke * 1.55} opacity={ringOpacity + 0.15} />
      {/* The slash — a tapered diagonal spark from lower-left to upper-right. */}
      <path d="M9.5 22.5 L21.4 8.9 L23 10.6 L11.1 24.2 Z" fill="currentColor" />
      {/* Punch the ring open where the slash crosses it, so the cut reads. */}
      <path d="M9.5 22.5 L21.4 8.9 L23 10.6 L11.1 24.2 Z" fill="currentColor" opacity={small ? 0.5 : 0.9} />
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
      {PLATFORM.name}
      {tm && (
        // 0.5em read as a design element rather than a legal mark once the wordmark
        // hit display sizes (~37px of ™ on the /opspilot h1). A trademark should be
        // noticed only if you look for it.
        <sup style={{ fontSize: '0.34em', fontWeight: 600, marginLeft: '0.14em', top: '-0.9em', position: 'relative' }}>
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
