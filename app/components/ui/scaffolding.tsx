'use client'
// ── Layout + feedback scaffolding ────────────────────────────────────────────
//
// The page-level furniture every operational screen re-implements: a page header
// (title + subtitle + actions), a toolbar row, a KPI/metric row grid, a progress
// bar, and the initials avatar. Token-driven so every edition's screens share one
// rhythm and never overflow the mobile viewport.

import { type CSSProperties, type ReactNode } from 'react'

// ── PageHeader ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions, style }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; style?: CSSProperties }) {
  return (
    <header className="safe-x" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 'var(--space-3)', paddingTop: 'var(--space-2)', paddingBottom: 'var(--space-4)', ...style }}>
      <div style={{ minWidth: 0 }}>
        <h1 className="jkos-h" style={{ fontSize: 'var(--text-2xl)', margin: 0 }}>{title}</h1>
        {subtitle && <div style={{ color: 'var(--muted)', fontSize: 'var(--text-base)', marginTop: 4 }}>{subtitle}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{actions}</div>}
    </header>
  )
}

// ── Toolbar (search / filter / view controls, wraps on mobile) ───────────────
export function Toolbar({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', ...style }}>{children}</div>
  )
}

// ── KpiRow (auto-fit metric grid, never overflows) ───────────────────────────
export function KpiRow({ children, min = 160, style }: { children: ReactNode; min?: number; style?: CSSProperties }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 'var(--space-3)', ...style }}>{children}</div>
  )
}

// ── Progress (determinate; indeterminate when value is undefined) ────────────
export function Progress({ value, label, tone = 'info' }: { value?: number; label?: string; tone?: 'info' | 'good' | 'warn' | 'bad' }) {
  const pct = value == null ? undefined : Math.max(0, Math.min(100, value))
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
      style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,.10)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: pct == null ? '35%' : `${pct}%`, borderRadius: 999, background: `var(--status-${tone}-fg)`, transition: 'width var(--dur-3) var(--ease-standard)', animation: pct == null ? 'indeterminate 1.2s var(--ease-standard) infinite' : undefined }} />
    </div>
  )
}

// ── Avatar (photo, else initials on a name-derived gradient) ─────────────────
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('')
const hue = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h }
export function Avatar({ name, photoUrl, size = 40 }: { name: string; photoUrl?: string; size?: number }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photoUrl} alt={name} style={{ width: size, height: size, borderRadius: 999, objectFit: 'cover', flexShrink: 0 }} />
  }
  return <div aria-hidden style={{ width: size, height: size, borderRadius: 999, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: size * 0.34, background: `linear-gradient(135deg, hsl(${hue(name)},55%,45%), hsl(${(hue(name) + 40) % 360},55%,38%))` }}>{initials(name)}</div>
}
