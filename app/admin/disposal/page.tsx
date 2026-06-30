'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'

type Settings = {
  serviceMinimumCents: number; defaultDisposalCents: number; marginPct: number
  minDisposalFeePerTripCents: number; truckCapacityCuFt: number
  laborMinCents: number; laborFullLoadCents: number; laborRatePerHourCents: number
  landfillRoundTripMinutes: number; unloadMinutesPerTrip: number
  dumpTripCents: number; equipmentOpPerLoadCents: number; travelToJobCents: number
  perTonCents: number; perCubicYardCents: number; perLoadCents: number
  category: Record<string, number>
  bulkFactor: Record<string, number>
  facility: { name?: string; address?: string; notes?: string; openDays?: string; boxTruckOk?: boolean; acceptsBrush?: boolean; acceptsFurniture?: boolean; acceptsAppliances?: boolean; acceptsDebris?: boolean; acceptsMattresses?: boolean }
  showDumpFee: boolean
}

type Calibration = { fillBias: Record<string, number>; samples: Record<string, number>; updatedAt: string }
type Outcome = {
  id: string; date: string; category: string
  estFillPct: number; actualFillPct: number; estTrips: number; actualTrips: number
  actualDisposalCents: number; actualProfitCents: number; finalPriceCents: number
}
type Stats = { jobs: number; fillMape: number; tripMape: number; disposalMape: number; avgProfitCents: number; underpriced: number } | null

const iStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 9, color: '#f3f4f6', fontSize: 16, outline: 'none' }
const lab: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }
const cardHdr: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 12 }

const CATS: [string, string][] = [
  ['general', 'General junk'], ['furniture', 'Furniture / bulky'], ['construction-debris', 'Construction debris'],
  ['yard-waste', 'Yard waste / brush'], ['appliance', 'Appliances'], ['mattress', 'Mattresses'], ['eviction-cleanout', 'Eviction / cleanout'],
]
// Money fields, grouped by card.
const MARGIN_FIELDS: [keyof Settings, string][] = [
  ['serviceMinimumCents', 'Service minimum'], ['minDisposalFeePerTripCents', 'Disposal fee / landfill trip'],
  ['defaultDisposalCents', 'Disposal floor (fallback)'],
]
const COST_FIELDS: [keyof Settings, string][] = [
  ['laborMinCents', 'On-site labor minimum'], ['laborFullLoadCents', 'On-site labor (full load)'],
  ['laborRatePerHourCents', 'Crew labor rate ($/hr)'], ['dumpTripCents', 'Dump-trip fuel/tolls (per trip)'],
  ['equipmentOpPerLoadCents', 'Equipment operating (per load)'], ['travelToJobCents', 'Travel to job (default)'],
]
const REF_FIELDS: [keyof Settings, string][] = [
  ['perTonCents', 'Per ton (ref)'], ['perCubicYardCents', 'Per cubic yard (ref)'], ['perLoadCents', 'Per load (ref)'],
]

