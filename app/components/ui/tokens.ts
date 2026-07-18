// ── Operion design tokens — the TypeScript mirror ────────────────────────────
//
// The canonical values live as CSS custom properties in app/globals.css. This
// module exposes them to the ~84% of the app that styles with inline `style={{}}`
// objects, so inline code can reference ONE vocabulary (`tokens.radius.md`)
// instead of re-typing literals. Every value here is a `var(--…)` reference — the
// CSS file stays the single source of truth; this is just typed sugar over it.
//
// Usage:
//   import { tokens as t } from '@/app/components/ui/tokens'
//   <div style={{ padding: t.space[4], borderRadius: t.radius.lg, boxShadow: t.shadow.md }} />

export const tokens = {
  /** 4pt spacing grid. */
  space: {
    0: 'var(--space-0)', 1: 'var(--space-1)', 2: 'var(--space-2)', 3: 'var(--space-3)',
    4: 'var(--space-4)', 5: 'var(--space-5)', 6: 'var(--space-6)', 8: 'var(--space-8)',
    10: 'var(--space-10)', 12: 'var(--space-12)', 16: 'var(--space-16)', 20: 'var(--space-20)',
  },
  radius: {
    xs: 'var(--radius-xs)', sm: 'var(--radius-sm)', md: 'var(--radius-md)',
    lg: 'var(--radius-lg)', xl: 'var(--radius-xl)', '2xl': 'var(--radius-2xl)',
    pill: 'var(--radius-pill)',
  },
  shadow: {
    xs: 'var(--shadow-xs)', sm: 'var(--shadow-sm)', md: 'var(--shadow-md)', lg: 'var(--shadow-lg)',
  },
  /** Motion durations + curves. Compose as `${t.dur[2]} ${t.ease.standard}`. */
  dur: { 1: 'var(--dur-1)', 2: 'var(--dur-2)', 3: 'var(--dur-3)', 4: 'var(--dur-4)', 5: 'var(--dur-5)' },
  ease: {
    standard: 'var(--ease-standard)', emphasized: 'var(--ease-emphasized)', spring: 'var(--ease-spring)',
  },
  text: {
    '2xs': 'var(--text-2xs)', xs: 'var(--text-xs)', sm: 'var(--text-sm)', base: 'var(--text-base)',
    md: 'var(--text-md)', lg: 'var(--text-lg)', xl: 'var(--text-xl)', '2xl': 'var(--text-2xl)',
    '3xl': 'var(--text-3xl)', '4xl': 'var(--text-4xl)',
  },
  weight: {
    regular: 'var(--weight-regular)', medium: 'var(--weight-medium)',
    bold: 'var(--weight-bold)', heavy: 'var(--weight-heavy)',
  },
  leading: { tight: 'var(--leading-tight)', snug: 'var(--leading-snug)', normal: 'var(--leading-normal)' },
  icon: { sm: 'var(--icon-sm)', md: 'var(--icon-md)', lg: 'var(--icon-lg)' },
  control: { sm: 'var(--control-sm)', md: 'var(--control-md)', lg: 'var(--control-lg)' },
  /** Semantic colors. `text`/`textMuted` read on dark surfaces; `ink*` on light. */
  color: {
    bg: 'var(--bg)', card: 'var(--card)', surface: 'var(--surface)', surface2: 'var(--surface-2)',
    text: 'var(--text)', muted: 'var(--muted)', line: 'var(--line)',
    ink: 'var(--ink)', inkBody: 'var(--ink-body)', inkMuted: 'var(--ink-muted)',
    red: 'var(--red)', focus: 'var(--focus-ring)',
  },
} as const

// ── Status tone tokens (the one status color source) ─────────────────────────
export type StatusTone = 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'accent'

export const statusTokens: Record<StatusTone, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--status-neutral-fg)', bg: 'var(--status-neutral-bg)' },
  info: { fg: 'var(--status-info-fg)', bg: 'var(--status-info-bg)' },
  good: { fg: 'var(--status-good-fg)', bg: 'var(--status-good-bg)' },
  warn: { fg: 'var(--status-warn-fg)', bg: 'var(--status-warn-bg)' },
  bad: { fg: 'var(--status-bad-fg)', bg: 'var(--status-bad-bg)' },
  accent: { fg: 'var(--status-accent-fg)', bg: 'var(--status-accent-bg)' },
}
