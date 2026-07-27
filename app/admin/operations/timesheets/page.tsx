'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, MapPin, AlertTriangle, PencilLine, History, X } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat } from '../ui'

// Crew timesheet. Reads the same clock stamps the portal punch writes, on both lanes
// (routes always; bookings when BOOKING_ASSIGNMENT_ENABLED). Server gates reads on
// time:view and corrections on time:manage.
//
// Every time shown here is the EFFECTIVE time — the original punch unless an
// append-only correction supersedes it. The original is never rewritten and is shown
// beside the corrected value in the editor and the history.

type PunchStatus = 'open' | 'complete' | 'invalid'
type TimeEntry = {
  type: 'route' | 'booking'
  jobToken: string; jobNumber: string
  staffId: string; staffName: string; date: string
  clockInAt: number | null; clockOutAt: number | null
  durationMinutes: number | null; status: PunchStatus; locationDenied: boolean
  punchId: string
  corrected: boolean
  originalClockInAt: number | null; originalClockOutAt: number | null
  correctionId?: string; correctedAt?: number; correctionCount: number
}
type Correction = {
  correctionId: string; correctedAt: number
  correctedByUserId: string; correctedByRole: string
  originalClockIn: number | null; originalClockOut: number | null
  previousEffectiveClockIn: number | null; previousEffectiveClockOut: number | null
  correctedClockIn: number; correctedClockOut: number | null
  correctionReason: string; correctionNote?: string
  status: 'active' | 'superseded' | 'reversed'; version: number
}
type StaffRollup = { staffId: string; staffName: string; totalMinutes: number; entries: number; openCount: number; invalidCount: number }
type Payload = {
  entries: TimeEntry[]; byStaff: StaffRollup[]; periodTotalMinutes: number
  bookingLaneEnabled: boolean
  canCorrect?: boolean
}
type Staff = { id: string; name: string }

const fmtMins = (min: number): string => `${Math.floor(min / 60)}h ${Math.abs(min % 60)}m`
const fmtClock = (ms: number | null): string =>
  ms == null ? '—' : new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })

const field: React.CSSProperties = { padding: '9px 12px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }

// ── Filter sizing ────────────────────────────────────────────────────────────
// A bare `<input type="date">` renders at the BROWSER's intrinsic width, which is
// far wider than it needs to be and made From/To tower over the Crew and Work
// selects. Each control now declares its own width, and `minWidth: 0` lets it
// shrink inside the wrapping flex row instead of forcing page-level overflow.
// Widths are set (not min-widths) so the native date UI keeps rendering its own
// localized format — we never lay the segments out ourselves.
const filterRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 18,
}
const filterLabel: React.CSSProperties = {
  display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700,
  minWidth: 0,                       // allows the control to shrink rather than overflow
}
// flex: '1 1 <basis>' → the declared desktop width, shrinking to the min on narrow
// screens where the row wraps. From/To share a basis so they land as equal columns.
const crewField: React.CSSProperties = { ...field, width: '100%', minWidth: 0 }
const dateField: React.CSSProperties = { ...field, width: '100%', minWidth: 0, minHeight: 40 }
const workField: React.CSSProperties = { ...field, width: '100%', minWidth: 0 }
const crewCell: React.CSSProperties = { ...filterLabel, flex: '1 1 168px', maxWidth: 180 }
const dateCell: React.CSSProperties = { ...filterLabel, flex: '1 1 128px', maxWidth: 135, minWidth: 116 }
const workCell: React.CSSProperties = { ...filterLabel, flex: '1 1 132px', maxWidth: 150 }
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


