'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldCheck, MapPin } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat } from '../ui'

// GPS on-site compliance. Read gated server-side on routes:view. Verification is derived
// from stored raw captures (never mutated); records with no destination coordinate are
// shown as 'unverified', never as failures. Precise coordinates are intentionally not
// listed here — the per-punch pin lives on the route detail (ClockStrip).

type Status = 'verified_on_site' | 'outside_geofence' | 'low_accuracy' | 'location_unavailable' | 'expected_unavailable' | 'stale' | 'invalid_coordinates'
type Rec = { type: string; jobToken: string; jobNumber: string; staffId: string; staffName: string; date: string; clockInAt: number | null; status: Status; distanceM: number | null; accuracyM: number | null; accuracyBand: string; reason: string }
type Rollup = { total: number; eligible: number; verified: number; outside: number; lowAccuracy: number; unavailable: number; invalid: number; stale: number; verificationRate: number }

const META: Record<Status, { label: string; color: string }> = {
  verified_on_site: { label: 'Verified', color: '#34d399' },
  outside_geofence: { label: 'Off site', color: '#f87171' },
  low_accuracy: { label: 'Low accuracy', color: '#fbbf24' },
  location_unavailable: { label: 'No location', color: 'var(--muted)' },
  expected_unavailable: { label: 'Unverified (no dest coord)', color: 'var(--muted)' },
  stale: { label: 'Stale fix', color: 'var(--muted)' },
  invalid_coordinates: { label: 'Invalid', color: '#fbbf24' },
}
const field: React.CSSProperties = { padding: '8px 11px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }
const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, color: 'var(--text)', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' }
const fmtDate = (s: string) => s || '—'

function Board() {
  const [records, setRecords] = useState<Rec[]>([])
  const [rollup, setRollup] = useState<Rollup | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'denied' | 'error'>('loading')
  const [staff, setStaff] = useState<Array<{ id: string; name: string }>>([])
  const [staffId, setStaffId] = useState(''); const [status, setStatus] = useState<'' | Status>(''); const [type, setType] = useState('')
  const [start, setStart] = useState(''); const [end, setEnd] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    const p = new URLSearchParams()
    if (staffId) p.set('staffId', staffId); if (status) p.set('status', status); if (type) p.set('type', type); if (start) p.set('start', start); if (end) p.set('end', end)
    try {
      const res = await fetch(`/api/admin/gps-compliance?${p}`, { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('denied'); return }
      if (!res.ok) { setState('error'); return }
      const j = await res.json(); setRecords(j.records || []); setRollup(j.rollup || null); setState('ok')
    } catch { setState('error') }
  }, [staffId, status, type, start, end])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/refetch load; result state is set post-await
  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).then(j => setStaff(j.items || [])).catch(() => {}) }, [])

  const crewOpts = useMemo(() => staff.length ? staff : [...new Map(records.map(r => [r.staffId, { id: r.staffId, name: r.staffName }])).values()], [staff, records])

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><ShieldCheck size={20} /> GPS Compliance</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>On-site verification of clock-ins against the job’s stored location. Operational evidence — not proof of misconduct or a payroll input.</p>
      </header>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>Crew<select value={staffId} onChange={e => setStaffId(e.target.value)} style={{ ...field, minWidth: 140 }}><option value="">All</option>{crewOpts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>Status<select value={status} onChange={e => setStatus(e.target.value as '' | Status)} style={field}><option value="">Any</option>{(Object.keys(META) as Status[]).map(s => <option key={s} value={s}>{META[s].label}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>Work<select value={type} onChange={e => setType(e.target.value)} style={field}><option value="">All</option><option value="route">Routes</option><option value="booking">Bookings</option></select></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>From<input type="date" value={start} onChange={e => setStart(e.target.value)} style={field} /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>To<input type="date" value={end} onChange={e => setEnd(e.target.value)} style={field} /></label>
      </div>

      {state === 'loading' && <div style={{ color: 'var(--muted)', padding: '40px 0', textAlign: 'center' }}>Loading…</div>}
      {state === 'denied' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>You don’t have access to GPS compliance (requires <code>routes:view</code>).</div>}
      {state === 'error' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>Couldn’t load. <button type="button" onClick={load} style={{ ...field, cursor: 'pointer', marginLeft: 8 }}>Retry</button></div>}

      {state === 'ok' && rollup && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Stat label="Verified" value={String(rollup.verified)} tone={rollup.verified ? '#34d399' : undefined} />
            <Stat label="Off site" value={String(rollup.outside)} tone={rollup.outside ? '#f87171' : undefined} />
            <Stat label="Low accuracy" value={String(rollup.lowAccuracy)} tone={rollup.lowAccuracy ? '#fbbf24' : undefined} />
            <Stat label="Unverifiable" value={String(rollup.unavailable)} sub="no location / dest" />
            <Stat label="Verification rate" value={`${rollup.verificationRate}%`} sub={`of ${rollup.eligible} eligible`} />
          </div>

          {records.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>No GPS records for this filter.</div>
          ) : (
            <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
                <thead><tr>{['Status', 'Crew', 'Work', 'Date', 'Distance', 'Accuracy', 'Reason'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={`${r.jobToken}-${r.staffId}-${i}`} style={{ background: r.status === 'outside_geofence' ? 'rgba(248,113,113,.05)' : undefined }}>
                      <td style={td}><span style={{ color: META[r.status].color, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}><MapPin size={12} /> {META[r.status].label}</span></td>
                      <td style={{ ...td, fontWeight: 700 }}>{r.staffName}</td>
                      <td style={{ ...td, color: 'var(--muted)' }}>{r.type} · {r.jobNumber}</td>
                      <td style={{ ...td, color: 'var(--muted)' }}>{fmtDate(r.date)}</td>
                      <td style={td}>{r.distanceM == null ? '—' : `${r.distanceM} m`}</td>
                      <td style={{ ...td, color: 'var(--muted)' }}>{r.accuracyM == null ? '—' : `±${r.accuracyM} m (${r.accuracyBand})`}</td>
                      <td style={{ ...td, whiteSpace: 'normal', color: 'var(--muted)', fontSize: 12 }}>{r.reason.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '16px 0 0' }}>Records with no captured location or no stored destination coordinate are counted as unverifiable, never as failures. GPS is evidence, not automatic proof of misconduct or payroll eligibility.</p>
        </>
      )}
    </div>
  )
}

export default function GpsCompliancePage() {
  return <OperationsShell><Board /></OperationsShell>
}
