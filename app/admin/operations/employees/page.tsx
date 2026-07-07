'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserPlus, Camera, ChevronDown, Sparkles, Phone, Pencil, Trash2 } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Avatar, scoreColor, ymd, fmtDay, onActivate } from '../ui'

type Staff = { id: string; name: string; phone?: string; role?: string; photoUrl?: string; active: boolean }
type CStats = { score: number | null; assignments: number; confirmed: number; completed: number; declined: number; noResponse: number; noShow: number }
type RouteLite = { routeNumber: string; assignedStaffId?: string; businessName: string; status: string; routeDate: string; reportTime: string }

const field: React.CSSProperties = { width: '100%', padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 11, color: 'var(--text)', fontSize: 14.5, outline: 'none' }
const btnSm: React.CSSProperties = { padding: '7px 13px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }

function Hub() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [stats, setStats] = useState<Record<string, CStats>>({})
  const [routes, setRoutes] = useState<RouteLite[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState('')
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, r] = await Promise.all([
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      setStaff(s.items || []); setStats(r.stats || {}); setRoutes(r.items || [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const today = ymd(new Date())
  const workload = useMemo(() => {
    const m: Record<string, RouteLite[]> = {}
    for (const r of routes) {
      if (!r.assignedStaffId || !['assigned', 'text_sent', 'confirmed'].includes(r.status) || r.routeDate < today) continue
      ;(m[r.assignedStaffId] ||= []).push(r)
    }
    return m
  }, [routes, today])

  const active = staff.filter(s => s.active)
  const inactive = staff.filter(s => !s.active)

  return (
    <div>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>{active.length} active {active.length === 1 ? 'contractor' : 'contractors'}</p>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Your team</h1>
        </div>
        <button onClick={() => setAdding(a => !a)} className="btn os-tap" style={{ borderRadius: 999, height: 44 }}><UserPlus size={17} /> Add contractor</button>
      </div>

      {msg && <div className="os-card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13.5, color: '#fca5a5' }}>{msg}</div>}
      {adding && <EmployeeForm onDone={(m) => { setAdding(false); if (m) setMsg(m); load() }} onCancel={() => setAdding(false)} />}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 16, display: 'flex', gap: 13, alignItems: 'center' }}><div className="skeleton" style={{ width: 48, height: 48, borderRadius: 999 }} /><div style={{ flex: 1 }}><div className="skeleton" style={{ width: '40%', height: 15, borderRadius: 7 }} /><div className="skeleton" style={{ width: '25%', height: 11, borderRadius: 6, marginTop: 8 }} /></div></div>)}</div>
      ) : staff.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <p className="jkos-h" style={{ fontSize: 18 }}>No contractors yet</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>Add your crew to start assigning routes.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {active.map((s, i) => <EmployeeCard key={s.id} s={s} st={stats[s.id]} upcoming={workload[s.id] || []} open={openId === s.id} onToggle={() => setOpenId(o => o === s.id ? '' : s.id)} onOpen={() => setOpenId(s.id)} onChanged={load} setMsg={setMsg} delay={i} />)}
          {inactive.length > 0 && <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '14px 0 2px' }}>Inactive</div>}
          {inactive.map((s, i) => <EmployeeCard key={s.id} s={s} st={stats[s.id]} upcoming={workload[s.id] || []} open={openId === s.id} onToggle={() => setOpenId(o => o === s.id ? '' : s.id)} onOpen={() => setOpenId(s.id)} onChanged={load} setMsg={setMsg} delay={i} />)}
        </div>
      )}
    </div>
  )
}

