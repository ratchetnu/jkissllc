'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Truck, Plus, Pencil, Trash2, ChevronDown, Wrench, User } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { onActivate, osLabel } from '../ui'

type Ownership = 'company' | 'contractor'
type Equipment = {
  id: string; name: string; truckType?: string; ownership: Ownership
  contractorName?: string; notes?: string; active: boolean
}
type Staff = { id: string; name: string; active: boolean }

const field: React.CSSProperties = { width: '100%', padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 11, color: 'var(--text)', fontSize: 14.5, outline: 'none' }
const btnSm: React.CSSProperties = { padding: '7px 13px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }
const pill = (on: boolean): React.CSSProperties => ({ padding: '9px 18px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' })

function Hub() {
  const [items, setItems] = useState<Equipment[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState('')
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [e, s] = await Promise.all([
        fetch('/api/admin/equipment', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()).catch(() => ({})),
      ])
      setItems(e.items || []); setStaff(s.items || [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const active = items.filter(e => e.active)
  const inactive = items.filter(e => !e.active)
  const crewNames = useMemo(() => staff.filter(s => s.active).map(s => s.name).sort(), [staff])

  return (
    <div>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>{active.length} in service</p>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Equipment</h1>
        </div>
        <button onClick={() => setAdding(a => !a)} className="btn os-tap" style={{ borderRadius: 999, height: 44 }}><Plus size={17} /> Add equipment</button>
      </div>

      {msg && <div className="os-card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13.5, color: '#86efac' }}>{msg}</div>}
      {adding && <EquipmentForm crewNames={crewNames} onDone={(m) => { setAdding(false); if (m) setMsg(m); load() }} onCancel={() => setAdding(false)} />}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 16, display: 'flex', gap: 13, alignItems: 'center' }}><div className="skeleton" style={{ width: 44, height: 44, borderRadius: 12 }} /><div style={{ flex: 1 }}><div className="skeleton" style={{ width: '45%', height: 15, borderRadius: 7 }} /><div className="skeleton" style={{ width: '30%', height: 11, borderRadius: 6, marginTop: 8 }} /></div></div>)}</div>
      ) : items.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <Truck size={26} style={{ color: 'var(--muted)', margin: '0 auto 10px' }} />
          <p className="jkos-h" style={{ fontSize: 18 }}>No equipment yet</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>Add the trucks and gear you run — company-owned or a contractor&rsquo;s.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {active.map((e, i) => <EquipmentCard key={e.id} e={e} crewNames={crewNames} open={openId === e.id} onToggle={() => setOpenId(o => o === e.id ? '' : e.id)} onOpen={() => setOpenId(e.id)} onChanged={load} setMsg={setMsg} delay={i} />)}
          {inactive.length > 0 && <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '14px 0 2px' }}>Out of service</div>}
          {inactive.map((e, i) => <EquipmentCard key={e.id} e={e} crewNames={crewNames} open={openId === e.id} onToggle={() => setOpenId(o => o === e.id ? '' : e.id)} onOpen={() => setOpenId(e.id)} onChanged={load} setMsg={setMsg} delay={i} />)}
        </div>
      )}
    </div>
  )
}

function OwnerBadge({ e }: { e: Equipment }) {
  const contractor = e.ownership === 'contractor'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 99, background: contractor ? 'rgba(255,255,255,.08)' : 'rgba(224,0,42,.16)', color: contractor ? 'var(--muted)' : '#fff' }}>
      {contractor ? <><User size={11} /> Contractor{e.contractorName ? ` · ${e.contractorName}` : ''}</> : 'Company'}
    </span>
  )
}

