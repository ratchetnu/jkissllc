'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pause, Play, Copy, Trash2, Archive, Pencil, Bell, AlertTriangle } from 'lucide-react'
import { osField, osLabel, Toggle } from '../ui'
import {
  api, Icon, Sheet, SEGMENTS, relTime,
  type ReminderT, type TemplateDef, type CrewCardT, type ChannelId,
} from './commsShared'

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const SCHEDULES = [
  { id: 'one_time', label: 'One-time' }, { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' },
  { id: 'route_start', label: 'Route start' }, { id: 'route_end', label: 'Route end' }, { id: 'route_relative', label: 'Relative to route' },
]
const ESC_ACTIONS = [
  { id: 'resend', label: 'Remind again' }, { id: 'notify_manager', label: 'Notify manager' }, { id: 'notify_admin', label: 'Notify admin' },
]

function scheduleSummary(r: ReminderT): string {
  const s = r.schedule
  if (s.kind === 'one_time') return `Once ${s.date || ''} at ${s.time || ''}`
  if (s.kind === 'daily') return `Daily at ${s.time || ''}`
  if (s.kind === 'weekly') return `${(s.weekdays || []).map(d => DOW[d]).join('/')} at ${s.time || ''}`
  if (s.kind === 'route_start') return 'At route start'
  if (s.kind === 'route_end') return 'At route end'
  if (s.kind === 'route_relative') { const o = s.offsetMinutes || 0; return `${Math.abs(o)}m ${o < 0 ? 'before' : 'after'} route start` }
  return s.kind
}
function targetSummary(r: ReminderT): string {
  const t = r.target
  if (t.mode === 'all') return 'Entire crew'
  if (t.mode === 'crew') return `${t.staffIds?.length || 0} crew`
  if (t.mode === 'business') return `${t.businessKeys?.length || 0} business${(t.businessKeys?.length || 0) === 1 ? '' : 'es'}`
  if (t.mode === 'route') return `${t.routeTokens?.length || 0} route(s)`
  if (t.mode === 'segment') return SEGMENTS.find(s => s.id === t.segment)?.label || 'Segment'
  return t.mode
}
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0)