// ── datetime-local helpers ───────────────────────────────────────────────────
// The native control speaks local wall-clock; the store speaks epoch ms. These are
// the only two places that convert, so a correction can never be off by a timezone.
const toLocalInput = (ms: number | null): string => {
  if (ms == null) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (v: string): number | null => {
  if (!v) return null
  const ms = new Date(v).getTime()
  return Number.isFinite(ms) ? ms : null
}
const durationLabel = (inMs: number | null, outMs: number | null): string => {
  if (inMs == null || outMs == null) return '—'
  if (outMs < inMs) return 'invalid'
  return fmtMins(Math.round((outMs - inMs) / 60_000))
}

function CorrectionModal({ entry, onClose, onSaved }: {
  entry: TimeEntry
  onClose: () => void
  onSaved: () => void
}) {
  const [inVal, setInVal] = useState(toLocalInput(entry.clockInAt))
  const [outVal, setOutVal] = useState(toLocalInput(entry.clockOutAt))
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [version, setVersion] = useState<number | null>(null)
  const [history, setHistory] = useState<Correction[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)

  // Load the authoritative history + version before allowing a save, so the editor
  // always submits against the state it was actually shown.
  useEffect(() => {
    let alive = true
    fetch(`/api/admin/time-corrections?punchId=${encodeURIComponent(entry.punchId)}`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { if (alive && d.ok) { setVersion(d.version ?? 0); setHistory(d.corrections ?? []) } })
      .catch(() => { if (alive) setErr('Could not load correction history.') })
    return () => { alive = false }
  }, [entry.punchId])

  const nextIn = fromLocalInput(inVal)
  const nextOut = fromLocalInput(outVal)
  const unchanged = nextIn === entry.clockInAt && nextOut === entry.clockOutAt
  const invalidOrder = nextIn != null && nextOut != null && nextOut < nextIn

  async function save() {
    setErr(''); setBusy(true)
    try {
      const res = await fetch('/api/admin/time-corrections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({
          punchId: entry.punchId,
          correctedClockIn: nextIn,
          correctedClockOut: nextOut,
          correctionReason: reason,
          correctionNote: note || undefined,
          expectedVersion: version ?? undefined,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not save the correction.'); return }
      setOk(true)
      onSaved()
      setTimeout(onClose, 600)
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  const label: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }
  const ro: React.CSSProperties = { fontSize: 13.5, color: 'var(--text)', fontWeight: 600 }

  return (
    <div role="dialog" aria-modal="true" aria-label="Edit time"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: 0 }}>Edit time</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 14 }}>
          <div><div style={label}>Crew</div><div style={ro}>{entry.staffName}</div></div>
          <div><div style={label}>Work</div><div style={{ ...ro, textTransform: 'capitalize' }}>{entry.type} · {entry.jobNumber}</div></div>
          <div><div style={label}>Service date</div><div style={ro}>{entry.date || '—'}</div></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, padding: 12, border: '1px solid var(--line)', borderRadius: 12, marginBottom: 14 }}>
          <div><div style={label}>Original in</div><div style={ro}>{fmtClock(entry.originalClockInAt)}</div></div>
          <div><div style={label}>Original out</div><div style={ro}>{fmtClock(entry.originalClockOutAt)}</div></div>
          <div><div style={label}>Current effective in</div><div style={ro}>{fmtClock(entry.clockInAt)}</div></div>
          <div><div style={label}>Current effective out</div><div style={ro}>{fmtClock(entry.clockOutAt)}</div></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 12 }}>
          <label style={label}>Corrected clock-in
            <input type="datetime-local" value={inVal} onChange={e => setInVal(e.target.value)} style={{ ...field, minHeight: 44 }} />
          </label>
          <label style={label}>Corrected clock-out
            <input type="datetime-local" value={outVal} onChange={e => setOutVal(e.target.value)} style={{ ...field, minHeight: 44 }} />
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          Corrected duration: <strong style={{ color: 'var(--text)' }}>{durationLabel(nextIn, nextOut)}</strong>
          {!outVal && ' · leave clock-out empty only if they are genuinely still on the clock'}
        </p>

        <label style={{ ...label, marginBottom: 10 }}>Reason (required)
          <input value={reason} onChange={e => setReason(e.target.value)} maxLength={200}
            placeholder="e.g. Forgot to clock out" style={{ ...field, minHeight: 44 }} />
        </label>
        <label style={{ ...label, marginBottom: 12 }}>Note (optional, internal)
          <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} rows={2}
            style={{ ...field, resize: 'vertical' }} />
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'rgba(245,158,11,.10)', marginBottom: 14 }}>
          <AlertTriangle size={14} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.45 }}>
            This changes payable hours for <strong>hourly</strong> assignments. For a <strong>flat route</strong>
            {' '}assignment it updates the recorded time only — the flat amount does not change. An issued pay
            statement is never rewritten; correct the period, then void and re-issue if it needs restating.
          </p>
        </div>

        {err && <p role="alert" style={{ fontSize: 12.5, color: '#fca5a5', margin: '0 0 10px' }}>{err}</p>}
        {ok && <p style={{ fontSize: 12.5, color: '#34d399', margin: '0 0 10px' }}>Correction saved.</p>}
        {unchanged && !err && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>Change a time to save a correction.</p>}
        {invalidOrder && <p role="alert" style={{ fontSize: 12.5, color: '#fca5a5', margin: '0 0 10px' }}>Clock-out cannot precede clock-in.</p>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={save}
            disabled={busy || ok || unchanged || invalidOrder || !reason.trim() || nextIn == null || version == null}
            style={{ ...field, cursor: 'pointer', fontWeight: 800, minHeight: 44, opacity: (busy || unchanged || !reason.trim() || nextIn == null) ? .55 : 1 }}>
            {busy ? 'Saving…' : 'Save correction'}
          </button>
          <button type="button" onClick={onClose} style={{ ...field, cursor: 'pointer', color: 'var(--muted)', minHeight: 44 }}>Cancel</button>
          {history.length > 0 && (
            <button type="button" onClick={() => setShowHistory(v => !v)}
              style={{ ...field, cursor: 'pointer', color: 'var(--muted)', minHeight: 44, marginLeft: 'auto' }}>
              <History size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
              {showHistory ? 'Hide' : `History (${history.length})`}
            </button>
          )}
        </div>

        {showHistory && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
              ORIGINAL · {fmtClock(entry.originalClockInAt)} → {fmtClock(entry.originalClockOutAt)}
            </div>
            {history.map(c => (
              <div key={c.correctionId} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                    {fmtClock(c.previousEffectiveClockIn)} → {fmtClock(c.previousEffectiveClockOut)}
                    {'  ⟶  '}
                    {fmtClock(c.correctedClockIn)} → {fmtClock(c.correctedClockOut)}
                  </span>
                  <span style={{ fontSize: 11, color: c.status === 'active' ? '#34d399' : 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{c.status}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  v{c.version} · {c.correctedByUserId} ({c.correctedByRole}) · {new Date(c.correctedAt).toLocaleString('en-US')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 4 }}>{c.correctionReason}</div>
                {c.correctionNote && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{c.correctionNote}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
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
  const [editing, setEditing] = useState<TimeEntry | null>(null)

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
      <div style={filterRow}>
        <label style={crewCell}>
          Crew
          <select value={staffId} onChange={e => setStaffId(e.target.value)} style={crewField}>
            <option value="">All crew</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={dateCell}>
          From
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={dateField} />
        </label>
        <label style={dateCell}>
          To
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={dateField} />
        </label>
        <label style={workCell}>
          Work
          <select value={type} onChange={e => setType(e.target.value as '' | 'route' | 'booking')} style={workField}>
            <option value="">All work</option>
            <option value="route">Routes</option>
            <option value="booking">Bookings</option>
          </select>
        </label>
        {(staffId || start || end || type) && (
          <button type="button" onClick={() => { setStaffId(''); setStart(''); setEnd(''); setType('') }}
            style={{ ...field, cursor: 'pointer', color: 'var(--muted)', fontWeight: 700, minHeight: 40, flex: '0 0 auto' }}>Clear</button>
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
                    {data.canCorrect && <th style={th} aria-label="Actions" />}
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
                        <td style={td}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <StatusBadge s={e.status} />
                            {e.corrected && (
                              <span title={`Corrected — original ${fmtClock(e.originalClockInAt)} → ${fmtClock(e.originalClockOutAt)}`}
                                style={{ padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: '#93c5fd', background: 'rgba(147,197,253,.13)' }}>
                                Corrected
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={td}>
                          {e.locationDenied
                            ? <span style={{ color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}><MapPin size={12} /> off</span>
                            : <span style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}><MapPin size={12} /> ok</span>}
                        </td>
                        {data.canCorrect && (
                          <td style={td}>
                            <button type="button" onClick={() => setEditing(e)} className="os-tap"
                              aria-label={`Edit time for ${e.staffName} on ${e.jobNumber}`}
                              style={{ ...field, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', color: 'var(--muted)', fontWeight: 700 }}>
                              <PencilLine size={12} style={{ marginRight: 5, verticalAlign: -2 }} />Edit time
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '16px 0 0' }}>
            Times shown are effective values. A correction never rewrites the original punch — it appends an
            attributed, auditable record, and the original stays visible in the editor and its history.
          </p>
        </>
      )}

      {editing && (
        <CorrectionModal
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { load() }}
        />
      )}
    </div>
  )
}

export default function TimesheetsPage() {
  return <OperationsShell><Board /></OperationsShell>
}
