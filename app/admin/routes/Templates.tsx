'use client'

import { useCallback, useEffect, useState } from 'react'

type Staff = { id: string; name: string; phone?: string; active: boolean }
type Template = {
  id: string; label: string; businessName: string; reportAddress: string; reportTime: string
  contactPerson?: string; contactPhone?: string; vehicle?: string; payRate?: string
  description?: string; specialNotes?: string; weekdays: number[]
  defaultStaffId?: string; autoNotify: boolean; active: boolean
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const iStyle: React.CSSProperties = { width: '100%', padding: '9px 11px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 13.5, outline: 'none' }
const tbtn: React.CSSProperties = { padding: '5px 10px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

export default function Templates({ staff, onGenerated }: { staff: Staff[]; onGenerated: () => void }) {
  const [items, setItems] = useState<Template[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const blank = { label: '', businessName: '', reportAddress: '', reportTime: '', contactPerson: '', contactPhone: '', vehicle: 'Box truck', payRate: '', description: '', specialNotes: '', defaultStaffId: '', autoNotify: false, weekdays: [] as number[] }
  const [form, setForm] = useState(blank)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try { const d = await fetch('/api/admin/route-templates', { credentials: 'same-origin' }).then(r => r.json()); setItems(d.items || []) } catch { /* ignore */ }
  }, [])
  useEffect(() => { load() }, [load])

  const toggleDay = (n: number) => setForm(f => ({ ...f, weekdays: f.weekdays.includes(n) ? f.weekdays.filter(x => x !== n) : [...f.weekdays, n].sort() }))
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function create(e: React.FormEvent) {
    e.preventDefault(); setCreating(true); setMsg('')
    try {
      const res = await fetch('/api/admin/route-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(form) })
      const d = await res.json()
      if (!res.ok) { setMsg(d.error || 'Could not save.'); return }
      setForm(blank); setMsg('Template saved.'); load()
    } catch { setMsg('Network error.') } finally { setCreating(false) }
  }
  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id); setMsg('')
    try {
      const res = await fetch(`/api/admin/route-templates/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      const d = await res.json()
      if (!res.ok) setMsg(d.error || 'Action failed.')
      else if (body.action === 'generate') { setMsg(d.created?.length ? `Generated ${d.created.length} route(s) — see the list.` : 'Nothing to generate — upcoming dates already exist.'); onGenerated() }
      load()
    } catch { setMsg('Network error.') } finally { setBusy('') }
  }
  async function del(id: string) {
    if (!confirm('Delete this template? Routes already generated from it stay.')) return
    setBusy(id)
    try { await fetch(`/api/admin/route-templates/${id}`, { method: 'DELETE', credentials: 'same-origin' }); load() } finally { setBusy('') }
  }

  return (
    <div className="glass-card mb-8" style={{ borderRadius: 16, padding: 20 }}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', padding: 0 }}>
        <span className="text-sm font-bold">Recurring templates{items.length > 0 && <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · {items.length}</span>}</span>
        <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-4">
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>Standing contracts. Active templates auto-generate their routes 14 days out each morning; you can also generate on demand.</p>
          {msg && <div className="mb-3 text-sm" style={{ padding: '8px 12px', borderRadius: 9, background: 'rgba(224,35,58,.08)', border: '1px solid rgba(224,35,58,.2)', color: '#fca5a5' }}>{msg}</div>}

          {items.length > 0 && (
            <div className="flex flex-col gap-2 mb-5">
              {items.map(t => (
                <div key={t.id} style={{ padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)', opacity: busy === t.id ? .6 : 1 }}>
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div>
                      <div style={{ fontWeight: 700, color: '#e5e7eb' }}>{t.label}{!t.active && <span style={{ fontSize: 11, color: '#fca5a5', fontWeight: 600 }}> · paused</span>}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t.businessName} · {t.reportTime} · {t.weekdays.map(d => DOW[d]).join('/')}</div>
                      {t.defaultStaffId && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Auto-assign: {staff.find(s => s.id === t.defaultStaffId)?.name || '—'}{t.autoNotify ? ' · texts on generate' : ''}</div>}
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      <button onClick={() => act(t.id, { action: 'generate', horizonDays: 14 })} disabled={busy === t.id} style={{ ...tbtn, color: '#86efac' }}>Generate 14d</button>
                      <button onClick={() => act(t.id, { action: 'toggle' })} disabled={busy === t.id} style={tbtn}>{t.active ? 'Pause' : 'Resume'}</button>
                      <button onClick={() => del(t.id)} disabled={busy === t.id} style={{ ...tbtn, color: '#f87171' }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={create}>
            <p className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>New template</p>
            <div className="grid sm:grid-cols-2 gap-2.5">
              <input required placeholder="Template name * (e.g. Acme M/W/F)" value={form.label} onChange={set('label')} style={iStyle} />
              <input required placeholder="Business / client *" value={form.businessName} onChange={set('businessName')} style={iStyle} />
              <input required placeholder="Report address *" value={form.reportAddress} onChange={set('reportAddress')} style={iStyle} />
              <input required placeholder="Report time * (e.g. 7:00 AM)" value={form.reportTime} onChange={set('reportTime')} style={iStyle} />
              <input placeholder="Vehicle / equipment" value={form.vehicle} onChange={set('vehicle')} style={iStyle} />
              <input placeholder="Pay / rate" value={form.payRate} onChange={set('payRate')} style={iStyle} />
              <input placeholder="On-site contact" value={form.contactPerson} onChange={set('contactPerson')} style={iStyle} />
              <input placeholder="On-site phone" value={form.contactPhone} onChange={set('contactPhone')} style={iStyle} />
            </div>
            <textarea placeholder="Route instructions" value={form.description} onChange={set('description')} rows={2} style={{ ...iStyle, marginTop: 10, resize: 'vertical' }} />

            <div className="mt-3">
              <label className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Runs on *</label>
              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                {DOW.map((d, i) => (
                  <button type="button" key={i} onClick={() => toggleDay(i)}
                    style={{ padding: '6px 11px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', background: form.weekdays.includes(i) ? 'var(--red)' : 'rgba(255,255,255,.05)', color: form.weekdays.includes(i) ? '#fff' : 'var(--muted)' }}>{d}</button>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-2.5 mt-3 items-end">
              <div>
                <label className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Default contractor (optional)</label>
                <select value={form.defaultStaffId} onChange={set('defaultStaffId')} style={{ ...iStyle, cursor: 'pointer', marginTop: 4 }}>
                  <option value="">— None (generate as draft) —</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.phone ? '' : ' (no phone)'}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)', paddingBottom: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.autoNotify} onChange={e => setForm(f => ({ ...f, autoNotify: e.target.checked }))} style={{ width: 16, height: 16, accentColor: 'var(--red)' }} />
                Text the contractor when a route is generated
              </label>
            </div>
            <button type="submit" disabled={creating} className="btn mt-3" style={{ justifyContent: 'center' }}>{creating ? 'Saving…' : 'Save template'}</button>
          </form>
        </div>
      )}
    </div>
  )
}
