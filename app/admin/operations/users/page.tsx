'use client'

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, UserPlus, KeyRound, Ban, RotateCcw, Trash2, Check } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osField as field, osLabel, Avatar, fmtTs } from '../ui'

type Role = 'admin' | 'manager' | 'crew'
type User = {
  id: string; email: string; name: string; role: Role; staffId?: string; active: boolean
  currentLoginAt?: number; previousLoginAt?: number; createdAt: number
}
type Staff = { id: string; name: string; email?: string; phone?: string; active: boolean }

const ROLE_META: Record<Role, { label: string; fg: string; bg: string }> = {
  admin: { label: 'Admin', fg: '#fca5a5', bg: 'rgba(248,113,113,.14)' },
  manager: { label: 'Manager', fg: '#93c5fd', bg: 'rgba(96,165,250,.14)' },
  crew: { label: 'Crew', fg: '#86efac', bg: 'rgba(134,239,172,.13)' },
}

function RolePill({ role }: { role: Role }) {
  const m = ROLE_META[role]
  return <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.03em', padding: '3px 9px', borderRadius: 999, color: m.fg, background: m.bg }}>{m.label}</span>
}

function TeamAccess() {
  const [users, setUsers] = useState<User[] | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [forbidden, setForbidden] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Create form
  const [mode, setMode] = useState<'admin' | 'manager' | 'crew'>('manager')
  const [fName, setFName] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fPass, setFPass] = useState('')
  const [fStaffId, setFStaffId] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users', { credentials: 'same-origin' })
      if (res.status === 403) { setForbidden(true); setUsers([]); return }
      const d = await res.json()
      setUsers(d.users ?? [])
      const s = await fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({}))
      setStaff((s.items ?? []).filter((x: Staff) => x.active))
    } catch { setUsers([]) }
  }, [])

  useEffect(() => { load() }, [load])

  // Which staff already have a login (so we don't offer to double-create).
  const staffWithLogin = new Set((users ?? []).filter(u => u.staffId).map(u => u.staffId))
  const staffNeedingLogin = staff.filter(s => !staffWithLogin.has(s.id))

  function pickStaff(id: string) {
    setFStaffId(id)
    const s = staff.find(x => x.id === id)
    if (s) { setFName(s.name); if (s.email) setFEmail(s.email) }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      const payload = mode === 'crew'
        ? { role: 'crew', name: fName, email: fEmail, password: fPass, staffId: fStaffId }
        : { role: mode, name: fName, email: fEmail, password: fPass } // 'admin' | 'manager'
      const res = await fetch('/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify(payload),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not create the account.'); return }
      setFName(''); setFEmail(''); setFPass(''); setFStaffId('')
      setSavedId(d.user.id); setTimeout(() => setSavedId(null), 2000)
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Update failed.'); return }
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  async function resetPassword(u: User) {
    const pw = window.prompt(`Set a new password for ${u.name} (min 8 characters):`)
    if (!pw) return
    await patch(u.id, { password: pw })
  }

  async function remove(u: User) {
    if (!window.confirm(`Delete ${u.name}'s login? Their crew record and history are kept.`)) return
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE', credentials: 'same-origin' })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Delete failed.'); return }
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  if (forbidden) return (
    <div className="os-card os-rise" style={{ padding: 26, textAlign: 'center' }}>
      <ShieldCheck size={26} style={{ color: 'var(--muted)' }} />
      <p className="jkos-h" style={{ fontSize: 18, marginTop: 10 }}>Admins only</p>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Team &amp; Access is restricted to administrators.</p>
    </div>
  )

  const managers = (users ?? []).filter(u => u.role !== 'crew')
  const crew = (users ?? []).filter(u => u.role === 'crew')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Team &amp; Access</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Manager and crew logins. Roles decide what each person can do — enforced on the server, not by hiding buttons.</p>
      </div>

      {err && <div className="os-card" style={{ padding: '12px 16px', color: '#fca5a5', fontSize: 14 }}>{err}</div>}

      {/* Create */}
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {(['admin', 'manager', 'crew'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} className="os-tap"
              style={{ padding: '8px 16px', borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)',
                color: mode === m ? '#fff' : 'var(--muted)', background: mode === m ? 'var(--red)' : 'transparent' }}>
              {m === 'admin' ? 'Invite admin' : m === 'manager' ? 'Invite manager' : 'Create crew login'}
            </button>
          ))}
        </div>

        <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'crew' && (
            <div>
              <label style={osLabel}>Crew member</label>
              <select value={fStaffId} onChange={e => pickStaff(e.target.value)} style={{ ...field, marginTop: 6 }} required>
                <option value="">Select a crew member…</option>
                {staffNeedingLogin.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {staffNeedingLogin.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 6 }}>Every active crew member already has a login.</p>}
            </div>
          )}
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
            <div>
              <label style={osLabel}>Name</label>
              <input value={fName} onChange={e => setFName(e.target.value)} style={{ ...field, marginTop: 6 }} placeholder="Full name" required />
            </div>
            <div>
              <label style={osLabel}>Email</label>
              <input type="email" value={fEmail} onChange={e => setFEmail(e.target.value)} style={{ ...field, marginTop: 6 }} placeholder="name@company.com" required />
            </div>
          </div>
          <div>
            <label style={osLabel}>Temporary password</label>
            <input type="text" value={fPass} onChange={e => setFPass(e.target.value)} style={{ ...field, marginTop: 6 }} placeholder="At least 8 characters" required minLength={8} />
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>Share this with them securely. They sign in at {mode === 'crew' ? 'the crew portal (/portal)' : 'the operations login'}.</p>
          </div>
          <button type="submit" disabled={busy} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46, gap: 8 }}>
            {savedId ? <><Check size={17} /> Created</> : <><UserPlus size={17} /> {mode === 'crew' ? 'Create crew login' : mode === 'admin' ? 'Invite admin' : 'Invite manager'}</>}
          </button>
        </form>
      </div>

      {/* Managers & admins */}
      <Section title="Administrators & managers" list={managers} onReset={resetPassword} onPatch={patch} onRemove={remove} allowRole />
      {/* Crew logins */}
      <Section title="Crew logins" list={crew} onReset={resetPassword} onPatch={patch} onRemove={remove} />

      {users === null && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
    </div>
  )
}

