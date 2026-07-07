'use client'

import { useCallback, useEffect, useState } from 'react'
import AdminGate from '../AdminGate'

type RouteStatus = 'draft' | 'assigned' | 'text_sent' | 'confirmed' | 'declined' | 'no_response' | 'no_show' | 'completed' | 'cancelled'
type Route = {
  token: string; routeNumber: string; status: RouteStatus
  businessName: string; contactPerson?: string; contactPhone?: string
  reportAddress: string; reportTime: string; routeDate: string
  description?: string; payRate?: string; vehicle?: string; specialNotes?: string
  assignedStaffId?: string; assignedStaffName?: string
  smsStatus?: string; smsError?: string
  linkOpenedAt?: number; confirmedAt?: number; declinedAt?: number
  createdAt: number
}
type Staff = { id: string; name: string; phone?: string; role?: string; active: boolean }

const CHIP: Record<RouteStatus, { bg: string; fg: string; label: string }> = {
  draft: { bg: 'rgba(255,255,255,.08)', fg: '#cbd5e1', label: 'Draft' },
  assigned: { bg: 'rgba(59,130,246,.15)', fg: '#93c5fd', label: 'Assigned' },
  text_sent: { bg: 'rgba(245,158,11,.15)', fg: '#fcd34d', label: 'Text Sent' },
  confirmed: { bg: 'rgba(34,197,94,.16)', fg: '#86efac', label: 'Confirmed' },
  declined: { bg: 'rgba(239,68,68,.16)', fg: '#fca5a5', label: 'Declined' },
  no_response: { bg: 'rgba(245,158,11,.15)', fg: '#fcd34d', label: 'No Response' },
  no_show: { bg: 'rgba(239,68,68,.2)', fg: '#fca5a5', label: 'No Show' },
  completed: { bg: 'rgba(34,197,94,.16)', fg: '#86efac', label: 'Completed' },
  cancelled: { bg: 'rgba(255,255,255,.06)', fg: '#94a3b8', label: 'Cancelled' },
}
const fmtDate = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) }
const iStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 14, outline: 'none' }

