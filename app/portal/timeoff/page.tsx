'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, AlertTriangle, X } from 'lucide-react'
import PortalShell from '../PortalShell'
import { fmtDay } from '../ui'

type Status = 'draft' | 'pending' | 'approved' | 'denied' | 'cancelled'
type Req = {
  id: string; startDate: string; endDate: string; partial: boolean; startTime?: string; endTime?: string
  reason?: string; status: Status; isLate: boolean; decisionNote?: string; createdAt: number
}

const STATUS_META: Record<Status, { label: string; fg: string; bg: string }> = {
  draft: { label: 'Draft', fg: '#cbd5e1', bg: 'rgba(148,163,184,.15)' },
  pending: { label: 'Pending review', fg: '#fcd34d', bg: 'rgba(252,211,77,.14)' },
  approved: { label: 'Approved', fg: '#86efac', bg: 'rgba(134,239,172,.14)' },
  denied: { label: 'Denied', fg: '#fca5a5', bg: 'rgba(248,113,113,.14)' },
  cancelled: { label: 'Cancelled', fg: '#cbd5e1', bg: 'rgba(148,163,184,.12)' },
}

const iStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 11, color: 'var(--text)', fontSize: 15, outline: 'none',
}
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }

// Client-side mirror of the server's 24h rule (approximate, Central CDT) so we can
// warn before submit. The server is authoritative.
function looksLate(startDate: string, startTime?: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return false
  const [Y, M, D] = startDate.split('-').map(Number)
  const [h, m] = (startTime && /^\d{2}:\d{2}$/.test(startTime) ? startTime : '00:00').split(':').map(Number)
  return Date.UTC(Y, M - 1, D, h + 5, m) - Date.now() < 24 * 60 * 60 * 1000
}

function TimeOff() {
  const [requests, setRequests] = useState<Req[] | null>(null)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [partial, setPartial] = useState(false)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('17:00')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await fetch('/api/portal/timeoff', { credentials: 'same-origin' }).then(r => r.json())
      setRequests(d.requests ?? [])
    } catch { setRequests([]) }
  }, [])
  useEffect(() => { load() }, [load])

  const late = start ? looksLate(start, partial ? startTime : undefined) : false

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    if (late && !reason.trim()) { setErr('This is a late request (within 24 hours). Please include a reason.'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/portal/timeoff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ startDate: start, endDate: end || start, partial, startTime, endTime, reason, submit: true }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not submit request.'); return }
      setStart(''); setEnd(''); setPartial(false); setReason('')
      setDone(true); setTimeout(() => setDone(false), 2200)
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  async function cancel(id: string) {
    if (!window.confirm('Cancel this time-off request?')) return
    try {
      await fetch('/api/portal/timeoff', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'cancel', id }) })
      await load()
    } catch { /* ignore */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Time Off</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Request time off. Submit at least 24 hours before the time you need — later requests need a reason and notify your manager.</p>
      </div>

      <form onSubmit={submit} className="os-card os-rise" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 13 }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <div>
            <label style={labelStyle}>Start date</label>
            <input type="date" value={start} onChange={e => setStart(e.target.value)} style={{ ...iStyle, marginTop: 6 }} required />
          </div>
          <div>
            <label style={labelStyle}>End date</label>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)} min={start || undefined} style={{ ...iStyle, marginTop: 6 }} />
          </div>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--red)' }} />
          Partial day (specify hours)
        </label>

        {partial && (
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <div><label style={labelStyle}>From</label><input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} style={{ ...iStyle, marginTop: 6 }} /></div>
            <div><label style={labelStyle}>To</label><input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} style={{ ...iStyle, marginTop: 6 }} /></div>
          </div>
        )}

        <div>
          <label style={labelStyle}>Reason {late ? '(required — late request)' : '(optional)'}</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} style={{ ...iStyle, marginTop: 6, resize: 'vertical' }} placeholder={late ? 'Why is this last-minute?' : 'Optional'} />
        </div>

        {late && start && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '11px 13px', borderRadius: 11, background: 'rgba(252,211,77,.09)', border: '1px solid rgba(252,211,77,.28)' }}>
            <AlertTriangle size={16} style={{ color: '#fcd34d', flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 13, color: '#fcd34d', lineHeight: 1.45 }}>This is a <strong>late request</strong> (within 24 hours). It needs a reason and your manager is notified. You remain responsible for any confirmed routes until it&apos;s approved.</p>
          </div>
        )}

        {err && <p style={{ color: '#f87171', fontSize: 14 }}>{err}</p>}
        <button type="submit" disabled={busy} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46, gap: 8 }}>
          {done ? <><Check size={17} /> Submitted</> : busy ? 'Submitting…' : 'Submit request'}
        </button>
      </form>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Your requests</h2>
        {requests === null && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
        {requests?.length === 0 && <div className="os-card" style={{ padding: 16 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>No requests yet.</p></div>}
        {requests?.map(r => {
          const m = STATUS_META[r.status]
          const range = r.startDate === r.endDate ? fmtDay(r.startDate) : `${fmtDay(r.startDate)} – ${fmtDay(r.endDate)}`
          return (
            <div key={r.id} className="os-card" style={{ padding: 15 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontWeight: 700, fontSize: 15 }}>{range}{r.partial ? ` · ${r.startTime}–${r.endTime}` : ''}</p>
                  {r.reason && <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 3 }}>{r.reason}</p>}
                  {r.decisionNote && <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3, fontStyle: 'italic' }}>Manager: {r.decisionNote}</p>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {r.isLate && <span title="Late request" style={{ fontSize: 10.5, fontWeight: 800, color: '#fcd34d' }}>LATE</span>}
                  <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: m.fg, background: m.bg }}>{m.label}</span>
                </div>
              </div>
              {(r.status === 'pending' || r.status === 'approved') && (
                <button onClick={() => cancel(r.id)} className="os-tap" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 9, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                  <X size={13} /> Cancel
                </button>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}

export default function TimeOffPage() {
  return <PortalShell><TimeOff /></PortalShell>
}
