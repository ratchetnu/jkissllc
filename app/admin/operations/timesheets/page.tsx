'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, MapPin, AlertTriangle } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat } from '../ui'

// Read-only crew timesheet. Reads the same clock stamps the portal punch writes, on
// both lanes (routes always; bookings when BOOKING_ASSIGNMENT_ENABLED). Server gates
// on time:view. Corrections are intentionally NOT offered here — see the note below.

type PunchStatus = 'open' | 'complete' | 'invalid'
type TimeEntry = {
  type: 'route' | 'booking'
  jobToken: string; jobNumber: string
  staffId: string; staffName: string; date: string
  clockInAt: number | null; clockOutAt: number | null
  durationMinutes: number | null; status: PunchStatus; locationDenied: boolean
}
type StaffRollup = { staffId: string; staffName: string; totalMinutes: number; entries: number; openCount: number; invalidCount: number }
type Payload = {
  entries: TimeEntry[]; byStaff: StaffRollup[]; periodTotalMinutes: number
  bookingLaneEnabled: boolean
}
type Staff = { id: string; name: string }

const fmtMins = (min: number): string => `${Math.floor(min / 60)}h ${Math.abs(min % 60)}m`
const fmtClock = (ms: number | null): string =>
  ms == null ? '—' : new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })

const field: React.CSSProperties = { padding: '9px 12px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }
const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '11px 12px', fontSize: 13.5, color: 'var(--text)', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' }

function StatusBadge({ s }: { s: PunchStatus }) {
  const map: Record<PunchStatus, { label: string; fg: string; bg: string }> = {
    open: { label: 'On the clock', fg: '#34d399', bg: 'rgba(52,211,153,.13)' },
    complete: { label: 'Complete', fg: 'var(--muted)', bg: 'rgba(255,255,255,.06)' },
    invalid: { label: 'Needs review', fg: '#f59e0b', bg: 'rgba(245,158,11,.13)' },
  }
  const v = map[s]
  return <span style={{ padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, color: v.fg, background: v.bg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    {s === 'open' && <Clock size={11} />}{s === 'invalid' && <AlertTriangle size={11} />}{v.label}
  </span>
}

function Board() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<'ok' | 'denied' | 'error'>('ok')

  const [staffId, setStaffId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [type, setType] = useState<'' | 'route' | 'booking'>('')

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams()
    if (staffId) qs.set('staffId', staffId)
    if (start) qs.set('start', start)
    if (end) qs.set('end', end)
    if (type) qs.set('type', type)
    try {
      const res = await fetch(`/api/admin/timesheets?${qs.toString()}`, { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('denied'); setData(null); return }
      if (!res.ok) { setState('error'); setData(null); return }
      setState('ok'); setData(await res.json())
    } catch { setState('error'); setData(null) } finally { setLoading(false) }
  }, [staffId, start, end, type])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).then(s => setStaff(s.items || [])).catch(() => {})
  }, [])

  const totalLabel = useMemo(() => (data ? fmtMins(data.periodTotalMinutes) : '—'), [data])

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
          <Clock size={20} /> Timesheets
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>
          Hours worked from crew clock-ins. Read-only — payable totals count completed punches only.
        </p>
      </header>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 18 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
          Crew
          <select value={staffId} onChange={e => setStaffId(e.target.value)} style={{ ...field, minWidth: 160 }}>
            <option value="">All crew</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
          From
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={field} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
          To
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={field} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
          Work
          <select value={type} onChange={e => setType(e.target.value as '' | 'route' | 'booking')} style={{ ...field, minWidth: 120 }}>
            <option value="">All work</option>
            <option value="route">Routes</option>
            <option value="booking">Bookings</option>
          </select>
        </label>
        {(staffId || start || end || type) && (
          <button type="button" onClick={() => { setStaffId(''); setStart(''); setEnd(''); setType('') }}
            style={{ ...field, cursor: 'pointer', color: 'var(--muted)', fontWeight: 700 }}>Clear</button>
        )}
      </div>

      {loading && <div style={{ color: 'var(--muted)', padding: '40px 0', textAlign: 'center' }}>Loading timesheets…</div>}

      {!loading && state === 'denied' && (
        <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>
          You don’t have access to timesheets. This surface requires the <code>time:view</code> permission.
        </div>
      )}
      {!loading && state === 'error' && (
        <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>
          Couldn’t load timesheets. <button type="button" onClick={load} style={{ ...field, cursor: 'pointer', marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {!loading && state === 'ok' && data && (
        <>
          {/* Totals */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 }}>
            <Stat label="Period total" value={totalLabel} sub="completed punches" />
            <Stat label="Entries" value={String(data.entries.length)} />
            <Stat label="On the clock" value={String(data.entries.filter(e => e.status === 'open').length)} tone={data.entries.some(e => e.status === 'open') ? '#34d399' : undefined} />
            <Stat label="Needs review" value={String(data.entries.filter(e => e.status === 'invalid').length)} tone={data.entries.some(e => e.status === 'invalid') ? '#f59e0b' : undefined} />
          </div>

          {!data.bookingLaneEnabled && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 14px' }}>
              Booking-lane hours are hidden — <code>BOOKING_ASSIGNMENT_ENABLED</code> is off. Route hours are shown.
            </p>
          )}

          {data.entries.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
              No time entries for this filter.
            </div>
          ) : (
            <>
              {/* By-staff rollup */}
              {data.byStaff.length > 1 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>By crew</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {data.byStaff.map(r => (
                      <div key={r.staffId} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px', minWidth: 150 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{r.staffName}</div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{fmtMins(r.totalMinutes)}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                          {r.entries} {r.entries === 1 ? 'entry' : 'entries'}{r.openCount ? ` · ${r.openCount} open` : ''}{r.invalidCount ? ` · ${r.invalidCount} review` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Entries table — scrolls horizontally on narrow screens, never the page */}
              <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead><tr>
                    <th style={th}>Work</th><th style={th}>Job</th><th style={th}>Crew</th><th style={th}>Date</th>
                    <th style={th}>In</th><th style={th}>Out</th><th style={th}>Duration</th><th style={th}>Status</th><th style={th}>Location</th>
                  </tr></thead>
                  <tbody>
                    {data.entries.map((e, i) => (
                      <tr key={`${e.jobToken}-${e.staffId}-${i}`} style={{ background: e.status === 'open' ? 'rgba(52,211,153,.05)' : undefined }}>
                        <td style={{ ...td, textTransform: 'capitalize', color: 'var(--muted)' }}>{e.type}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{e.jobNumber}</td>
                        <td style={td}>{e.staffName}</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{e.date || '—'}</td>
                        <td style={td}>{fmtClock(e.clockInAt)}</td>
                        <td style={td}>{fmtClock(e.clockOutAt)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{e.durationMinutes == null ? '—' : fmtMins(e.durationMinutes)}</td>
                        <td style={td}><StatusBadge s={e.status} /></td>
                        <td style={td}>
                          {e.locationDenied
                            ? <span style={{ color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}><MapPin size={12} /> off</span>
                            : <span style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}><MapPin size={12} /> ok</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '16px 0 0' }}>
            Entries reflect crew punches as recorded. Manual time corrections are not available here — a safe
            correction model (immutable original + audit trail) is planned separately.
          </p>
        </>
      )}
    </div>
  )
}

export default function TimesheetsPage() {
  return <OperationsShell><Board /></OperationsShell>
}