function Section({ title, list, onReset, onPatch, onRemove, allowRole }: {
  title: string; list: User[]
  onReset: (u: User) => void
  onPatch: (id: string, body: Record<string, unknown>) => void
  onRemove: (u: User) => void
  allowRole?: boolean
}) {
  if (!list.length) return null
  return (
    <div className="os-card os-rise" style={{ padding: 22 }}>
      <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 14 }}>{title}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.map(u => (
          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
            <Avatar name={u.name} size={40} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 15, opacity: u.active ? 1 : 0.5 }}>{u.name}</span>
                <RolePill role={u.role} />
                {!u.active && <span style={{ fontSize: 11, fontWeight: 700, color: '#fca5a5' }}>Suspended</span>}
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {u.email}{u.currentLoginAt ? ` · last in ${fmtTs(u.currentLoginAt)}` : ' · never signed in'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {allowRole && (
                <select value={u.role} onChange={e => onPatch(u.id, { role: e.target.value })}
                  aria-label="Role" title="Change role"
                  style={{ padding: '6px 8px', fontSize: 12, borderRadius: 8, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', cursor: 'pointer' }}>
                  <option value="admin">Admin</option>
                  <option value="manager">Manager</option>
                </select>
              )}
              <IconBtn title="Reset password" onClick={() => onReset(u)}><KeyRound size={15} /></IconBtn>
              <IconBtn title={u.active ? 'Suspend' : 'Reactivate'} onClick={() => onPatch(u.id, { active: !u.active })}>
                {u.active ? <Ban size={15} /> : <RotateCcw size={15} />}
              </IconBtn>
              <IconBtn title="Delete login" danger onClick={() => onRemove(u)}><Trash2 size={15} /></IconBtn>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function IconBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="os-tap"
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, cursor: 'pointer',
        background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: danger ? '#fca5a5' : 'var(--muted)' }}>
      {children}
    </button>
  )
}

export default function UsersPage() {
  return <OperationsShell><TeamAccess /></OperationsShell>
}
