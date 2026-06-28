'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'

type Staff = { id: string; name: string; phone?: string; role?: string; active: boolean; createdAt: number; updatedAt: number }

const iStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.10)', borderRadius: '9px', color: '#f3f4f6', fontSize: '16px', outline: 'none',
}
const lab: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--muted)', marginBottom: '4px' }

function StaffManager() {
  const [items, setItems] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/staff', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setItems(j.items ?? [])
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setSaving(true); setErr('')
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...f, active: true }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      ;(e.target as HTMLFormElement).reset()
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setSaving(false) }
  }

  async function toggle(s: Staff) {
    await fetch('/api/admin/staff', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, name: s.name, phone: s.phone, role: s.role, active: !s.active }),
    })
    await load()
  }

  async function remove(s: Staff) {
    if (!confirm(`Remove ${s.name} from the roster?`)) return
    await fetch(`/api/admin/staff?id=${encodeURIComponent(s.id)}`, { method: 'DELETE', credentials: 'same-origin' })
    await load()
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5">
        <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Crew / Staff</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Your roster. Names here appear in the booking “Assigned To” picker.</p>
      </div>

      <form onSubmit={create} className="glass-card p-5 mb-6 space-y-3" style={{ borderRadius: '16px' }}>
        <div className="grid sm:grid-cols-3 gap-3">
          <div><label style={lab}>Name *</label><input name="name" required placeholder="Marcus" style={iStyle} /></div>
          <div><label style={lab}>Phone (optional)</label><input name="phone" type="tel" placeholder="817-…" style={iStyle} /></div>
          <div><label style={lab}>Role (optional)</label><input name="role" placeholder="Driver / Lead" style={iStyle} /></div>
        </div>
        {err && <p className="text-sm" style={{ color: '#f87171' }}>{err}</p>}
        <button type="submit" disabled={saving} className="btn" style={{ padding: '11px 20px', fontSize: '14px' }}>{saving ? 'Saving…' : 'Add Crew Member'}</button>
      </form>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <div className="glass-card p-8 text-center" style={{ borderRadius: '16px' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No crew yet. Add your team above to assign them to jobs.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map(s => (
            <div key={s.id} className="glass-card p-4 flex items-center justify-between gap-3" style={{ borderRadius: '14px', opacity: s.active ? 1 : 0.5 }}>
              <div className="min-w-0">
                <p className="text-sm font-black text-white">{s.name}{s.role ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {s.role}</span> : null}</p>
                {(s.phone || !s.active) && <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{[s.phone, s.active ? '' : 'inactive'].filter(Boolean).join(' · ')}</p>}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => toggle(s)} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>{s.active ? 'Deactivate' : 'Activate'}</button>
                <button onClick={() => remove(s)} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.3)', color: '#ff6680' }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StaffAdminPage() {
  return <AdminGate title="Crew"><StaffManager /></AdminGate>
}