// Reminder Management dashboard (request Part 7). Every reminder with its schedule,
// recipients, completion/ack rates, failures, escalations, and last run — plus
// create / duplicate / pause / resume / delete / archive and the template-driven editor.
export default function RemindersManager({ templates }: { templates: TemplateDef[] }) {
  const [reminders, setReminders] = useState<ReminderT[]>([])
  const [crew, setCrew] = useState<CrewCardT[]>([])
  const [businesses, setBusinesses] = useState<{ key: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ReminderT | 'new' | null>(null)
  const [tab, setTab] = useState<'active' | 'archived'>('active')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, d] = await Promise.all([
        api<{ reminders: ReminderT[] }>('/api/admin/reminders'),
        api<{ crew: CrewCardT[]; businesses: { key: string; name: string }[] }>('/api/admin/crew-directory'),
      ])
      setReminders(r.reminders); setCrew(d.crew); setBusinesses(d.businesses)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const shown = useMemo(() => reminders.filter(r => tab === 'archived' ? r.archived : !r.archived), [reminders, tab])

  async function act(r: ReminderT, action: string) {
    if (action === 'delete' && !confirm(`Delete "${r.title}"? This can't be undone.`)) return
    try {
      if (action === 'delete') await api(`/api/admin/reminders/${r.id}`, { method: 'DELETE' })
      else if (action === 'duplicate') await api(`/api/admin/reminders/${r.id}/duplicate`, { method: 'POST' })
      else await api(`/api/admin/reminders/${r.id}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      load()
    } catch (e) { alert(e instanceof Error ? e.message : 'Action failed') }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['active', 'archived'] as const).map(t => (
            <button key={t} className="cc-seg" data-active={tab === t} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t}</button>
          ))}
        </div>
        <button onClick={() => setEditing('new')} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 999, padding: '9px 16px', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' }}>
          <Plus size={16} /> New reminder
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ height: 96 }}><div className="skeleton" style={{ width: '50%', height: 16, margin: 16, borderRadius: 8 }} /></div>)}</div>
      ) : shown.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 40, textAlign: 'center' }}>
          <Bell size={30} style={{ color: 'var(--muted)' }} />
          <p className="jkos-h" style={{ fontSize: 18, marginTop: 10 }}>No {tab} reminders</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Create your first automated reminder — uniform photos, route confirmations, clock-ins and more.</p>
          {tab === 'active' && <button onClick={() => setEditing('new')} className="os-tap" style={{ marginTop: 14, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 999, padding: '9px 18px', fontSize: 14, fontWeight: 800, cursor: 'pointer' }}>New reminder</button>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((r, i) => {
            const tpl = templates.find(t => t.id === r.templateId)
            return (
              <div key={r.id} className="os-card os-rise" style={{ padding: 15, animationDelay: `${Math.min(i * 25, 200)}ms`, opacity: r.paused ? .68 : 1 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', flexShrink: 0 }}><Icon name={tpl?.icon || 'Bell'} size={18} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: 15.5 }}>{r.title}</span>
                      {r.paused && <span style={statusPill('#fcd34d', 'rgba(245,158,11,.15)')}>Paused</span>}
                      {!r.active && !r.archived && <span style={statusPill('#94a3b8', 'rgba(255,255,255,.06)')}>Off</span>}
                      {r.active && !r.paused && !r.archived && <span style={statusPill('#86efac', 'rgba(34,197,94,.16)')}>Live</span>}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{scheduleSummary(r)} · {targetSummary(r)} · {r.channels.join(', ')}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12, fontSize: 12 }}>
                  <Metric label="Sent" value={String(r.stats.sent)} />
                  <Metric label="Completion" value={`${pct(r.stats.completed, r.stats.sent)}%`} tone="#86efac" />
                  <Metric label="Ack" value={`${pct(r.stats.acked, r.stats.sent)}%`} tone="#93c5fd" />
                  <Metric label="Failures" value={String(r.stats.failed)} tone={r.stats.failed ? '#fca5a5' : undefined} />
                  <Metric label="Escalations" value={String(r.stats.escalations)} tone={r.stats.escalations ? '#fcd34d' : undefined} />
                  <Metric label="Last run" value={relTime(r.lastRunAt)} />
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                  <IconBtn icon={<Pencil size={13} />} label="Edit" onClick={() => setEditing(r)} />
                  {!r.archived && <IconBtn icon={r.paused ? <Play size={13} /> : <Pause size={13} />} label={r.paused ? 'Resume' : 'Pause'} onClick={() => act(r, r.paused ? 'resume' : 'pause')} />}
                  <IconBtn icon={<Copy size={13} />} label="Duplicate" onClick={() => act(r, 'duplicate')} />
                  {!r.archived
                    ? <IconBtn icon={<Archive size={13} />} label="Archive" onClick={() => act(r, 'archive')} />
                    : <IconBtn icon={<Archive size={13} />} label="Unarchive" onClick={() => act(r, 'unarchive')} />}
                  <IconBtn icon={<Trash2 size={13} />} label="Delete" danger onClick={() => act(r, 'delete')} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <ReminderEditor
          reminder={editing === 'new' ? null : editing}
          templates={templates} crew={crew} businesses={businesses}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

const statusPill = (fg: string, bg: string): React.CSSProperties => ({ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, color: fg, background: bg })
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</div><div className="tabular-nums" style={{ fontSize: 15, fontWeight: 800, color: tone || 'var(--text)' }}>{value}</div></div>
}
function IconBtn({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return <button onClick={onClick} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', fontSize: 12, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: danger ? '#fca5a5' : 'var(--muted)', cursor: 'pointer' }}>{icon} {label}</button>
}

// ── Editor ───────────────────────────────────────────────────────────────────
function ReminderEditor({ reminder, templates, crew, businesses, onClose, onSaved }: {
  reminder: ReminderT | null
  templates: TemplateDef[]
  crew: CrewCardT[]
  businesses: { key: string; name: string }[]
  onClose: () => void; onSaved: () => void
}) {
  const t0 = reminder ? templates.find(t => t.id === reminder.templateId) : templates.find(t => t.id === 'custom')
  const [templateId, setTemplateId] = useState(reminder?.templateId || 'custom')
  const [title, setTitle] = useState(reminder?.title || t0?.label || '')
  const [message, setMessage] = useState(reminder?.message || t0?.defaultMessage || '')
  const [channels, setChannels] = useState<ChannelId[]>(reminder?.channels || t0?.defaultChannels || ['inapp', 'sms'])
  const [kind, setKind] = useState(reminder?.schedule.kind || 'daily')
  const [time, setTime] = useState(reminder?.schedule.time || '07:00')
  const [date, setDate] = useState(reminder?.schedule.date || '')
  const [weekdays, setWeekdays] = useState<number[]>(reminder?.schedule.weekdays || [1, 2, 3, 4, 5])
  const [offset, setOffset] = useState(String(reminder?.schedule.offsetMinutes ?? -30))
  const [mode, setMode] = useState(reminder?.target.mode || 'all')
  const [staffIds, setStaffIds] = useState<string[]>(reminder?.target.staffIds || [])
  const [bizKeys, setBizKeys] = useState<string[]>(reminder?.target.businessKeys || [])
  const [segment, setSegment] = useState(reminder?.target.segment || 'unconfirmed')
  const [requireAck, setRequireAck] = useState(reminder?.requireAck ?? t0?.requireAckDefault ?? false)
  const [smartSuppress, setSmartSuppress] = useState(reminder?.smartSuppress ?? true)
  const [escalation, setEscalation] = useState<{ afterMinutes: number; action: string }[]>(reminder?.escalation || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function pickTemplate(id: string) {
    setTemplateId(id)
    const t = templates.find(x => x.id === id)
    if (t) { setTitle(t.label); if (t.id !== 'custom') setMessage(t.defaultMessage); setChannels(t.defaultChannels); setRequireAck(t.requireAckDefault) }
  }
  const toggleWeekday = (d: number) => setWeekdays(w => w.includes(d) ? w.filter(x => x !== d) : [...w, d].sort())
  const toggleStaff = (id: string) => setStaffIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const toggleBiz = (k: string) => setBizKeys(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k])

  async function save() {
    if (!title.trim()) { setError('A title is required.'); return }
    setBusy(true); setError('')
    const t = templates.find(x => x.id === templateId)
    const payload = {
      templateId, title: title.trim(), message: message.trim(), channels,
      schedule: { kind, time, date, weekdays, offsetMinutes: Number(offset) || 0 },
      target: { mode, staffIds, businessKeys: bizKeys, routeTokens: [] as string[], segment },
      requireAck, ackOptions: t?.ackOptions || ['acknowledged', 'completed'], smartSuppress, escalation,
      active: true,
    }
    try {
      if (reminder) await api(`/api/admin/reminders/${reminder.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else await api('/api/admin/reminders', { method: 'POST', body: JSON.stringify(payload) })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed.') }
    finally { setBusy(false) }
  }

  const timeBased = kind === 'one_time' || kind === 'daily' || kind === 'weekly'

  return (
    <Sheet title={reminder ? 'Edit reminder' : 'New reminder'} onClose={onClose} footer={
      <button onClick={save} disabled={busy} className="cc-action os-tap" style={{ width: '100%', background: 'var(--red)', color: '#fff', opacity: busy ? .6 : 1 }}>{busy ? 'Saving…' : reminder ? 'Save changes' : 'Create reminder'}</button>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Template">
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {templates.map(t => {
              const on = t.id === templateId
              return <button key={t.id} type="button" onClick={() => pickTemplate(t.id)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 11, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'color-mix(in srgb, var(--red) 14%, transparent)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}><Icon name={t.icon} size={13} /> {t.label}</button>
            })}
          </div>
        </Field>

        <Field label="Title"><input value={title} onChange={e => setTitle(e.target.value)} style={osField} /></Field>
        <Field label="Message"><textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} style={{ ...osField, resize: 'vertical' }} /></Field>

        <Field label="Schedule">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {SCHEDULES.map(s => <button key={s.id} type="button" onClick={() => setKind(s.id)} className="os-tap" style={chip(kind === s.id)}>{s.label}</button>)}
          </div>
          {timeBased && <input type="time" value={time} onChange={e => setTime(e.target.value)} style={{ ...osField, marginBottom: 10 }} />}
          {kind === 'one_time' && <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...osField, marginBottom: 10 }} />}
          {kind === 'weekly' && (
            <div style={{ display: 'flex', gap: 6 }}>{DOW.map((d, i) => <button key={i} type="button" onClick={() => toggleWeekday(i)} className="os-tap" style={{ ...chip(weekdays.includes(i)), width: 40, justifyContent: 'center' }}>{d}</button>)}</div>
          )}
          {kind === 'route_relative' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" value={offset} onChange={e => setOffset(e.target.value)} style={{ ...osField, width: 110 }} />
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>minutes (negative = before route start)</span>
            </div>
          )}
          {(kind === 'route_start' || kind === 'route_end') && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Fires at each targeted route&apos;s {kind === 'route_start' ? 'start' : 'end'} time (from the route report time).</p>}
        </Field>

        <Field label="Send to">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {['all', 'segment', 'crew', 'business'].map(m => <button key={m} type="button" onClick={() => setMode(m)} className="os-tap" style={{ ...chip(mode === m), textTransform: 'capitalize' }}>{m === 'all' ? 'Entire crew' : m}</button>)}
          </div>
          {mode === 'segment' && (
            <select value={segment} onChange={e => setSegment(e.target.value)} style={osField}>
              {SEGMENTS.filter(s => s.id !== 'all').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
          {mode === 'crew' && (
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {crew.map(c => <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', background: staffIds.includes(c.id) ? 'color-mix(in srgb, var(--red) 10%, transparent)' : 'transparent' }}><input type="checkbox" checked={staffIds.includes(c.id)} onChange={() => toggleStaff(c.id)} /> <span style={{ fontSize: 14 }}>{c.name}</span></label>)}
            </div>
          )}
          {mode === 'business' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {businesses.map(b => <label key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', background: bizKeys.includes(b.key) ? 'color-mix(in srgb, var(--red) 10%, transparent)' : 'transparent' }}><input type="checkbox" checked={bizKeys.includes(b.key)} onChange={() => toggleBiz(b.key)} /> <span style={{ fontSize: 14 }}>{b.name}</span></label>)}
            </div>
          )}
        </Field>

        <Field label="Channels">
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {(['inapp', 'sms', 'email', 'push'] as ChannelId[]).map(c => <button key={c} type="button" onClick={() => setChannels(v => v.includes(c) ? v.filter(x => x !== c) : [...v, c])} className="os-tap" style={chip(channels.includes(c))}>{c === 'inapp' ? 'In-App' : c === 'sms' ? 'SMS' : c === 'email' ? 'Email' : 'Push'}</button>)}
          </div>
        </Field>

        <Row label="Require acknowledgement" hint="One-tap crew response; unacknowledged sends can escalate."><Toggle on={requireAck} onChange={setRequireAck} /></Row>
        <Row label="Smart suppression" hint="Skip anyone who already did it, is off, or whose route was cancelled."><Toggle on={smartSuppress} onChange={setSmartSuppress} /></Row>

        <Field label="Escalation">
          {escalation.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>No escalation. Add steps to re-remind or alert a manager when unacknowledged.</p>}
          {escalation.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>After</span>
              <input type="number" value={e.afterMinutes} onChange={ev => setEscalation(list => list.map((x, j) => j === i ? { ...x, afterMinutes: Number(ev.target.value) } : x))} style={{ ...osField, width: 80 }} />
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>min</span>
              <select value={e.action} onChange={ev => setEscalation(list => list.map((x, j) => j === i ? { ...x, action: ev.target.value } : x))} style={{ ...osField, flex: 1 }}>
                {ESC_ACTIONS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
              <button type="button" onClick={() => setEscalation(list => list.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          {escalation.length < 5 && <button type="button" onClick={() => setEscalation(list => [...list, { afterMinutes: (list.at(-1)?.afterMinutes || 0) + 15, action: 'resend' }])} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }}><Plus size={13} /> Add escalation step</button>}
        </Field>

        {error && <p style={{ color: '#fca5a5', fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={15} /> {error}</p>}
      </div>
    </Sheet>
  )
}

const chip = (on: boolean): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'color-mix(in srgb, var(--red) 14%, transparent)' : 'transparent', color: on ? '#fff' : 'var(--muted)' })
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><div style={{ ...osLabel, marginBottom: 8 }}>{label}</div>{children}</div> }
function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><div><div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</div></div>{children}</div>
}