function EmployeeCard({ s, st, upcoming, open, onToggle, onOpen, onChanged, setMsg, delay }: { s: Staff; st?: CStats; upcoming: RouteLite[]; open: boolean; onToggle: () => void; onOpen: () => void; onChanged: () => void; setMsg: (m: string) => void; delay: number }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const score = st?.score
  const completionPct = st && st.assignments > 0 ? Math.round((st.completed / st.assignments) * 100) : null

  async function post(patch: Record<string, unknown>) {
    setBusy(true)
    try { await fetch('/api/admin/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: s.id, name: s.name, phone: s.phone, role: s.role, photoUrl: s.photoUrl, active: s.active, ...patch }) }); onChanged() }
    finally { setBusy(false) }
  }
  async function del() { if (!confirm(`Remove ${s.name}? Past routes keep their history.`)) return; setBusy(true); try { await fetch(`/api/admin/staff?id=${s.id}`, { method: 'DELETE', credentials: 'same-origin' }); onChanged() } finally { setBusy(false) } }

  return (
    <div className="os-card os-rise" style={{ overflow: 'hidden', opacity: s.active ? 1 : .6, animationDelay: `${Math.min(delay * 40, 200)}ms` }}>
      <div onClick={onToggle} onKeyDown={onActivate(onToggle)} role="button" tabIndex={0} aria-expanded={open} className="os-tap" style={{ cursor: 'pointer', padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
        <Avatar name={s.name} photoUrl={s.photoUrl} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{s.name}</span>
            {s.role && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.role}</span>}
            {!s.active && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '1px 8px', borderRadius: 99, background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Inactive</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginTop: 4, fontSize: 12.5, color: 'var(--muted)' }}>
            <span>Reliability <b style={{ color: scoreColor(score) }}>{score == null ? 'new' : score}</b></span>
            <span>{upcoming.length} upcoming</span>
            {!s.phone && <span style={{ color: '#fca5a5', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Phone size={11} /> no phone</span>}
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onOpen(); setEditing(true) }} aria-label={`Edit ${s.name}`} className="os-tap"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>
          <Pencil size={15} />
        </button>
        <ChevronDown size={19} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .3s var(--os-ease)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>

      <div className={`os-expand${open ? ' open' : ''}`}>
        <div><div style={{ padding: '0 15px 16px' }}>
          <div style={{ height: 1, background: 'var(--line)', marginBottom: 14 }} />
          {editing ? (
            <EmployeeForm existing={s} onDone={(m) => { setEditing(false); if (m) setMsg(m); onChanged() }} onCancel={() => setEditing(false)} />
          ) : (
            <>
              {/* Record */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 8, marginBottom: 14 }}>
                <Stat n={st?.completed ?? 0} label="Completed" />
                <Stat n={st?.confirmed ?? 0} label="Confirmed" />
                <Stat n={st?.declined ?? 0} label="Declined" />
                <Stat n={st?.noShow ?? 0} label="No-show" tone={(st?.noShow ?? 0) > 0 ? '#fca5a5' : undefined} />
                <Stat n={completionPct == null ? '—' : `${completionPct}%`} label="Completion" />
              </div>

              {upcoming.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Upcoming</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {upcoming.slice(0, 6).map(r => (
                      <div key={r.routeNumber} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                        <span style={{ minWidth: 66, color: 'var(--muted)' }}>{fmtDay(r.routeDate)}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.businessName}</span>
                        <span style={{ color: 'var(--muted)' }}>{r.reportTime}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setEditing(true)} disabled={busy} style={btnSm}><Pencil size={13} /> Edit</button>
                <button onClick={() => post({ active: !s.active })} disabled={busy} style={btnSm}>{s.active ? 'Deactivate' : 'Reactivate'}</button>
                <button onClick={del} disabled={busy} style={{ ...btnSm, color: '#f87171', marginLeft: 'auto' }}><Trash2 size={13} /> Remove</button>
              </div>
            </>
          )}
        </div></div>
      </div>
    </div>
  )
}

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '8px 4px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div className="tabular-nums" style={{ fontSize: 18, fontWeight: 800, color: tone || 'var(--text)' }}>{n}</div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>{label}</div>
    </div>
  )
}

function EmployeeForm({ existing, onDone, onCancel }: { existing?: Staff; onDone: (msg?: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name || '')
  const [phone, setPhone] = useState(existing?.phone || '')
  const [role, setRole] = useState(existing?.role || '')
  const [photoUrl, setPhotoUrl] = useState(existing?.photoUrl || '')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    setUploading(true); setErr('')
    try {
      const dataUrl = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(f) })
      const up = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
      const j = await up.json().catch(() => ({}))
      if (up.ok && j.url) setPhotoUrl(j.url); else setErr(j.error || 'Photo upload failed.')
    } catch { setErr('Photo upload failed.') } finally { setUploading(false) }
  }

  async function save() {
    if (!name.trim()) { setErr('A name is required.'); return }
    setSaving(true); setErr('')
    try {
      const res = await fetch('/api/admin/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: existing?.id, name, phone, role, photoUrl, active: existing ? existing.active : true }) })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save.'); return }
      onDone(existing ? undefined : `${name.trim()} added to your team.`)
    } catch { setErr('Network error.') } finally { setSaving(false) }
  }

  const previewStaff: Staff = { id: 'x', name: name || '—', photoUrl: photoUrl || undefined, active: true }
  return (
    <div className={existing ? '' : 'os-card os-rise'} style={existing ? {} : { padding: 16, marginBottom: 16 }}>
      {!existing && <p style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 12 }}>New contractor</p>}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
        <Avatar name={previewStaff.name} photoUrl={previewStaff.photoUrl} size={56} />
        <label style={{ ...btnSm, cursor: uploading ? 'wait' : 'pointer' }}>
          <Camera size={14} /> {uploading ? 'Uploading…' : photoUrl ? 'Change photo' : 'Add photo'}
          <input type="file" accept="image/*" onChange={pickPhoto} style={{ display: 'none' }} disabled={uploading} />
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} style={field} />
        <input placeholder="Phone" value={phone} onChange={e => setPhone(e.target.value)} style={field} />
      </div>
      <input placeholder="Role (e.g. Driver, Helper)" value={role} onChange={e => setRole(e.target.value)} style={{ ...field, marginTop: 10 }} />
      {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button onClick={save} disabled={saving || uploading} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center' }}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Add contractor'}</button>
        <button onClick={onCancel} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
      </div>
    </div>
  )
}

export default function EmployeesPage() {
  return <OperationsShell><Hub /></OperationsShell>
}