function EquipmentCard({ e, crewNames, open, onToggle, onOpen, onChanged, setMsg, delay }: { e: Equipment; crewNames: string[]; open: boolean; onToggle: () => void; onOpen: () => void; onChanged: () => void; setMsg: (m: string) => void; delay: number }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  async function post(patch: Record<string, unknown>) {
    setBusy(true)
    try { await fetch('/api/admin/equipment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: e.id, name: e.name, truckType: e.truckType, ownership: e.ownership, contractorName: e.contractorName, notes: e.notes, active: e.active, ...patch }) }); onChanged() }
    finally { setBusy(false) }
  }
  async function del() { if (!confirm(`Remove ${e.name}?`)) return; setBusy(true); try { await fetch(`/api/admin/equipment?id=${e.id}`, { method: 'DELETE', credentials: 'same-origin' }); onChanged() } finally { setBusy(false) } }

  return (
    <div className="os-card os-rise" style={{ overflow: 'hidden', opacity: e.active ? 1 : .6, animationDelay: `${Math.min(delay * 40, 200)}ms` }}>
      <div onClick={onToggle} onKeyDown={onActivate(onToggle)} role="button" tabIndex={0} aria-expanded={open} className="os-tap" style={{ cursor: 'pointer', padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(224,0,42,.12)', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--red-glow)' }}><Truck size={21} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            <OwnerBadge e={e} />
            {!e.active && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '1px 8px', borderRadius: 99, background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Out of service</span>}
          </div>
          {e.truckType && <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.truckType}</div>}
        </div>
        <button onClick={ev => { ev.stopPropagation(); onOpen(); setEditing(true) }} aria-label={`Edit ${e.name}`} className="os-tap"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>
          <Pencil size={15} />
        </button>
        <ChevronDown size={19} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .3s var(--os-ease)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>

      <div className={`os-expand${open ? ' open' : ''}`}>
        <div><div style={{ padding: '0 15px 16px' }}>
          <div style={{ height: 1, background: 'var(--line)', marginBottom: 14 }} />
          {editing ? (
            <EquipmentForm existing={e} crewNames={crewNames} onDone={(m) => { setEditing(false); if (m) setMsg(m); onChanged() }} onCancel={() => setEditing(false)} />
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
                <Row label="Truck type" value={e.truckType || '—'} />
                <Row label="Ownership" value={e.ownership === 'contractor' ? `Contractor${e.contractorName ? ` — ${e.contractorName}` : ''}` : 'Company-owned'} />
                {e.notes && <Row label="Notes" value={e.notes} />}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setEditing(true)} disabled={busy} style={btnSm}><Pencil size={13} /> Edit</button>
                <button onClick={() => post({ active: !e.active })} disabled={busy} style={btnSm}>{e.active ? 'Mark out of service' : 'Return to service'}</button>
                <button onClick={del} disabled={busy} style={{ ...btnSm, color: '#f87171', marginLeft: 'auto' }}><Trash2 size={13} /> Remove</button>
              </div>
            </>
          )}
        </div></div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 13.5 }}>
      <span style={{ ...osLabel, minWidth: 92, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

function EquipmentForm({ existing, crewNames, onDone, onCancel }: { existing?: Equipment; crewNames: string[]; onDone: (msg?: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name || '')
  const [truckType, setTruckType] = useState(existing?.truckType || '')
  const [ownership, setOwnership] = useState<Ownership>(existing?.ownership || 'company')
  const [contractorName, setContractorName] = useState(existing?.contractorName || '')
  const [notes, setNotes] = useState(existing?.notes || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    if (!name.trim()) { setErr('Give the equipment a name.'); return }
    setSaving(true); setErr('')
    try {
      const res = await fetch('/api/admin/equipment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({
          id: existing?.id, name, truckType, ownership,
          contractorName: ownership === 'contractor' ? contractorName : '',
          notes, active: existing ? existing.active : true,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save.'); return }
      onDone(existing ? undefined : `${name.trim()} added to your equipment.`)
    } catch { setErr('Network error.') } finally { setSaving(false) }
  }

  return (
    <div className={existing ? '' : 'os-card os-rise'} style={existing ? {} : { padding: 16, marginBottom: 16 }}>
      {!existing && <p style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 12 }}>New equipment</p>}

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>What equipment?</div>
        <input autoFocus placeholder="e.g. 26ft Box Truck #1, Appliance Dolly" value={name} onChange={e => setName(e.target.value)} style={field} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}><Wrench size={12} /> Truck type</div>
        <input placeholder="e.g. 26ft box truck w/ liftgate, F-350 dually" value={truckType} onChange={e => setTruckType(e.target.value)} style={field} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>Whose equipment?</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setOwnership('company')} style={pill(ownership === 'company')}>Company</button>
          <button type="button" onClick={() => setOwnership('contractor')} style={pill(ownership === 'contractor')}>Contractor&rsquo;s</button>
        </div>
        {ownership === 'contractor' && (
          <div style={{ marginTop: 10 }}>
            <input list="equip-crew" placeholder="Whose is it? (contractor name — optional)" value={contractorName} onChange={e => setContractorName(e.target.value)} style={field} />
            <datalist id="equip-crew">{crewNames.map(n => <option key={n} value={n} />)}</datalist>
          </div>
        )}
      </div>

      <textarea placeholder="Notes (plate #, capacity, condition…)" value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...field, resize: 'vertical' }} />

      {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button onClick={save} disabled={saving} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center' }}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Add equipment'}</button>
        <button onClick={onCancel} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
      </div>
    </div>
  )
}

export default function EquipmentPage() {
  return <OperationsShell><Hub /></OperationsShell>
}