function Dashboard() {
  const [routes, setRoutes] = useState<Route[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busyTok, setBusyTok] = useState('')
  const blank = { businessName: '', reportAddress: '', reportTime: '', routeDate: '', contactPerson: '', contactPhone: '', vehicle: '', payRate: '', description: '', specialNotes: '', staffId: '' }
  const [form, setForm] = useState(blank)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [r, s] = await Promise.all([
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      if (r.error) setError(r.error === 'UPSTASH_NOT_CONFIGURED' ? 'Redis is not configured.' : r.error)
      setRoutes(r.items || [])
      setStaff((s.items || []).filter((x: Staff) => x.active))
    } catch { setError('Failed to load routes.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault(); setCreating(true); setNote('')
    try {
      const res = await fetch('/api/admin/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(form) })
      const d = await res.json()
      if (!res.ok) { setNote(d.error || 'Could not create route.'); return }
      setForm(blank)
      setNote(d.smsWarning ? `Route created — but text not sent: ${d.smsWarning}` : (form.staffId ? 'Route created and text sent.' : 'Route created (draft).'))
      load()
    } catch { setNote('Network error.') } finally { setCreating(false) }
  }

  async function patch(token: string, body: Record<string, unknown>) {
    setBusyTok(token); setNote('')
    try {
      const res = await fetch(`/api/admin/routes/${token}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      const d = await res.json()
      if (!res.ok) setNote(d.error || 'Action failed.')
      else if (d.smsWarning) setNote(`Text not sent: ${d.smsWarning}`)
      load()
    } catch { setNote('Network error.') } finally { setBusyTok('') }
  }
  async function del(token: string) {
    if (!confirm('Delete this route permanently?')) return
    setBusyTok(token)
    try { await fetch(`/api/admin/routes/${token}`, { method: 'DELETE', credentials: 'same-origin' }); load() }
    finally { setBusyTok('') }
  }
  function copyLink(token: string) { navigator.clipboard?.writeText(`${location.origin}/route/${token}`); setNote('Confirmation link copied.') }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Route Dispatch</h1>
      <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>Create contract routes, assign crew, and text a confirmation link.</p>

      {note && <div className="mb-4 text-sm" style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.2)', color: '#fca5a5' }}>{note}</div>}

      {/* Create form */}
      <form onSubmit={create} className="glass-card mb-8" style={{ borderRadius: 16, padding: 20 }}>
        <p className="text-sm font-bold text-white mb-3">New route</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <input required placeholder="Business / client name *" value={form.businessName} onChange={set('businessName')} style={iStyle} />
          <input required placeholder="Report / pickup address *" value={form.reportAddress} onChange={set('reportAddress')} style={iStyle} />
          <input required type="date" value={form.routeDate} onChange={set('routeDate')} style={iStyle} />
          <input required placeholder="Report time * (e.g. 7:00 AM)" value={form.reportTime} onChange={set('reportTime')} style={iStyle} />
          <input placeholder="Vehicle / equipment" value={form.vehicle} onChange={set('vehicle')} style={iStyle} />
          <input placeholder="Pay / rate (e.g. $175/route)" value={form.payRate} onChange={set('payRate')} style={iStyle} />
          <input placeholder="On-site contact person" value={form.contactPerson} onChange={set('contactPerson')} style={iStyle} />
          <input placeholder="On-site contact phone" value={form.contactPhone} onChange={set('contactPhone')} style={iStyle} />
        </div>
        <textarea placeholder="Route description / instructions" value={form.description} onChange={set('description')} rows={2} style={{ ...iStyle, marginTop: 12, resize: 'vertical' }} />
        <textarea placeholder="Special notes" value={form.specialNotes} onChange={set('specialNotes')} rows={2} style={{ ...iStyle, marginTop: 12, resize: 'vertical' }} />
        <div className="grid sm:grid-cols-[1fr_auto] gap-3 mt-3 items-end">
          <div>
            <label className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Assign contractor (texts them now — optional)</label>
            <select value={form.staffId} onChange={set('staffId')} style={{ ...iStyle, cursor: 'pointer', marginTop: 4 }}>
              <option value="">— Save as draft (assign later) —</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.phone ? '' : ' (no phone)'}</option>)}
            </select>
          </div>
          <button type="submit" disabled={creating} className="btn" style={{ justifyContent: 'center', height: 42 }}>{creating ? 'Saving…' : 'Create route'}</button>
        </div>
      </form>

      {/* Route list */}
      {loading ? <p style={{ color: 'var(--muted)' }}>Loading…</p>
        : error ? <p style={{ color: '#f87171' }}>{error}</p>
        : routes.length === 0 ? <p style={{ color: 'var(--muted)' }}>No routes yet. Create one above.</p>
        : (
        <div className="flex flex-col gap-3">
          {routes.map(r => {
            const chip = CHIP[r.status]
            const busy = busyTok === r.token
            return (
              <div key={r.token} className="glass-card" style={{ borderRadius: 14, padding: 16, opacity: busy ? .6 : 1 }}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{r.routeNumber}</span>
                      <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 99, background: chip.bg, color: chip.fg }}>{chip.label}</span>
                    </div>
                    <p className="text-white font-bold mt-1" style={{ fontSize: 16 }}>{r.businessName}</p>
                    <p style={{ color: 'var(--muted)', fontSize: 13 }}>{fmtDate(r.routeDate)} · {r.reportTime} · {r.reportAddress}</p>
                    <p style={{ fontSize: 13, marginTop: 4, color: 'var(--muted)' }}>
                      {r.assignedStaffName ? <>Assigned: <b style={{ color: '#e5e7eb' }}>{r.assignedStaffName}</b></> : <span style={{ color: '#fcd34d' }}>Unassigned</span>}
                      {r.smsStatus === 'failed' && <span style={{ color: '#f87171' }}> · text failed</span>}
                      {r.smsStatus === 'no_phone' && <span style={{ color: '#f87171' }}> · no phone</span>}
                      {r.linkOpenedAt && !r.confirmedAt && !r.declinedAt && <span style={{ color: '#fcd34d' }}> · opened, not confirmed</span>}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-wrap mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                  <select defaultValue="" onChange={e => { if (e.target.value) patch(r.token, { action: 'assign', staffId: e.target.value }) }} disabled={busy}
                    style={{ ...iStyle, width: 'auto', padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>
                    <option value="">{r.assignedStaffName ? 'Reassign…' : 'Assign & text…'}</option>
                    {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.phone ? '' : ' (no phone)'}</option>)}
                  </select>
                  {r.assignedStaffId && <button onClick={() => patch(r.token, { action: 'resend' })} disabled={busy} style={btn}>Resend text</button>}
                  <button onClick={() => copyLink(r.token)} style={btn}>Copy link</button>
                  <select defaultValue="" onChange={e => { if (e.target.value) patch(r.token, { action: 'status', status: e.target.value }) }} disabled={busy}
                    style={{ ...iStyle, width: 'auto', padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>
                    <option value="">Mark…</option>
                    <option value="completed">Completed</option>
                    <option value="no_show">No Show</option>
                    <option value="no_response">No Response</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <button onClick={() => del(r.token)} disabled={busy} style={{ ...btn, color: '#f87171' }}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

export default function RoutesAdminPage() {
  return <AdminGate title="Route Dispatch"><Dashboard /></AdminGate>
}
