'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'

const iStyle: React.CSSProperties = {
  padding: '11px 13px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)',
  borderRadius: '9px', color: '#f3f4f6', fontSize: '16px', outline: 'none', colorScheme: 'dark',
}
const lab: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--muted)', marginBottom: '4px' }

function fmtISO(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function AvailabilityManager() {
  const [blackout, setBlackout] = useState<string[]>([])
  const [capacity, setCapacity] = useState(2)
  const [deposit, setDeposit] = useState('50')
  const [newDate, setNewDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/availability', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setBlackout(j.blackout ?? [])
      setCapacity(j.capacity ?? 2)
      setDeposit(String((j.depositCents ?? 5000) / 100))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function save(next: { blackout?: string[]; capacity?: number; depositDollars?: number }) {
    setErr(''); setMsg('')
    try {
      const res = await fetch('/api/admin/availability', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setBlackout(j.blackout ?? []); setCapacity(j.capacity ?? 2); setDeposit(String((j.depositCents ?? 5000) / 100))
      setMsg('Saved.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
  }

  function addClosed(d: string) {
    if (!d || blackout.includes(d)) return
    save({ blackout: [...blackout, d] })
    setNewDate('')
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-5">
        <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Availability</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Control which days customers can book online, how many jobs per day, and the booking deposit.</p>
      </div>

      {loading ? <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p> : (
        <>
          <div className="glass-card p-5 mb-5" style={{ borderRadius: 16 }}>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label style={lab}>Jobs per day (capacity)</label>
                <input type="number" min={1} max={50} value={capacity} onChange={e => setCapacity(parseInt(e.target.value) || 1)} onBlur={() => save({ capacity })} style={{ ...iStyle, width: '100%' }} />
                <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.4)' }}>A day fills (and disappears from the site) once this many jobs are booked.</p>
              </div>
              <div>
                <label style={lab}>Online booking deposit ($)</label>
                <input inputMode="decimal" value={deposit} onChange={e => setDeposit(e.target.value)} onBlur={() => save({ depositDollars: parseFloat(deposit) || 0 })} style={{ ...iStyle, width: '100%' }} />
                <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.4)' }}>Charged to reserve a date. Refunded if you can&apos;t make it.</p>
              </div>
            </div>
          </div>

          <div className="glass-card p-5" style={{ borderRadius: 16 }}>
            <label style={lab}>Closed days (not bookable online)</label>
            <input type="date" value={newDate} onChange={e => addClosed(e.target.value)} style={iStyle} />
            {blackout.length > 0 ? (
              <div className="flex flex-wrap gap-2 mt-3">
                {blackout.map(d => (
                  <span key={d} className="inline-flex items-center gap-2" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.3)', color: '#fff', borderRadius: 999, padding: '6px 8px 6px 12px', fontSize: 14 }}>
                    {fmtISO(d)}
                    <button onClick={() => save({ blackout: blackout.filter(x => x !== d) })} aria-label="Remove closed day"
                      style={{ border: 'none', background: 'rgba(255,255,255,.15)', color: '#fff', width: 20, height: 20, borderRadius: 999, cursor: 'pointer', fontSize: 13, lineHeight: '20px' }}>×</button>
                  </span>
                ))}
              </div>
            ) : <p className="text-xs mt-3" style={{ color: 'rgba(255,255,255,.4)' }}>No closed days set — every open day within capacity is bookable.</p>}
          </div>

          {msg && <p className="text-sm mt-3" style={{ color: '#34d399' }}>{msg}</p>}
          {err && <p className="text-sm mt-3" role="alert" style={{ color: '#f87171' }}>{err}</p>}
        </>
      )}
    </div>
  )
}

export default function AvailabilityAdminPage() {
  return <AdminGate title="Availability"><AvailabilityManager /></AdminGate>
}
