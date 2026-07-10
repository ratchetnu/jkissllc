'use client'

// Shared foundation for the Communication Center — client types that mirror the
// server shapes, a lucide icon resolver (templates carry icon names as strings), the
// responsive Sheet (slide-up on mobile → side panel on desktop), channel/ack visuals,
// and saved-group persistence. Every comms section imports from here so the module
// reads as one system.
import { useEffect } from 'react'
import {
  Camera, Smartphone, CheckCircle2, LogIn, LogOut, Radio, PhoneCall, FileCheck2,
  Wrench, CalendarClock, Bell, Route, AlertTriangle, ClipboardPlus, Clock, TrafficCone,
  Truck, X, type LucideIcon,
} from 'lucide-react'

// ── Icon resolver ────────────────────────────────────────────────────────────
const ICONS: Record<string, LucideIcon> = {
  Camera, Smartphone, CheckCircle2, LogIn, LogOut, Radio, PhoneCall, FileCheck2,
  Wrench, CalendarClock, Bell, Route, AlertTriangle, ClipboardPlus, Clock, TrafficCone, Truck,
}
export function Icon({ name, size = 18, color }: { name: string; size?: number; color?: string }) {
  const C = ICONS[name] || Bell
  return <C size={size} color={color} />
}

// ── Client types (mirror the API responses) ──────────────────────────────────
export type ChannelId = 'inapp' | 'sms' | 'email' | 'push'
export type CrewRouteLite = { token: string; routeNumber: string; businessName: string; routeDate: string; reportTime: string; status: string; confirmed: boolean }
export type CrewCardT = {
  id: string; name: string; photoUrl?: string; phone?: string; email?: string; role?: string
  active: boolean; onboarding: boolean
  businessNames: string[]; businessKeys: string[]
  todayRoutes: CrewRouteLite[]; upcomingRoutes: CrewRouteLite[]; hasActiveRouteToday: boolean
  confirmed: boolean | null; clockIn: 'in' | 'out' | 'none' | 'na'; clockOut: boolean
  uniform: boolean; availabilitySubmitted: boolean; onTimeOff: boolean
  hasOpenAck: boolean; doneTemplatesToday: string[]
  lastActivityAt?: number; lastResponseAt?: number; activeNow: boolean
  flags: string[]
}
export type TemplateDef = {
  id: string; label: string; category: string; icon: string
  defaultChannels: ChannelId[]; defaultMessage: string; ackOptions: string[]
  requireAckDefault: boolean; suppress: string; routeLinked: boolean; urgent: boolean
}
export type DispatchActionT = { id: string; label: string; message: string; icon: string; ackOptions: string[]; tone: 'urgent' | 'alert' | 'info' }
export type ReminderT = {
  id: string; templateId: string; title: string; message: string; channels: ChannelId[]
  schedule: { kind: string; time?: string; date?: string; weekdays?: number[]; offsetMinutes?: number }
  target: { mode: string; staffIds?: string[]; businessKeys?: string[]; routeTokens?: string[]; segment?: string }
  requireAck: boolean; ackOptions: string[]; smartSuppress: boolean
  escalation: { afterMinutes: number; action: string }[]
  active: boolean; paused: boolean; archived: boolean
  stats: { sent: number; delivered: number; opened: number; acked: number; completed: number; failed: number; escalations: number }
  lastRunAt?: number; createdAt: number
}

// ── Channel + ack visuals ────────────────────────────────────────────────────
export const CHANNEL_LABEL: Record<ChannelId, string> = { inapp: 'In-App', sms: 'SMS', email: 'Email', push: 'Push' }
export const ACK_TONE: Record<string, string> = {
  completed: '#16a34a', already_done: '#16a34a', acknowledged: '#3b82f6',
  calling: '#E0002A', need_help: '#f59e0b', having_issues: '#f59e0b', unable: '#6b7280',
}

// ── Segment labels (kept in sync with lib/reminder-templates SEGMENT_LABEL) ──
export const SEGMENTS: { id: string; label: string }[] = [
  { id: 'all', label: 'Entire Crew' },
  { id: 'available', label: 'Available' },
  { id: 'unconfirmed', label: 'Unconfirmed' },
  { id: 'missing_uniform', label: 'Missing Uniform' },
  { id: 'missing_clock_in', label: 'Missing Clock In' },
  { id: 'missing_clock_out', label: 'Missing Clock Out' },
  { id: 'missing_route_confirmation', label: 'Missing Confirmation' },
  { id: 'missing_delivery_app', label: 'Missing App Update' },
  { id: 'missing_availability', label: 'Missing Availability' },
  { id: 'missing_ack', label: 'Missing Acknowledgement' },
]

// ── Responsive Sheet ─────────────────────────────────────────────────────────
export function Sheet({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="cc-sheet-scrim" onClick={onClose} />
      <div className="cc-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cc-sheet-grab" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--line)' }}>
          <h2 className="jkos-h" style={{ fontSize: 19 }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" className="os-tap" style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 999, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }}>
            <X size={17} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: 18, flex: 1 }}>{children}</div>
        {footer && <div style={{ padding: 14, borderTop: '1px solid var(--line)', background: 'color-mix(in srgb, var(--card) 92%, transparent)' }}>{footer}</div>}
      </div>
    </>
  )
}

// ── Channel picker (checkbox pills) ──────────────────────────────────────────
export function ChannelPicker({ value, onChange }: { value: ChannelId[]; onChange: (v: ChannelId[]) => void }) {
  const all: ChannelId[] = ['inapp', 'sms', 'email', 'push']
  const toggle = (c: ChannelId) => onChange(value.includes(c) ? value.filter(x => x !== c) : [...value, c])
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {all.map(c => {
        const on = value.includes(c)
        return (
          <button key={c} type="button" onClick={() => toggle(c)} className="os-tap"
            style={{ padding: '7px 13px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
            {CHANNEL_LABEL[c]}{c === 'push' && !on ? ' ·' : ''}
          </button>
        )
      })}
    </div>
  )
}

// ── Saved crew groups (localStorage — quick reuse of common selections) ──────
const GROUPS_KEY = 'cc:saved-groups'
export type SavedGroup = { name: string; ids: string[] }
export function loadGroups(): SavedGroup[] {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]') } catch { return [] }
}
export function saveGroups(g: SavedGroup[]): void {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(g.slice(0, 20))) } catch { /* ignore */ }
}

// ── Small fetch helper ───────────────────────────────────────────────────────
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as { error?: string }).error || `Request failed (${r.status})`)
  return d as T
}

export const relTime = (t?: number): string => {
  if (!t) return '—'
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
