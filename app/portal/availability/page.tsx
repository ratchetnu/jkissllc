'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, CalendarDays } from 'lucide-react'
import PortalShell from '../PortalShell'
import { fmtLongDay } from '../ui'

const DOW_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
type DowKey = (typeof DOW_KEYS)[number]
const DOW_LABEL: Record<DowKey, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

type Day = { available: boolean; start?: string; end?: string }

const iStyle: React.CSSProperties = {
  padding: '9px 11px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none',
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="os-tap"
      style={{ width: 46, height: 28, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 3, flexShrink: 0, background: on ? 'var(--red)' : 'rgba(255,255,255,.14)' }}>
      <span style={{ display: 'block', width: 22, height: 22, borderRadius: 999, background: '#fff', transform: on ? 'translateX(18px)' : 'translateX(0)', transition: 'transform .18s var(--os-spring)' }} />
    </button>
  )
}

function Availability() {
  const [weekStart, setWeekStart] = useState<string | null>(null)
  const [weekOptions, setWeekOptions] = useState<string[]>([])
  const [days, setDays] = useState<Record<DowKey, Day> | null>(null)
  const [status, setStatus] = useState<'draft' | 'submitted'>('draft')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async (ws?: string) => {
    setLoading(true); setErr('')
    try {
      const url = ws ? `/api/portal/availability?weekStart=${ws}` : '/api/portal/availability'
      const d = await fetch(url, { credentials: 'same-origin' }).then(r => r.json())
      if (d.ok) {
        setWeekStart(d.week.weekStart); setDays(d.week.days); setStatus(d.week.status)
        setWeekOptions(d.weekOptions ?? [])
      }
    } catch { setErr('Could not load availability.') } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function setDay(k: DowKey, patch: Partial<Day>) {
    setDays(prev => prev ? { ...prev, [k]: { ...prev[k], ...patch } } : prev)
  }
  function markAll(available: boolean) {
    setDays(prev => {
      if (!prev) return prev
      const next = { ...prev }
      for (const k of DOW_KEYS) next[k] = available ? { available: true, start: prev[k].start ?? '08:00', end: prev[k].end ?? '17:00' } : { available: false }
      return next
    })
  }
  async function copyPrevious() {
    if (!weekStart) return
    // Previous week = 7 days before the current selection.
    const [y, m, d0] = weekStart.split('-').map(Number)
    const prev = new Date(Date.UTC(y, m - 1, d0) - 7 * 86_400_000)
    const py = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`
    try {
      const d = await fetch(`/api/portal/availability?weekStart=${py}`, { credentials: 'same-origin' }).then(r => r.json())
      if (d.ok) setDays(d.week.days)
    } catch { /* ignore */ }
  }

  async function save(submit: boolean) {
    if (!weekStart || !days) return
    setBusy(true); setErr(''); setSaved('')
    try {
      const res = await fetch('/api/portal/availability', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ weekStart, days, submit }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not save.'); return }
      setStatus(d.week.status); setDays(d.week.days)
      setSaved(submit ? 'Submitted' : 'Draft saved'); setTimeout(() => setSaved(''), 2200)
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Availability</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Tell your manager when you can work. Availability helps scheduling — it doesn&apos;t guarantee routes.</p>
      </div>

      {/* Week selector */}
      {weekOptions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {weekOptions.map(ws => (
            <button key={ws} onClick={() => load(ws)} className="os-tap"
              style={{ flexShrink: 0, padding: '8px 13px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)',
                color: ws === weekStart ? '#fff' : 'var(--muted)', background: ws === weekStart ? 'var(--red)' : 'transparent' }}>
              {fmtLongDay(ws).replace(/^\w+, /, '')}
            </button>
          ))}
        </div>
      )}

      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {err && <p style={{ color: '#f87171', fontSize: 14 }}>{err}</p>}

      {!loading && days && weekStart && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--muted)' }}>
              <CalendarDays size={15} /> Week of {fmtLongDay(weekStart)}
              {status === 'submitted' && <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999, color: '#86efac', background: 'rgba(134,239,172,.14)' }}>Submitted</span>}
            </span>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <button onClick={() => markAll(true)} className="os-tap" style={miniBtn}>All available</button>
              <button onClick={() => markAll(false)} className="os-tap" style={miniBtn}>All off</button>
              <button onClick={copyPrevious} className="os-tap" style={miniBtn}><Copy size={12} style={{ marginRight: 4, verticalAlign: -1 }} />Copy last week</button>
            </div>
          </div>

          <div className="os-card os-rise" style={{ padding: 6 }}>
            {DOW_KEYS.map((k, i) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 12px', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                <Toggle on={days[k].available} onChange={v => setDay(k, v ? { available: true, start: days[k].start ?? '08:00', end: days[k].end ?? '17:00' } : { available: false })} />
                <span style={{ fontWeight: 600, fontSize: 14.5, width: 92, flexShrink: 0 }}>{DOW_LABEL[k]}</span>
                {days[k].available ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 'auto' }}>
                    <input type="time" value={days[k].start ?? '08:00'} onChange={e => setDay(k, { start: e.target.value })} style={iStyle} />
                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>to</span>
                    <input type="time" value={days[k].end ?? '17:00'} onChange={e => setDay(k, { end: e.target.value })} style={iStyle} />
                  </div>
                ) : <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 13 }}>Unavailable</span>}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={() => save(false)} disabled={busy} className="os-tap" style={{ padding: '12px 18px', borderRadius: 12, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Save draft</button>
            <button onClick={() => save(true)} disabled={busy} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46, padding: '0 22px', gap: 8 }}>
              {saved ? <><Check size={17} /> {saved}</> : 'Submit'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const miniBtn: React.CSSProperties = { padding: '7px 11px', fontSize: 12, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

export default function AvailabilityPage() {
  return <PortalShell><Availability /></PortalShell>
}
