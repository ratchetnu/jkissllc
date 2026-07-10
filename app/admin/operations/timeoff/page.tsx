'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, X, ArrowLeft, AlertTriangle } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Avatar, fmtDay, fmtTs } from '../ui'

type Status = 'draft' | 'pending' | 'approved' | 'denied' | 'cancelled'
type Req = {
  id: string; staffId: string; staffName?: string; startDate: string; endDate: string
  partial: boolean; startTime?: string; endTime?: string; reason?: string; status: Status
  isLate: boolean; decidedBy?: string; decidedAt?: number; decisionNote?: string; createdAt: number
}

const STATUS_META: Record<Status, { label: string; fg: string; bg: string }> = {
  draft: { label: 'Draft', fg: '#cbd5e1', bg: 'rgba(148,163,184,.15)' },
  pending: { label: 'Pending', fg: '#fcd34d', bg: 'rgba(252,211,77,.14)' },
  approved: { label: 'Approved', fg: '#86efac', bg: 'rgba(134,239,172,.14)' },
  denied: { label: 'Denied', fg: '#fca5a5', bg: 'rgba(248,113,113,.14)' },
  cancelled: { label: 'Cancelled', fg: '#cbd5e1', bg: 'rgba(148,163,184,.12)' },
}
const FILTERS = ['pending', 'approved', 'denied', 'all'] as const
type Filter = (typeof FILTERS)[number]

function TimeOffReview() {
  const [requests, setRequests] = useState<Req[] | null>(null)
  const [filter, setFilter] = useState<Filter>('pending')
  const [forbidden, setForbidden] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/timeoff', { credentials: 'same-origin' })
      if (res.status === 403) { setForbidden(true); setRequests([]); return }
      const d = await res.json()
      setRequests(d.requests ?? [])
    } catch { setRequests([]) }
  }, [])
  useEffect(() => { load() }, [load])

  async function decide(r: Req, action: 'approve' | 'deny') {
    let note: string | undefined
    if (action === 'deny') { note = window.prompt('Reason for denial (optional):') ?? undefined }
    setBusy(r.id); setErr('')
    try {
      const res = await fetch('/api/admin/timeoff', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ id: r.id, action, note }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Action failed.'); return }
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy('') }
  }

  if (forbidden) return (
    <div className="os-card os-rise" style={{ padding: 26, textAlign: 'center' }}>
      <p className="jkos-h" style={{ fontSize: 18 }}>Not available</p>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>You don&apos;t have access to time-off review.</p>
    </div>
  )

  const shown = (requests ?? []).filter(r => filter === 'all' ? true : r.status === filter)
  const pendingCount = (requests ?? []).filter(r => r.status === 'pending').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Link href="/admin/operations/employees" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none', marginBottom: 8 }}><ArrowLeft size={14} /> Crew</Link>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Time Off</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Review crew time-off requests. Approving never removes a confirmed route — reassign it separately.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)} className="os-tap"
            style={{ padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', textTransform: 'capitalize',
              color: filter === f ? '#fff' : 'var(--muted)', background: filter === f ? 'var(--red)' : 'transparent' }}>
            {f}{f === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>

      {err && <div className="os-card" style={{ padding: '11px 15px', color: '#fca5a5', fontSize: 14 }}>{err}</div>}
      {requests === null && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {requests !== null && shown.length === 0 && <div className="os-card" style={{ padding: 18 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>Nothing here.</p></div>}

      {shown.map(r => {
        const m = STATUS_META[r.status]
        const range = r.startDate === r.endDate ? fmtDay(r.startDate) : `${fmtDay(r.startDate)} – ${fmtDay(r.endDate)}`
        return (
          <div key={r.id} className="os-card os-rise" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <Avatar name={r.staffName ?? 'Crew'} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15.5 }}>{r.staffName ?? 'Crew member'}</span>
                  <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: m.fg, background: m.bg }}>{m.label}</span>
                  {r.isLate && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, color: '#fcd34d' }}><AlertTriangle size={12} /> LATE</span>}
                </div>
                <p style={{ fontSize: 14, marginTop: 5 }}>{range}{r.partial ? ` · ${r.startTime}–${r.endTime}` : ' · full day'}</p>
                {r.reason && <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 4 }}>“{r.reason}”</p>}
                <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>Requested {fmtTs(r.createdAt)}{r.decidedBy ? ` · decided by ${r.decidedBy}` : ''}</p>
                {r.decisionNote && <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3, fontStyle: 'italic' }}>Note: {r.decisionNote}</p>}
              </div>
            </div>
            {r.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button onClick={() => decide(r, 'approve')} disabled={!!busy} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 11, background: 'rgba(134,239,172,.14)', border: '1px solid rgba(134,239,172,.3)', color: '#86efac', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}><Check size={15} /> Approve</button>
                <button onClick={() => decide(r, 'deny')} disabled={!!busy} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 11, background: 'rgba(248,113,113,.12)', border: '1px solid rgba(248,113,113,.28)', color: '#fca5a5', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}><X size={15} /> Deny</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function TimeOffReviewPage() {
  return <OperationsShell><TimeOffReview /></OperationsShell>
}
