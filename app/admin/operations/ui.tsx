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

// ── Canonical claim status ───────────────────────────────────────────────────
// Same shape + colour vocabulary as routes: green = settled, amber = waiting on
// someone, red = contested, grey = done/parked.
export type ClaimStatus =
  | 'new' | 'under_review' | 'waiting_customer' | 'disputed' | 'approved'
  | 'deduction_active' | 'paid' | 'closed' | 'waived'

export const CLAIM_STATUS: Record<ClaimStatus, { label: string; fg: string; bg: string }> = {
  new: { label: 'New', fg: '#93c5fd', bg: 'rgba(59,130,246,.15)' },
  under_review: { label: 'Under Review', fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
  waiting_customer: { label: 'Waiting on Customer', fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
  disputed: { label: 'Disputed', fg: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
  approved: { label: 'Approved', fg: '#c4b5fd', bg: 'rgba(139,92,246,.16)' },
  deduction_active: { label: 'Deduction Active', fg: '#7dd3fc', bg: 'rgba(14,165,233,.16)' },
  paid: { label: 'Paid', fg: '#86efac', bg: 'rgba(34,197,94,.16)' },
  closed: { label: 'Closed', fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
  waived: { label: 'Waived', fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
}
export const claimStatusOf = (s: string) => CLAIM_STATUS[s as ClaimStatus] || CLAIM_STATUS.new

export function ClaimChip({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const s = claimStatusOf(status)
  return <span style={{ fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: 800, padding: size === 'sm' ? '2px 8px' : '3px 10px', borderRadius: 99, background: s.bg, color: s.fg }}>{s.label}</span>
}

export const CLAIM_TYPE_LABEL: Record<string, string> = {
  property_damage: 'Property Damage',
  vehicle_damage: 'Vehicle Damage',
  cargo_damage: 'Cargo Damage',
  lost_item: 'Lost / Missing Item',
  injury: 'Injury',
  service_failure: 'Service Failure',
  other: 'Other',
}

// A crew member's own responsibility status on one claim.
export const RESP_COLOR: Record<string, string> = {
  pending: '#fcd34d', active: '#7dd3fc', paused: '#94a3b8', completed: '#86efac', waived: '#94a3b8',
}

// ── Stat tile (the OS reporting card) ────────────────────────────────────────
export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="os-card" style={{ padding: '14px 16px' }}>
      <div style={{ ...osLabel, fontSize: 10.5 }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 23, fontWeight: 900, letterSpacing: '-.02em', marginTop: 4, color: tone || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
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

// ── Money ────────────────────────────────────────────────────────────────────
// Cents → the string an admin edits ("35000" → "350.00", undefined → ""). The
// server re-parses this with lib/finance.parseMoneyCents, which is the single
// source of truth for what a valid amount is.
export const centsToInput = (cents?: number): string => (typeof cents === 'number' ? (cents / 100).toFixed(2) : '')

// Cents → display, tolerating "not set" without printing "$0.00" (which would be
// a lie: an unset price is unknown, not free).
export const moneyOrDash = (cents?: number | null): string => (typeof cents === 'number' ? money(cents) : '—')

// Profit colour: black ink, red ink, grey when unknown.
export const profitColor = (cents?: number | null): string =>
  cents == null ? 'var(--muted)' : cents > 0 ? '#86efac' : cents < 0 ? '#fca5a5' : 'var(--text)'

// Mirrors lib/finance.parseMoneyCents so the field can validate as you type. Kept
// deliberately strict — the server rejects anything this accepts wrongly anyway.
export const looksLikeMoney = (s: string): boolean => /^\d+(\.\d{1,2})?$/.test(s.trim().replace(/[$,\s]/g, ''))

// A dollar field. Renders the "$" as an affix so the value stays a clean number.
export function MoneyInput({ value, onChange, placeholder = '0.00', invalid, ...rest }: {
  value: string; onChange: (v: string) => void; placeholder?: string; invalid?: boolean
  'aria-label'?: string; disabled?: boolean
}) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <span aria-hidden style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', fontSize: 15, fontWeight: 600, color: 'var(--muted)', pointerEvents: 'none' }}>$</span>
      <input
        {...rest}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="tabular-nums"
        style={{ ...osField, paddingLeft: 27, borderColor: invalid ? '#f87171' : 'var(--line)' }}
      />
    </div>
  )
}

// ── Toggle (the OS switch) ───────────────────────────────────────────────────
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className="os-tap"
      style={{ width: 50, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 3, background: on ? 'var(--red)' : 'rgba(255,255,255,.14)', transition: 'background .2s var(--os-ease)', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 24, height: 24, borderRadius: 999, background: '#fff', transform: on ? 'translateX(20px)' : 'translateX(0)', transition: 'transform .2s var(--os-spring)' }} />
    </button>
  )
}

// ── Shared styles + a11y ─────────────────────────────────────────────────────
export const osField: CSSProperties = { width: '100%', padding: '12px 14px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none' }
export const osMiniBtn: CSSProperties = { padding: '5px 11px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }
export const osLabel: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }

// Enter/Space activation for elements given a button role.
export const onActivate = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }
