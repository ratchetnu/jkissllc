'use client'
// ── Operational design-system primitives ─────────────────────────────────────
//
// Accessible, restrained, theme-aware building blocks that consume the existing
// CSS custom properties in globals.css (no new global CSS, no marketing gloss).
// These are NEW and imported by nothing in production yet (Part 11: promote real
// primitives; convert exactly one flagged reference screen). Status language is
// consistent with app/admin/operations/ui.tsx.

import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type SelectHTMLAttributes, useId } from 'react'

const RADIUS = 'var(--os-radius-sm, 12px)'
const CARD_BG = 'var(--surface-2, #16161a)'
const INK = 'var(--ink, #f3f4f6)'
const INK_MUTED = 'var(--ink-muted, #9ca3af)'
const BORDER = '1px solid color-mix(in srgb, var(--ink, #fff) 12%, transparent)'

export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue'
const TONE_FG: Record<Tone, string> = { green: '#22c55e', amber: '#f59e0b', red: 'var(--red, #E0002A)', grey: '#9ca3af', blue: '#3b82f6' }

// ── Button ───────────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}
export function Button({ variant = 'primary', size = 'md', style, ...rest }: ButtonProps) {
  const pad = size === 'sm' ? '6px 12px' : '10px 16px'
  const base: CSSProperties = {
    padding: pad, borderRadius: RADIUS, fontWeight: 600, cursor: 'pointer',
    border: BORDER, fontSize: size === 'sm' ? 13 : 14, lineHeight: 1.2,
    transition: 'filter .15s ease', whiteSpace: 'nowrap',
  }
  const variants: Record<string, CSSProperties> = {
    primary: { background: 'var(--red, #E0002A)', color: '#fff', border: 'none' },
    ghost: { background: 'transparent', color: INK },
    danger: { background: 'transparent', color: TONE_FG.red, borderColor: TONE_FG.red },
  }
  return <button {...rest} style={{ ...base, ...variants[variant], ...style }} />
}

// ── IconButton (requires an accessible label) ────────────────────────────────
type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }
export function IconButton({ label, children, style, ...rest }: IconButtonProps) {
  return (
    <button {...rest} aria-label={label} title={label}
      style={{ display: 'inline-grid', placeItems: 'center', width: 36, height: 36, borderRadius: RADIUS, border: BORDER, background: 'transparent', color: INK, cursor: 'pointer', ...style }}>
      {children}
    </button>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: CARD_BG, border: BORDER, borderRadius: 'var(--os-radius, 18px)', padding: 16, ...style }}>{children}</div>
}

// ── MetricCard ───────────────────────────────────────────────────────────────
export function MetricCard({ label, value, hint, tone = 'grey' }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ fontSize: 12, color: INK_MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: TONE_FG[tone], marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: INK_MUTED, marginTop: 2 }}>{hint}</div>}
    </Card>
  )
}

// ── StatusBadge ──────────────────────────────────────────────────────────────
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: TONE_FG[tone], background: `color-mix(in srgb, ${TONE_FG[tone]} 15%, transparent)` }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: TONE_FG[tone] }} />
      {children}
    </span>
  )
}

// ── Alert ────────────────────────────────────────────────────────────────────
export function Alert({ tone = 'blue', title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  const isProblem = tone === 'red' || tone === 'amber'
  return (
    <div role={isProblem ? 'alert' : 'status'} style={{ borderLeft: `3px solid ${TONE_FG[tone]}`, background: `color-mix(in srgb, ${TONE_FG[tone]} 8%, transparent)`, borderRadius: RADIUS, padding: '10px 14px' }}>
      {title && <div style={{ fontWeight: 700, color: TONE_FG[tone], marginBottom: children ? 4 : 0 }}>{title}</div>}
      {children && <div style={{ color: INK, fontSize: 14 }}>{children}</div>}
    </div>
  )
}

// ── EmptyState / Spinner / Skeleton / ErrorState ─────────────────────────────
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: INK_MUTED }}>
      <div style={{ fontWeight: 700, color: INK, fontSize: 16 }}>{title}</div>
      {description && <div style={{ marginTop: 6, fontSize: 14 }}>{description}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span role="status" aria-label={label} style={{ display: 'inline-block', width: 18, height: 18, border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div aria-hidden className="skeleton" style={{ height, width, borderRadius: 8 }} />
}

export function ErrorState({ title = 'Something went wrong', detail, onRetry }: { title?: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={{ textAlign: 'center', padding: '32px 20px' }}>
      <div style={{ fontWeight: 700, color: TONE_FG.red }}>{title}</div>
      {detail && <div style={{ marginTop: 6, fontSize: 14, color: INK_MUTED }}>{detail}</div>}
      {onRetry && <div style={{ marginTop: 14 }}><Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button></div>}
    </div>
  )
}

// ── FormField ────────────────────────────────────────────────────────────────
export function FormField({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  const id = useId()
  const fieldId = htmlFor ?? id
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label htmlFor={fieldId} style={{ fontSize: 13, fontWeight: 600, color: INK }}>{label}</label>
      {children}
      {hint && !error && <div style={{ fontSize: 12, color: INK_MUTED }}>{hint}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: TONE_FG.red }}>{error}</div>}
    </div>
  )
}

// ── Select (native for built-in a11y) ────────────────────────────────────────
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }
export function Select({ options, style, ...rest }: SelectProps) {
  return (
    <select {...rest} style={{ padding: '9px 12px', borderRadius: RADIUS, border: BORDER, background: CARD_BG, color: INK, fontSize: 14, ...style }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ── TableShell (always horizontally scrollable, never overflows the page) ────
export function TableShell({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ overflowX: 'auto', border: BORDER, borderRadius: 'var(--os-radius, 18px)', ...style }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 480 }}>{children}</table>
    </div>
  )
}
