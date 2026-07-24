'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Wrench, X, AlertTriangle, Ban, Flag } from 'lucide-react'
import OperationsShell from '../OperationsShell'

// Fleet maintenance surface. Read gated server-side on equipment:view; mutations on
// fleet:maintenance. Status is derived by lib/fleet/maintenance; out-of-service equipment
// is always benched. No external notifications — the maintenance.flag run writes internal
// flags only.

type Status = 'current' | 'due_soon' | 'overdue' | 'inspection_required' | 'out_of_service' | 'unknown'
type Item = {
  id: string; name: string; truckType?: string; ownership: string; active: boolean
  status: Status; outOfService: boolean; outOfServiceReason: string | null
  lastServiceAt: number | null; nextDueAt: number | null; inspectionDueAt: number | null; historyCount: number
}
type Summary = Record<Status, number>
type ServiceEvent = { id: string; at: number; kind: string; note?: string; odometer?: number; actor?: string }

const STATUS_META: Record<Status, { label: string; fg: string; bg: string }> = {
  current: { label: 'Current', fg: '#34d399', bg: 'rgba(52,211,153,.13)' },
  due_soon: { label: 'Due soon', fg: '#fbbf24', bg: 'rgba(251,191,36,.13)' },
  overdue: { label: 'Overdue', fg: '#f87171', bg: 'rgba(248,113,113,.14)' },
  inspection_required: { label: 'Inspection', fg: '#f59e0b', bg: 'rgba(245,158,11,.13)' },
  out_of_service: { label: 'Out of service', fg: '#f87171', bg: 'rgba(248,113,113,.18)' },
  unknown: { label: 'No schedule', fg: 'var(--muted)', bg: 'rgba(255,255,255,.06)' },
}
const fmtDate = (ms: number | null) => (ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }))
const field: React.CSSProperties = { padding: '8px 11px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }
const btn: React.CSSProperties = { ...field, cursor: 'pointer', fontWeight: 700, fontSize: 12.5 }
const Badge = ({ s }: { s: Status }) => { const v = STATUS_META[s]; return <span style={{ padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, color: v.fg, background: v.bg }}>{v.label}</span> }

function Board() {
  const [items, setItems] = useState<Item[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'denied' | 'error'>('loading')
  const [q, setQ] = useState(''); const [status, setStatus] = useState<'' | Status>(''); const [type, setType] = useState('')
  const [detail, setDetail] = useState<Item | null>(null); const [history, setHistory] = useState<ServiceEvent[]>([])
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    try {
      const res = await fetch('/api/admin/fleet/maintenance', { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('denied'); return }
      if (!res.ok) { setState('error'); return }
      const j = await res.json(); setItems(j.items || []); setSummary(j.summary || null); setState('ok')
    } catch { setState('error') }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount load; result state is set post-await
  useEffect(() => { load() }, [load])

  const openDetail = useCallback(async (it: Item) => {
    setDetail(it); setHistory([]); setMsg('')
    try { const j = await (await fetch(`/api/admin/fleet/maintenance/${it.id}`, { credentials: 'same-origin' })).json(); setHistory(j.equipment?.maintenance?.history ?? []) } catch { /* ignore */ }
  }, [])

  const act = useCallback(async (id: string, payload: Record<string, unknown>) => {
    setMsg('Saving…')
    try {
      const res = await fetch(`/api/admin/fleet/maintenance/${id}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) { setMsg('Could not save.'); return }
      setMsg('Saved.'); await load()
      const j = await res.json(); setHistory(j.equipment?.maintenance?.history ?? [])
      setDetail(d => d ? { ...d, status: j.status, outOfService: !!j.equipment?.maintenance?.outOfService } : d)
    } catch { setMsg('Could not save.') }
  }, [load])

  const runFlag = useCallback(async () => {
    setMsg('Running…')
    try { const j = await (await fetch('/api/admin/fleet/maintenance', { method: 'POST', credentials: 'same-origin' })).json(); setMsg(`Flag run: ${j.flagged} flagged, ${j.changed} changed.`) } catch { setMsg('Flag run failed.') }
  }, [])

  const types = useMemo(() => [...new Set(items.map(i => i.truckType).filter(Boolean))] as string[], [items])
  const shown = useMemo(() => items.filter(i =>
    (!q || `${i.name} ${i.truckType ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
    (!status || i.status === status) && (!type || i.truckType === type)
  ), [items, q, status, type])

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><Wrench size={20} /> Fleet Maintenance</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>Service schedules, inspections, and out-of-service status. Out-of-service assets can’t be assigned to routes.</p>
        </div>
        <button type="button" onClick={runFlag} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Flag size={13} /> Run maintenance check</button>
      </header>

      {state === 'loading' && <div style={{ color: 'var(--muted)', padding: '40px 0', textAlign: 'center' }}>Loading fleet…</div>}
      {state === 'denied' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>You don’t have access to fleet maintenance (requires <code>equipment:view</code>).</div>}
      {state === 'error' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>Couldn’t load the fleet. <button type="button" onClick={load} style={{ ...btn, marginLeft: 8 }}>Retry</button></div>}

      {state === 'ok' && (
        <>
          {summary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
              {(['overdue', 'inspection_required', 'due_soon', 'out_of_service', 'current', 'unknown'] as Status[]).map(s => (
                <div key={s} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '11px 13px' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: STATUS_META[s].fg }}>{summary[s]}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>{STATUS_META[s].label}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search equipment" style={{ ...field, flex: '1 1 180px' }} />
            <select value={status} onChange={e => setStatus(e.target.value as '' | Status)} style={field}><option value="">All statuses</option>{(Object.keys(STATUS_META) as Status[]).map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}</select>
            <select value={type} onChange={e => setType(e.target.value)} style={field}><option value="">All types</option>{types.map(t => <option key={t} value={t}>{t}</option>)}</select>
          </div>

          {shown.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>No equipment matches.</div>
          ) : (
            <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr>{['Equipment', 'Status', 'Next service', 'Last service', 'History', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {shown.map(it => (
                    <tr key={it.id} style={{ background: it.status === 'overdue' || it.status === 'out_of_service' ? 'rgba(248,113,113,.05)' : undefined }}>
                      <td style={{ padding: '11px 12px', borderTop: '1px solid var(--line)' }}><div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{it.name}</div><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{it.truckType || it.ownership}</div></td>
                      <td style={{ padding: '11px 12px', borderTop: '1px solid var(--line)' }}><Badge s={it.status} /></td>
                      <td style={{ padding: '11px 12px', borderTop: '1px solid var(--line)', fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtDate(it.nextDueAt)}</td>
                      <td style={{ padding: '11px 12px', borderTop: '1px solid var(--line)', fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtDate(it.lastServiceAt)}</td>
                      <td style={{ padding: '11px 12px', borderTop: '1px solid var(--line)', fontSize: 13, color: 'var(--muted)' }}>{it.historyCount}</td>
                      <td style={{ padding: '11px 12px', borderTop: '1px solid var(--line)' }}><button type="button" onClick={() => openDetail(it)} style={btn}>Manage</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, 100%)', height: '100%', background: 'var(--bg, #0b0b0c)', borderLeft: '1px solid var(--line)', overflowY: 'auto', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>{detail.name}</div>
              <button type="button" aria-label="Close" onClick={() => setDetail(null)} style={{ ...btn, padding: 8 }}><X size={16} /></button>
            </div>
            <div style={{ marginBottom: 14 }}><Badge s={detail.status} /> {detail.outOfService && detail.outOfServiceReason && <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {detail.outOfServiceReason}</span>}</div>

            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" onClick={() => act(detail.id, { action: 'add_service', kind: 'service' })} style={btn}>Log service done today</button>
              <button type="button" onClick={() => act(detail.id, { action: 'mark_inspection' })} style={btn}>Mark inspection complete</button>
              <ScheduleForm onSave={(intervalDays, intervalMiles) => act(detail.id, { action: 'update_schedule', ...(intervalDays ? { intervalDays } : {}), ...(intervalMiles ? { intervalMiles } : {}) })} />
              {detail.outOfService
                ? <button type="button" onClick={() => act(detail.id, { action: 'return_to_service' })} style={{ ...btn, color: '#34d399' }}>Return to service</button>
                : <button type="button" onClick={() => { const reason = prompt('Reason for taking out of service?') ?? undefined; act(detail.id, { action: 'out_of_service', reason }) }} style={{ ...btn, color: '#f87171', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}><Ban size={13} /> Take out of service</button>}
            </div>
            {msg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>{msg}</div>}

            <div style={{ marginTop: 18, fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Service history</div>
            {history.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>No service events yet.</div> : (
              <div style={{ marginTop: 8 }}>
                {[...history].reverse().map(h => (
                  <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <div style={{ fontSize: 13, color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'center' }}>{h.kind === 'inspection' ? <AlertTriangle size={12} /> : <Wrench size={12} />} {h.kind}{h.odometer != null ? ` · ${h.odometer} mi` : ''}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtDate(h.at)}{h.note ? ` · ${h.note}` : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ScheduleForm({ onSave }: { onSave: (days?: number, miles?: number) => void }) {
  const [days, setDays] = useState(''); const [miles, setMiles] = useState('')
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Service interval</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={days} onChange={e => setDays(e.target.value.replace(/[^\d]/g, ''))} placeholder="Every N days" inputMode="numeric" style={{ ...field, flex: 1 }} />
        <input value={miles} onChange={e => setMiles(e.target.value.replace(/[^\d]/g, ''))} placeholder="Every N miles" inputMode="numeric" style={{ ...field, flex: 1 }} />
      </div>
      <button type="button" onClick={() => onSave(days ? Number(days) : undefined, miles ? Number(miles) : undefined)} style={btn}>Save schedule</button>
    </div>
  )
}

export default function FleetPage() {
  return <OperationsShell><Board /></OperationsShell>
}