function MoneyInput({ k, label, s, save }: { k: keyof Settings; label: string; s: Settings; save: (p: Record<string, unknown>) => void }) {
  return (
    <div><label style={lab}>{label} ($)</label>
      <input inputMode="decimal" defaultValue={((s[k] as number) / 100).toFixed(2)} onBlur={e => save({ [k]: Math.round((parseFloat(e.target.value) || 0) * 100) })} style={iStyle} /></div>
  )
}

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

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5">
        <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Disposal &amp; Pricing</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>The estimator prices by <strong>truck utilization</strong>: fill % → loads → landfill trips → disposal. Disposal is charged <strong>every</strong> trip — never a single dump fee on oversized jobs. Tune these to your real DFW costs.</p>
      </div>

      {/* Per-trip disposal + margin */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p style={cardHdr}>Per-trip disposal &amp; margin</p>
        <div className="grid sm:grid-cols-3 gap-3">
          {MARGIN_FIELDS.map(([k, label]) => <MoneyInput key={k} k={k} label={label} s={s} save={save} />)}
          <div><label style={lab}>Target margin (%)</label>
            <input inputMode="decimal" defaultValue={Math.round(s.marginPct * 100)} onBlur={e => save({ marginPct: (parseFloat(e.target.value) || 0) / 100 })} style={iStyle} /></div>
          <div><label style={lab}>Truck capacity (cu ft)</label>
            <input inputMode="decimal" defaultValue={s.truckCapacityCuFt} onBlur={e => save({ truckCapacityCuFt: Math.round(parseFloat(e.target.value) || 0) })} style={iStyle} /></div>
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Disposal = (landfill trips × fee/trip). 2 trips = 2× the fee. The quote is never generated below the resulting minimum selling price.</p>
      </div>

      {/* Itemized job costs */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p style={cardHdr}>Itemized job costs</p>
        <div className="grid sm:grid-cols-3 gap-3">
          {COST_FIELDS.map(([k, label]) => <MoneyInput key={k} k={k} label={label} s={s} save={save} />)}
          <div><label style={lab}>Landfill round-trip (min)</label>
            <input inputMode="decimal" defaultValue={s.landfillRoundTripMinutes} onBlur={e => save({ landfillRoundTripMinutes: Math.round(parseFloat(e.target.value) || 0) })} style={iStyle} /></div>
          <div><label style={lab}>Unload time / trip (min)</label>
            <input inputMode="decimal" defaultValue={s.unloadMinutesPerTrip} onBlur={e => save({ unloadMinutesPerTrip: Math.round(parseFloat(e.target.value) || 0) })} style={iStyle} /></div>
        </div>
      </div>

      {/* Disposal cost per full load by type */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p style={cardHdr}>Disposal cost per FULL load, by type (weight floor)</p>
        <div className="grid sm:grid-cols-3 gap-3">
          {CATS.map(([key, label]) => (
            <div key={key}><label style={lab}>{label} ($)</label>
              <input inputMode="decimal" defaultValue={((s.category[key] ?? 0) / 100).toFixed(2)} onBlur={e => save({ category: { [key]: Math.round((parseFloat(e.target.value) || 0) * 100) } })} style={iStyle} /></div>
          ))}
        </div>
      </div>

      {/* Bulk / compaction factor */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p style={cardHdr}>Bulk factor — how fast each type fills the truck</p>
        <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>&gt;1 = poor compaction (burns volume fast → more trips). Brush is 1.8 from a real underpriced job; dense debris that compacts is &lt;1.</p>
        <div className="grid sm:grid-cols-3 gap-3">
          {CATS.map(([key, label]) => (
            <div key={key}><label style={lab}>{label} (×)</label>
              <input inputMode="decimal" defaultValue={(s.bulkFactor[key] ?? 1).toString()} onBlur={e => save({ bulkFactor: { [key]: Math.min(5, Math.max(0.1, parseFloat(e.target.value) || 1)) } })} style={iStyle} /></div>
          ))}
        </div>
      </div>

      {/* Reference rates + facility */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p style={cardHdr}>Reference rates</p>
        <div className="grid sm:grid-cols-3 gap-3">{REF_FIELDS.map(([k, label]) => <MoneyInput key={k} k={k} label={label} s={s} save={save} />)}</div>
      </div>

      <div className="glass-card p-5 mb-4" style={{ borderRadius: 16 }}>
        <p style={cardHdr}>Preferred facility</p>
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

      <LearningPanel cats={CATS} />
    </div>
  )
}

// ── Self-learning: log a completed job's actuals, watch accuracy improve ───────
function LearningPanel({ cats }: { cats: [string, string][] }) {
  const [calib, setCalib] = useState<Calibration | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [stats, setStats] = useState<Stats>(null)
  const [form, setForm] = useState<Record<string, string>>({ category: 'yard-waste' })
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/disposal/outcomes', { credentials: 'same-origin' })
      if (!res.ok) return
      const j = await res.json(); if (j.ok) { setCalib(j.calibration); setOutcomes(j.outcomes ?? []); setStats(j.stats) }
    } catch { /* soft */ }
  }, [])
  useEffect(() => { load() }, [load])

  async function submit() {
    setMsg(''); setErr('')
    try {
      const res = await fetch('/api/admin/disposal/outcomes', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, now: Date.now() }),
      })
      const j = await res.json(); if (!res.ok) throw new Error(j.error ?? 'Failed')
      setCalib(j.calibration); setOutcomes(j.outcomes ?? []); setStats(j.stats)
      setForm({ category: form.category }); setMsg('Logged. Calibration updated.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
  }

  const f = (k: string) => form[k] ?? ''
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  const NUMS: [string, string][] = [
    ['estFillPct', 'Est. fill %'], ['actualFillPct', 'Actual fill %'],
    ['estTrips', 'Est. trips'], ['actualTrips', 'Actual trips'],
    ['estDisposal', 'Est. disposal $'], ['actualDisposal', 'Actual disposal $'],
    ['estLabor', 'Est. labor $'], ['actualLabor', 'Actual labor $'],
    ['estProfit', 'Est. profit $'], ['actualProfit', 'Actual profit $'],
    ['finalPrice', 'Final price $'],
  ]

  return (
    <div className="glass-card p-5 mt-6" style={{ borderRadius: 16 }}>
      <p style={cardHdr}>Self-learning — log completed jobs</p>
      <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>After each job, record what actually happened. The estimator learns each type&apos;s true truck-fill bias and gets more accurate over time.</p>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[['Jobs logged', String(stats.jobs)], ['Fill error', `${stats.fillMape}%`], ['Trip error', `${stats.tripMape}%`], ['Avg profit', `$${Math.round(stats.avgProfitCents / 100)}`]].map(([l, v]) => (
            <div key={l} style={{ background: 'rgba(255,255,255,.04)', borderRadius: 10, padding: '10px 12px' }}>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{l}</p>
              <p className="text-lg font-bold text-white">{v}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-3">
        <div><label style={lab}>Type</label>
          <select value={f('category')} onChange={e => set('category', e.target.value)} style={iStyle}>
            {cats.map(([k, label]) => <option key={k} value={k} style={{ color: '#111' }}>{label}</option>)}
          </select></div>
        <div><label style={lab}>Date</label><input type="date" value={f('date')} onChange={e => set('date', e.target.value)} style={iStyle} /></div>
        <div />
        {NUMS.map(([k, label]) => (
          <div key={k}><label style={lab}>{label}</label>
            <input inputMode="decimal" value={f(k)} onChange={e => set(k, e.target.value)} style={iStyle} /></div>
        ))}
      </div>
      <button onClick={submit} className="mt-4 px-5 py-2.5 rounded-lg font-bold text-white text-sm" style={{ background: '#E0002A' }}>Log completed job</button>
      {msg && <p className="text-sm mt-3" style={{ color: '#34d399' }}>{msg}</p>}
      {err && <p className="text-sm mt-3" role="alert" style={{ color: '#f87171' }}>{err}</p>}

      {calib && Object.keys(calib.fillBias).length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>Learned fill bias (actual ÷ est.)</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(calib.fillBias).map(([k, v]) => (
              <span key={k} className="text-xs px-2.5 py-1 rounded-full" style={{ background: 'rgba(224,0,42,.12)', color: '#f3f4f6' }}>
                {k.replace(/-/g, ' ')}: ×{Number(v).toFixed(2)} <span style={{ color: 'var(--muted)' }}>({calib.samples?.[k] ?? 0})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {outcomes.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
              {['Date', 'Type', 'Fill e→a', 'Trips e→a', 'Disposal', 'Profit', 'Price'].map(h => <th key={h} className="py-2 pr-3 font-semibold">{h}</th>)}
            </tr></thead>
            <tbody>
              {outcomes.slice(0, 12).map((o, i) => (
                <tr key={o.id + i} style={{ borderTop: '1px solid rgba(255,255,255,.06)', color: '#e5e7eb' }}>
                  <td className="py-2 pr-3">{o.date}</td>
                  <td className="py-2 pr-3">{o.category.replace(/-/g, ' ')}</td>
                  <td className="py-2 pr-3">{o.estFillPct}%→{o.actualFillPct}%</td>
                  <td className="py-2 pr-3">{o.estTrips}→{o.actualTrips}</td>
                  <td className="py-2 pr-3">${Math.round(o.actualDisposalCents / 100)}</td>
                  <td className="py-2 pr-3" style={{ color: o.actualProfitCents < 0 ? '#f87171' : '#34d399' }}>${Math.round(o.actualProfitCents / 100)}</td>
                  <td className="py-2 pr-3">${Math.round(o.finalPriceCents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function DisposalAdminPage() {
  return <AdminGate title="Disposal"><DisposalManager /></AdminGate>
}
