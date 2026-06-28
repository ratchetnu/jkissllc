'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'
import { SkeletonList } from '../../components/Skeleton'

type Promo = {
  code: string
  type: 'percent' | 'fixed'
  value: number
  active: boolean
  description?: string
  expiresAt?: number
  maxUses?: number
  uses: number
  minSubtotalCents?: number
  createdAt: number
  updatedAt: number
}

const iStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.10)', borderRadius: '9px', color: '#f3f4f6', fontSize: '16px', outline: 'none',
}
const lab: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--muted)', marginBottom: '4px' }

function PromosManager() {
  const [items, setItems] = useState<Promo[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/promos', { credentials: 'same-origin' })
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
      const res = await fetch('/api/admin/promos', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...f, active: true }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      ;(e.target as HTMLFormElement).reset()
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setSaving(false) }
  }

  async function toggle(p: Promo) {
    await fetch('/api/admin/promos', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: p.code, type: p.type, value: p.value, active: !p.active }),
    })
    await load()
  }

  async function remove(p: Promo) {
    if (!confirm(`Delete code ${p.code}?`)) return
    await fetch(`/api/admin/promos?code=${encodeURIComponent(p.code)}`, { method: 'DELETE', credentials: 'same-origin' })
    await load()
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5">
        <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Promo Codes</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Discounts customers can apply to their invoice at checkout.</p>
      </div>

      <form onSubmit={create} className="glass-card p-5 mb-6 space-y-3" style={{ borderRadius: '16px' }}>
        <div className="grid sm:grid-cols-2 gap-3">
          <div><label style={lab}>Code *</label><input name="code" required placeholder="SUMMER20" style={iStyle} /></div>
          <div><label style={lab}>Type</label><select name="type" defaultValue="percent" style={{ ...iStyle, cursor: 'pointer' }}><option value="percent">% off</option><option value="fixed">$ off</option></select></div>
          <div><label style={lab}>Value *</label><input name="value" inputMode="decimal" required placeholder="20" style={iStyle} /></div>
          <div><label style={lab}>Max Uses (optional)</label><input name="maxUses" inputMode="numeric" placeholder="unlimited" style={iStyle} /></div>
          <div><label style={lab}>Min Invoice $ (optional)</label><input name="minSubtotal" inputMode="decimal" placeholder="none" style={iStyle} /></div>
          <div><label style={lab}>Label (optional)</label><input name="description" placeholder="Summer promo" style={iStyle} /></div>
        </div>
        {err && <p className="text-sm" style={{ color: '#f87171' }}>{err}</p>}
        <button type="submit" disabled={saving} className="btn" style={{ padding: '11px 20px', fontSize: '14px' }}>{saving ? 'Saving…' : 'Add Code'}</button>
      </form>

      {loading ? (
        <SkeletonList rows={3} />
      ) : items.length === 0 ? (
        <div className="glass-card p-8 text-center" style={{ borderRadius: '16px' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No promo codes yet. Add one above — customers enter it on their booking page.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map(p => (
            <div key={p.code} className="glass-card p-4 flex items-center justify-between gap-3" style={{ borderRadius: '14px', opacity: p.active ? 1 : 0.5 }}>
              <div className="min-w-0">
                <p className="text-sm font-black text-white">
                  <span className="font-mono">{p.code}</span> · {p.type === 'percent' ? `${p.value}% off` : `$${p.value} off`}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                  {p.description ? `${p.description} · ` : ''}{p.uses} used{p.maxUses ? ` / ${p.maxUses}` : ''}{p.minSubtotalCents ? ` · min $${Math.round(p.minSubtotalCents / 100)}` : ''}{p.active ? '' : ' · inactive'}
                </p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => toggle(p)} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>
                  {p.active ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => remove(p)} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.3)', color: '#ff6680' }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PromosAdminPage() {
  return <AdminGate title="Promo Codes"><PromosManager /></AdminGate>
}
