'use client'

import { useCallback, useEffect, useState } from 'react'

type Portal = { token: string; businessName: string; label?: string }

const iStyle: React.CSSProperties = { width: '100%', padding: '9px 11px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 13.5, outline: 'none' }
const tbtn: React.CSSProperties = { padding: '5px 10px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

export default function ClientPortals({ businessNames }: { businessNames: string[] }) {
  const [items, setItems] = useState<Portal[]>([])
  const [open, setOpen] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try { const d = await fetch('/api/admin/client-portals', { credentials: 'same-origin' }).then(r => r.json()); setItems(d.items || []) } catch { /* ignore */ }
  }, [])
  useEffect(() => { load() }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault(); setCreating(true); setMsg('')
    try {
      const res = await fetch('/api/admin/client-portals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ businessName, label }) })
      const d = await res.json()
      if (!res.ok) { setMsg(d.error || 'Could not create.'); return }
      setBusinessName(''); setLabel(''); setMsg('Portal created — copy the link and send it to your client.'); load()
    } catch { setMsg('Network error.') } finally { setCreating(false) }
  }
  async function del(token: string) {
    if (!confirm('Delete this client portal link? The client can no longer view their schedule.')) return
    setBusy(token)
    try { await fetch(`/api/admin/client-portals/${token}`, { method: 'DELETE', credentials: 'same-origin' }); load() } finally { setBusy('') }
  }
  function copy(token: string) { navigator.clipboard?.writeText(`${location.origin}/client/${token}`); setMsg('Client link copied.') }

  return (
    <div className="glass-card mb-8" style={{ borderRadius: 16, padding: 20 }}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', padding: 0 }}>
        <span className="text-sm font-bold">Client portals{items.length > 0 && <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · {items.length}</span>}</span>
        <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-4">
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>A read-only link a contract client can open to see their upcoming routes and crew confirmations. No pay, no contractor details — just their schedule.</p>
          {msg && <div className="mb-3 text-sm" style={{ padding: '8px 12px', borderRadius: 9, background: 'rgba(224,35,58,.08)', border: '1px solid rgba(224,35,58,.2)', color: '#fca5a5' }}>{msg}</div>}

          {items.length > 0 && (
            <div className="flex flex-col gap-2 mb-5">
              {items.map(p => (
                <div key={p.token} className="flex items-center justify-between gap-2 flex-wrap" style={{ padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)', opacity: busy === p.token ? .6 : 1 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#e5e7eb' }}>{p.label || p.businessName}</div>
                    {p.label && <div style={{ fontSize: 12, color: 'var(--muted)' }}>matches routes for “{p.businessName}”</div>}
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => copy(p.token)} style={{ ...tbtn, color: '#86efac' }}>Copy link</button>
                    <button onClick={() => del(p.token)} disabled={busy === p.token} style={{ ...tbtn, color: '#f87171' }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={create}>
            <p className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>New client portal</p>
            <div className="grid sm:grid-cols-2 gap-2.5">
              <input required list="cp-bn" placeholder="Business / client name * (exact match)" value={businessName} onChange={e => setBusinessName(e.target.value)} style={iStyle} />
              <input placeholder="Display name (optional)" value={label} onChange={e => setLabel(e.target.value)} style={iStyle} />
            </div>
            <datalist id="cp-bn">{businessNames.map(b => <option key={b} value={b} />)}</datalist>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Must match the business name on the routes exactly (case-insensitive).</p>
            <button type="submit" disabled={creating} className="btn mt-3" style={{ justifyContent: 'center' }}>{creating ? 'Creating…' : 'Create portal link'}</button>
          </form>
        </div>
      )}
    </div>
  )
}
