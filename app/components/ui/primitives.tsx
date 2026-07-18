'use client'
// ── Operion design-system primitives ─────────────────────────────────────────
//
// Accessible, restrained, theme-aware building blocks that consume the design
// tokens in globals.css (see tokens.ts). These render on the app's dark
// operational surfaces, so text defaults to --text (not --ink, which is the dark
// ink used ON light marketing surfaces — the earlier reference version had that
// backwards). Status language is one vocabulary shared with status.ts.

import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type SelectHTMLAttributes, useId } from 'react'
import type { StatusTone } from './tokens'

const RADIUS = 'var(--radius-sm)'
const RADIUS_LG = 'var(--radius-lg)'
const CARD_BG = 'color-mix(in srgb, var(--card) 90%, transparent)'
const TEXT = 'var(--text)'
const MUTED = 'var(--muted)'
const BORDER = '1px solid var(--line)'

// ── Tone system ──────────────────────────────────────────────────────────────
// `StatusTone` (neutral/info/good/warn/bad/accent) is canonical; the legacy
// color names are accepted and mapped so existing callers keep working.
export type Tone = StatusTone | 'green' | 'amber' | 'red' | 'grey' | 'blue'
const LEGACY: Record<string, StatusTone> = { green: 'good', amber: 'warn', red: 'bad', grey: 'neutral', blue: 'info' }
const toneOf = (t: Tone): StatusTone => (LEGACY[t] as StatusTone) ?? (t as StatusTone)
const toneFg = (t: Tone) => `var(--status-${toneOf(t)}-fg)`
const toneBg = (t: Tone) => `var(--status-${toneOf(t)}-bg)`

// ── Button ───────────────────────────────────────────────────────────────────
// Taxonomy: primary (filled brand), secondary (outlined), danger (destructive),
// quiet (borderless). Sizes sm/md/lg — md/lg meet the 44px touch target.
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
  size?: 'sm' | 'md' | 'lg'
}
export function Button({ variant = 'primary', size = 'md', style, ...rest }: ButtonProps) {
  const pad = size === 'sm' ? '6px 12px' : size === 'lg' ? '13px 22px' : '10px 16px'
  const minH = size === 'sm' ? 30 : size === 'lg' ? 48 : 40
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: pad, minHeight: minH, borderRadius: RADIUS,
    fontWeight: 600, cursor: 'pointer',
    border: BORDER, fontSize: size === 'sm' ? 13 : size === 'lg' ? 16 : 14,
    lineHeight: 1.2, transition: 'filter var(--dur-1) var(--ease-standard), background var(--dur-1) var(--ease-standard)',
    whiteSpace: 'nowrap',
  }
  const variants: Record<string, CSSProperties> = {
    primary: { background: 'var(--red)', color: '#fff', border: 'none' },
    secondary: { background: 'transparent', color: TEXT, borderColor: 'var(--line)' },
    ghost: { background: 'color-mix(in srgb, var(--card) 96%, #fff 4%)', color: TEXT },
    quiet: { background: 'transparent', color: MUTED, border: 'none' },
    danger: { background: 'transparent', color: toneFg('bad'), borderColor: toneFg('bad') },
  }
  return <button {...rest} style={{ ...base, ...variants[variant], ...style }} />
}

// ── IconButton (requires an accessible label) ────────────────────────────────
type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; size?: 'sm' | 'md' | 'lg' }
export function IconButton({ label, children, size = 'md', style, ...rest }: IconButtonProps) {
  const d = size === 'sm' ? 30 : size === 'lg' ? 44 : 38
  return (
    <button {...rest} aria-label={label} title={label}
      style={{ display: 'inline-grid', placeItems: 'center', width: d, height: d, borderRadius: RADIUS, border: BORDER, background: 'transparent', color: TEXT, cursor: 'pointer', transition: 'background var(--dur-1) var(--ease-standard)', ...style }}>
      {children}
    </button>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: CARD_BG, border: BORDER, borderRadius: RADIUS_LG, padding: 'var(--space-4)', boxShadow: 'var(--shadow-sm)', ...style }}>{children}</div>
}

// ── MetricCard ───────────────────────────────────────────────────────────────
export function MetricCard({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <Card style={{ padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 'var(--text-xs)', color: MUTED, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 800 }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: '-.02em', color: tone === 'neutral' ? TEXT : toneFg(tone), marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 'var(--text-sm)', color: MUTED, marginTop: 2 }}>{hint}</div>}
    </Card>
  )
}

// ── StatusBadge ──────────────────────────────────────────────────────────────
export function StatusBadge({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-xs)', fontWeight: 700, color: toneFg(tone), background: toneBg(tone) }}>
      {dot && <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: toneFg(tone) }} />}
      {children}
    </span>
  )
}

// ── Alert ────────────────────────────────────────────────────────────────────
export function Alert({ tone = 'info', title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  const t = toneOf(tone)
  const isProblem = t === 'bad' || t === 'warn'
  return (
    <div role={isProblem ? 'alert' : 'status'} style={{ borderLeft: `3px solid ${toneFg(tone)}`, background: toneBg(tone), borderRadius: RADIUS, padding: '10px 14px' }}>
      {title && <div style={{ fontWeight: 700, color: toneFg(tone), marginBottom: children ? 4 : 0 }}>{title}</div>}
      {children && <div style={{ color: TEXT, fontSize: 'var(--text-base)' }}>{children}</div>}
    </div>
  )
}

// ── EmptyState / Spinner / Skeleton / ErrorState ─────────────────────────────
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: MUTED }}>
      <div style={{ fontWeight: 700, color: TEXT, fontSize: 'var(--text-md)' }}>{title}</div>
      {description && <div style={{ marginTop: 6, fontSize: 'var(--text-base)' }}>{description}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading', size = 18 }: { label?: string; size?: number }) {
  return <span role="status" aria-label={label} className="ds-spin" style={{ display: 'inline-block', width: size, height: size, border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div aria-hidden className="skeleton" style={{ height, width, borderRadius: 8 }} />
}

export function ErrorState({ title = 'Something went wrong', detail, onRetry }: { title?: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={{ textAlign: 'center', padding: '32px 20px' }}>
      <div style={{ fontWeight: 700, color: toneFg('bad') }}>{title}</div>
      {detail && <div style={{ marginTop: 6, fontSize: 'var(--text-base)', color: MUTED }}>{detail}</div>}
      {onRetry && <div style={{ marginTop: 14 }}><Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button></div>}
    </div>
  )
}

// ── FormField ────────────────────────────────────────────────────────────────
export function FormField({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  const id = useId()
  const fieldId = htmlFor ?? id
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label htmlFor={fieldId} style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: TEXT }}>{label}</label>
      {children}
      {hint && !error && <div style={{ fontSize: 'var(--text-xs)', color: MUTED }}>{hint}</div>}
      {error && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: toneFg('bad') }}>{error}</div>}
    </div>
  )
}

// ── Select (native for built-in a11y) ────────────────────────────────────────
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }
export function Select({ options, style, ...rest }: SelectProps) {
  return (
    <select {...rest} style={{ padding: '10px 12px', minHeight: 40, borderRadius: RADIUS, border: BORDER, background: CARD_BG, color: TEXT, fontSize: 'var(--text-base)', ...style }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ── TableShell (always horizontally scrollable, never overflows the page) ────
export function TableShell({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ overflowX: 'auto', border: BORDER, borderRadius: RADIUS_LG, ...style }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-base)', minWidth: 480 }}>{children}</table>
    </div>
  )
}
