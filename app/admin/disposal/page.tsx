'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'

type Settings = {
  serviceMinimumCents: number; defaultDisposalCents: number; dumpTripCents: number
  laborMinCents: number; laborFullLoadCents: number; marginPct: number
  perTonCents: number; perCubicYardCents: number; perLoadCents: number
  category: Record<string, number>
  facility: { name?: string; address?: string; notes?: string; openDays?: string; boxTruckOk?: boolean; acceptsBrush?: boolean; acceptsFurniture?: boolean; acceptsAppliances?: boolean; acceptsDebris?: boolean; acceptsMattresses?: boolean }
  showDumpFee: boolean
}

const iStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 9, color: '#f3f4f6', fontSize: 16, outline: 'none' }
const lab: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }

const CATS: [string, string][] = [
  ['general', 'General junk'], ['furniture', 'Furniture / bulky'], ['construction-debris', 'Construction debris'],
  ['yard-waste', 'Yard waste / brush'], ['appliance', 'Appliances'], ['mattress', 'Mattresses'], ['eviction-cleanout', 'Eviction / cleanout'],
]
const MONEY_FIELDS: [keyof Settings, string][] = [
  ['serviceMinimumCents', 'Service minimum'], ['defaultDisposalCents', 'Disposal floor (fallback)'], ['dumpTripCents', 'Dump-run cost'],
  ['laborMinCents', 'Labor minimum'], ['laborFullLoadCents', 'Labor (full load)'],
  ['perTonCents', 'Per ton (ref)'], ['perCubicYardCents', 'Per cubic yard (ref)'], ['perLoadCents', 'Per load (ref)'],
]

function DisposalManager() {
  const [s, setS] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/disposal', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json(); if (j.ok) setS(j.settings)
    } catch { setErr('Failed to load') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function save(patch: Record<string, unknown>) {
    setMsg(''); setErr('')
    try {
      const res = await fetch('/api/admin/disposal', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      const j = await res.json(); if (!res.ok) throw new Error(j.error ?? 'Failed')
      setS(j.settings); setMsg('Saved.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
  }

  if (loading || !s) return <div className="max-w-2xl mx-auto"><p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p></div>
  const d = (c: number) => (c / 100).toFixed(2)

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5">
        <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Disposal &amp; Pricing</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Tune your real dump/disposal costs. These protect margin on instant junk, brush, debris & cleanout quotes — the customer never sees a scary “dump fee” unless you turn it on.</p>
      </div>

      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Cost basis &amp; margin</p>
        <div className="grid sm:grid-cols-3 gap-3">
          {MONEY_FIELDS.map(([k, label]) => (
            <div key={k}><label style={lab}>{label} ($)</label>
              <input inputMode="decimal" defaultValue={d(s[k] as number)} onBlur={e => save({ [k]: Math.round((parseFloat(e.target.value) || 0) * 100) })} style={iStyle} /></div>
          ))}
          <div><label style={lab}>Target margin (%)</label>
            <input inputMode="decimal" defaultValue={Math.round(s.marginPct * 100)} onBlur={e => save({ marginPct: (parseFloat(e.target.value) || 0) / 100 })} style={iStyle} /></div>
        </div>
      </div>

      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Disposal cost per FULL load, by type</p>
        <div className="grid sm:grid-cols-3 gap-3">
          {CATS.map(([key, label]) => (
            <div key={key}><label style={lab}>{label} ($)</label>
              <input inputMode="decimal" defaultValue={d(s.category[key] ?? 0)} onBlur={e => save({ category: { [key]: Math.round((parseFloat(e.target.value) || 0) * 100) } })} style={iStyle} /></div>
          ))}
        </div>
      </div>

      <div className="glass-card p-5" style={{ borderRadius: 16 }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Preferred facility</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <div><label style={lab}>Facility name</label><input defaultValue={s.facility.name ?? ''} onBlur={e => save({ facility: { ...s.facility, name: e.target.value } })} style={iStyle} /></div>
          <div><label style={lab}>Open days / hours</label><input defaultValue={s.facility.openDays ?? ''} onBlur={e => save({ facility: { ...s.facility, openDays: e.target.value } })} style={iStyle} /></div>
          <div className="sm:col-span-2"><label style={lab}>Address</label><input defaultValue={s.facility.address ?? ''} onBlur={e => save({ facility: { ...s.facility, address: e.target.value } })} style={iStyle} /></div>
          <div className="sm:col-span-2"><label style={lab}>Notes (restrictions, box-truck rules, etc.)</label><input defaultValue={s.facility.notes ?? ''} onBlur={e => save({ facility: { ...s.facility, notes: e.target.value } })} style={iStyle} /></div>
        </div>
        <label className="flex items-center gap-2.5 text-sm mt-4" style={{ color: 'var(--text)' }}>
          <input type="checkbox" checked={s.showDumpFee} onChange={e => save({ showDumpFee: e.target.checked })} style={{ width: 18, height: 18, accentColor: '#E0002A' }} />
          Show estimated disposal cost as a line item to customers
        </label>
      </div>

      {msg && <p className="text-sm mt-3" style={{ color: '#34d399' }}>{msg}</p>}
      {err && <p className="text-sm mt-3" role="alert" style={{ color: '#f87171' }}>{err}</p>}
    </div>
  )
}

export default function DisposalAdminPage() {
  return <AdminGate title="Disposal"><DisposalManager /></AdminGate>
}
