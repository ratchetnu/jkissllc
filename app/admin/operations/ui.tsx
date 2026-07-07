'use client'

// ── J KISS OS shared UI foundation ───────────────────────────────────────────
// Single source of truth for the OS design language: status system, avatars,
// formatters, and shared styles. Every OS page imports from here — no local
// re-definitions, so labels/colors/formatting stay consistent everywhere.
import type { CSSProperties, KeyboardEvent } from 'react'

// ── Canonical route status ───────────────────────────────────────────────────
export type RouteStatus =
  | 'draft' | 'assigned' | 'text_sent' | 'confirmed' | 'declined'
  | 'no_response' | 'no_show' | 'completed' | 'cancelled'

export const STATUS: Record<RouteStatus, { label: string; fg: string; bg: string }> = {
  draft: { label: 'Draft', fg: '#cbd5e1', bg: 'rgba(255,255,255,.08)' },
  assigned: { label: 'Assigned', fg: '#93c5fd', bg: 'rgba(59,130,246,.15)' },
  text_sent: { label: 'Awaiting confirm', fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
  confirmed: { label: 'Confirmed', fg: '#86efac', bg: 'rgba(34,197,94,.16)' },
  declined: { label: 'Declined', fg: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
  no_response: { label: 'No response', fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
  no_show: { label: 'No show', fg: '#fca5a5', bg: 'rgba(239,68,68,.2)' },
  completed: { label: 'Completed', fg: '#86efac', bg: 'rgba(34,197,94,.14)' },
  cancelled: { label: 'Cancelled', fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
}
export const statusOf = (s: string) => STATUS[s as RouteStatus] || STATUS.draft

export function StatusChip({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const s = statusOf(status)
  return <span style={{ fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: 800, padding: size === 'sm' ? '2px 8px' : '3px 10px', borderRadius: 99, background: s.bg, color: s.fg }}>{s.label}</span>
}

// ── Avatar (photo, else initials on a name-derived gradient) ─────────────────
export const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('')
const hue = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h }

export function Avatar({ name, photoUrl, size = 46 }: { name: string; photoUrl?: string; size?: number }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photoUrl} alt={name} style={{ width: size, height: size, borderRadius: 999, objectFit: 'cover', flexShrink: 0 }} />
  }
  return <div style={{ width: size, height: size, borderRadius: 999, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: size * 0.34, background: `linear-gradient(135deg, hsl(${hue(name)},55%,45%), hsl(${(hue(name) + 40) % 360},55%,38%))` }}>{initials(name)}</div>
}

// ── Formatters ───────────────────────────────────────────────────────────────
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parseIso = (iso: string) => new Date(`${iso}T12:00:00Z`)
export const fmtDay = (iso: string) => { const d = parseIso(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) }
export const fmtLongDay = (iso: string) => { const d = parseIso(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) }
export const fmtTs = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
export const mapsUrl = (a: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`
export const scoreColor = (s: number | null | undefined) => s == null ? '#94a3b8' : s >= 85 ? '#86efac' : s >= 60 ? '#fcd34d' : '#fca5a5'

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function weekdaysLabel(w: number[]): string {
  const s = [...w].sort((a, b) => a - b).join(',')
  if (s === '1,2,3,4,5') return 'Mon–Fri'
  if (s === '1,2,3,4,5,6') return 'Mon–Sat'
  if (s === '0,1,2,3,4,5,6') return 'Every day'
  return [...w].sort((a, b) => a - b).map(d => DOW[d]).join('/')
}

// ── Shared styles + a11y ─────────────────────────────────────────────────────
export const osField: CSSProperties = { width: '100%', padding: '12px 14px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none' }
export const osMiniBtn: CSSProperties = { padding: '5px 11px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

// Enter/Space activation for elements given a button role.
export const onActivate = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }
