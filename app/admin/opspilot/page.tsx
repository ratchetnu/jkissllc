'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'
import { SkeletonList } from '../../components/Skeleton'

type Entry = {
  email: string
  company?: string
  fleetSize?: string
  source: string
  createdAt: number
}

const fmt = (ts: number) =>
  new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

function WaitlistView() {
  const [items, setItems] = useState<Entry[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/opspilot-waitlist', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setItems(j.items ?? [])
      setCount(j.count ?? (j.items ?? []).length)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function exportCsv() {
    const rows = [['Email', 'Company', 'Fleet size', 'Captured on', 'Date'],
      ...items.map(e => [e.email, e.company ?? '', e.fleetSize ?? '', e.source, new Date(e.createdAt).toISOString()])]
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'opspilot-waitlist.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Operion Waitlist</p>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Early-access requests from jkissllc.com{count > 0 ? ` · ${count} total` : ''}. Each one also emailed the owner when it came in.
          </p>
        </div>
        {items.length > 0 && (
          <button onClick={exportCsv} className="text-xs font-semibold px-3 py-2 rounded-lg shrink-0"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>Export CSV</button>
        )}
      </div>

      {err && <p className="text-sm mb-4" style={{ color: '#f87171' }}>{err}</p>}

      {loading ? (
        <SkeletonList rows={4} />
      ) : items.length === 0 ? (
        <div className="glass-card p-8 text-center" style={{ borderRadius: '16px' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No early-access requests yet. They’ll appear here the moment someone submits the Operion form.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map(e => (
            <div key={e.email} className="glass-card p-4" style={{ borderRadius: '14px' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a href={`mailto:${e.email}`} className="text-sm font-black text-white break-all" style={{ textDecoration: 'none' }}>{e.email}</a>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    {[e.company, e.fleetSize ? `${e.fleetSize} trucks` : null].filter(Boolean).join(' · ') || 'No company given'}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>{fmt(e.createdAt)}</p>
                  <span className="inline-block text-[10px] font-bold mt-1 px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(196,181,253,.12)', color: '#c4b5fd' }}>{e.source}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function OpsPilotWaitlistPage() {
  return <AdminGate title="Operion Waitlist"><WaitlistView /></AdminGate>
}
