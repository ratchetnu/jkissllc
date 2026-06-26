'use client'

import { useState, useEffect, useCallback } from 'react'
import { useIdleLogout } from './useIdleLogout'

type Range = '7d' | '30d' | '90d'
type Tab = 'analytics' | 'shipments'

interface DayData { date: string; pageviews: number; visitors: number }
interface RowData { key: string; total: number }
interface AnalyticsData {
  totalPageviews: number
  totalVisitors: number
  rangePageviews: number
  rangeVisitors: number
  paths: RowData[]
  referrers: RowData[]
  daily: DayData[]
  range: string
}

type ShipmentStatus = 'created' | 'dispatched' | 'out-for-delivery' | 'delivered'
interface Shipment {
  bol: string
  status: ShipmentStatus
  customerName?: string
  pickupCity?: string
  deliveryCity?: string
  notes?: string
  createdAt: number
  updatedAt: number
  dispatchedAt?: number
  deliveredAt?: number
}

const SHIPMENT_STATUSES: ShipmentStatus[] = ['created', 'dispatched', 'out-for-delivery', 'delivered']
const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  'created': 'Scheduled',
  'dispatched': 'On The Way',
  'out-for-delivery': 'Crew On Site',
  'delivered': 'Complete',
}

export const iStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)',
  borderRadius: '10px', color: '#f3f4f6', fontSize: '14px', outline: 'none',
}

function MiniBar({ data, field }: { data: DayData[]; field: 'pageviews' | 'visitors' }) {
  const max = Math.max(...data.map(d => d[field]), 1)
  return (
    <div className="flex items-end gap-0.5 h-16 w-full">
      {data.map(d => (
        <div key={d.date} className="flex-1 rounded-sm transition-all"
          style={{ height: `${(d[field] / max) * 100}%`, background: 'var(--red)', opacity: 0.7, minHeight: '2px' }}
          title={`${d.date}: ${d[field]}`} />
      ))}
    </div>
  )
}

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  const [tab, setTab] = useState<Tab>('analytics')
  const [range, setRange] = useState<Range>('30d')
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ── Shipments state ─────────────────────────────────────────────────────────
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [shipmentsLoading, setShipmentsLoading] = useState(false)
  const [shipmentsError, setShipmentsError] = useState('')
  const [editingBol, setEditingBol] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)

  const fetchShipments = useCallback(async () => {
    setShipmentsLoading(true)
    setShipmentsError('')
    try {
      const res = await fetch('/api/admin/shipments', { credentials: 'same-origin' })
      if (res.status === 401) { setAuthed(false); return }
      const j = await res.json()
      if (j.error) throw new Error(j.error)
      setShipments(j.items || [])
    } catch (e) {
      setShipmentsError(e instanceof Error ? e.message : 'Error loading shipments')
    } finally {
      setShipmentsLoading(false)
    }
  }, [])

  async function saveShipment(s: Partial<Shipment>) {
    const res = await fetch('/api/admin/shipments', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error ?? 'Save failed')
    await fetchShipments()
    setEditingBol(null)
    setShowNewForm(false)
  }

  async function removeShipment(bol: string) {
    if (!confirm(`Delete shipment ${bol}? This can't be undone.`)) return
    const res = await fetch(`/api/admin/shipments?bol=${encodeURIComponent(bol)}`, {
      method: 'DELETE', credentials: 'same-origin',
    })
    if (res.ok) fetchShipments()
  }

  useEffect(() => {
    // Check session on mount — reads httpOnly cookie via server endpoint.
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => { if (d.authed) setAuthed(true) })
      .catch(() => {})
  }, [])

  const fetchAnalytics = useCallback(async (r: Range) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/analytics?range=${r}`, { credentials: 'same-origin' })
      if (res.status === 401) { setAuthed(false); return }
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAnalytics(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authed) return
    if (tab === 'analytics') fetchAnalytics(range)
    if (tab === 'shipments') fetchShipments()
  }, [authed, tab, range, fetchAnalytics, fetchShipments])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (res.ok && data.valid) {
        setPassword('')
        setAuthed(true)
      } else {
        setAuthError(data.error ?? 'Incorrect password')
      }
    } catch {
      setAuthError('Connection error — try again')
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleSignOut() {
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      // best-effort — clear locally regardless
    }
    setAuthed(false)
    setPassword('')
    setAnalytics(null)
  }

  // Auto sign-out after 10 minutes of inactivity.
  useIdleLogout(authed, handleSignOut)

  // ── Persistent top header (shown on both login and dashboard) ─────────────
  const PortalHeader = () => (
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
      style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
      <a href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
        J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
      </a>
      {authed ? (
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <a href="/" className="px-3 py-2 rounded-xl transition hover:text-white"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>Home</a>
          <a href="/admin/bookings" className="px-3 py-2 rounded-xl transition hover:text-white"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>Bookings</a>
          <a href="/admin/policy" className="px-3 py-2 rounded-xl transition hover:text-white"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>Policy</a>
          <a href="/admin/reviews" className="px-3 py-2 rounded-xl transition hover:text-white"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>Reviews</a>
          <button onClick={handleSignOut}
            className="px-4 py-2 rounded-xl transition hover:text-white"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
            Sign Out
          </button>
        </div>
      ) : (
        <a href="/"
          className="text-sm font-semibold px-4 py-2 rounded-xl transition hover:text-white"
          style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
          ← Back to Home
        </a>
      )}
    </header>
  )

  // ── Login ─────────────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <>
        <PortalHeader />
        <main className="flex min-h-screen items-center justify-center px-6 pt-20"
          style={{ background: 'var(--bg)', color: 'var(--text)' }}>
          <div className="glass-card w-full max-w-sm p-8" style={{ borderRadius: '20px' }}>
            <p className="text-xl font-black text-white mb-1" style={{ letterSpacing: '-0.03em' }}>
              J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
            </p>
            <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>Admin — enter password to continue</p>
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <input type="password" placeholder="Admin password" value={password}
                onChange={e => setPassword(e.target.value)} style={iStyle} required autoFocus />
              {authError && <p className="text-sm" style={{ color: '#f87171' }}>{authError}</p>}
              <button type="submit" disabled={authLoading} className="btn w-full" style={{ justifyContent: 'center' }}>
                {authLoading ? 'Checking…' : 'Sign In →'}
              </button>
            </form>
          </div>
        </main>
      </>
    )
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const noUpstash = error.includes('UPSTASH')

  return (
    <>
      <PortalHeader />
      <main className="min-h-screen px-6 pt-24 pb-10" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
        <div className="max-w-6xl mx-auto">

        {/* Tab switcher */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,.1)' }}>
            {([
              { id: 'analytics' as Tab, label: 'Analytics' },
              { id: 'shipments' as Tab, label: 'Shipments' },
            ]).map((t, i, arr) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="px-5 py-2 text-sm font-semibold transition-colors"
                style={{
                  background: tab === t.id ? 'var(--red)' : 'rgba(255,255,255,.03)',
                  color: tab === t.id ? '#fff' : 'var(--muted)',
                  borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,.1)' : 'none',
                }}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'analytics' && (
            <div className="flex items-center gap-3">
              <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,.1)' }}>
                {(['7d', '30d', '90d'] as Range[]).map(r => (
                  <button key={r} onClick={() => setRange(r)}
                    className="px-4 py-2 text-sm font-semibold transition-colors"
                    style={{
                      background: range === r ? 'var(--red)' : 'rgba(255,255,255,.03)',
                      color: range === r ? '#fff' : 'var(--muted)',
                      borderRight: r !== '90d' ? '1px solid rgba(255,255,255,.1)' : 'none',
                    }}>
                    {r}
                  </button>
                ))}
              </div>
              <button onClick={() => fetchAnalytics(range)}
                className="px-4 py-2 text-sm font-semibold rounded-xl"
                style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
                ↻
              </button>
            </div>
          )}
          {tab === 'shipments' && (
            <div className="flex items-center gap-3">
              <button onClick={() => { setShowNewForm(true); setEditingBol(null) }}
                className="btn" style={{ padding: '8px 16px', fontSize: '13px' }}>+ New Shipment</button>
              <button onClick={fetchShipments}
                className="px-4 py-2 text-sm font-semibold rounded-xl"
                style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>↻</button>
            </div>
          )}
        </div>

        {/* Page title — context-aware */}
        <div className="mb-8">
          <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.04em' }}>
            {tab === 'analytics' ? 'Analytics' : 'Shipments'}
          </p>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>
            {tab === 'analytics' ? 'Live visitor dashboard · jkissllc.com' : 'Manage BOL status updates that customers see on /track'}
          </p>
        </div>

        {tab === 'analytics' && loading && <div className="text-center py-20 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>}

        {/* Upstash not configured */}
        {tab === 'analytics' && noUpstash && !loading && (
          <div className="glass-card rounded-2xl p-8 text-center">
            <p className="text-lg font-black text-white mb-3">One More Step</p>
            <p className="text-sm leading-relaxed max-w-lg mx-auto mb-5" style={{ color: 'var(--muted)' }}>
              Add a free Upstash Redis database to enable live analytics:
            </p>
            <ol className="text-sm space-y-2 text-left inline-block" style={{ color: 'var(--muted)' }}>
              <li>1. Go to <strong className="text-white">vercel.com → jkissllc project → Storage tab</strong></li>
              <li>2. Click <strong className="text-white">Create Database → Upstash Redis</strong></li>
              <li>3. Name it anything → <strong className="text-white">Create & Connect to Project</strong></li>
              <li>4. Redeploy once — that&apos;s it</li>
            </ol>
          </div>
        )}

        {/* Generic error */}
        {tab === 'analytics' && error && !noUpstash && !loading && (
          <div className="rounded-2xl p-5 text-sm text-center mb-6"
            style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.2)', color: '#f87171' }}>
            {error}
          </div>
        )}

        {/* Live dashboard */}
        {tab === 'analytics' && !loading && !error && analytics && (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {[
                { label: `Visitors (${range})`, value: analytics.rangeVisitors },
                { label: `Page Views (${range})`, value: analytics.rangePageviews },
                { label: 'All-Time Visitors', value: analytics.totalVisitors },
                { label: 'All-Time Page Views', value: analytics.totalPageviews },
              ].map(card => (
                <div key={card.label} className="glass-card p-6 text-center" style={{ borderRadius: '16px' }}>
                  <p className="text-4xl font-black mb-1" style={{ color: 'var(--red)', letterSpacing: '-0.04em' }}>
                    {card.value.toLocaleString()}
                  </p>
                  <p className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>{card.label}</p>
                </div>
              ))}
            </div>

            {/* Daily chart */}
            {analytics.daily.length > 0 && (
              <div className="glass-card rounded-2xl p-6 mb-6">
                <p className="text-sm font-black text-white mb-4">Daily Page Views — Last {range}</p>
                <MiniBar data={analytics.daily} field="pageviews" />
                <div className="flex justify-between mt-2 text-xs" style={{ color: 'rgba(255,255,255,.2)' }}>
                  <span>{analytics.daily[0]?.date}</span>
                  <span>{analytics.daily[analytics.daily.length - 1]?.date}</span>
                </div>
              </div>
            )}

            {/* Top pages + referrers */}
            <div className="grid md:grid-cols-2 gap-6">
              {[
                { title: 'Top Pages', rows: analytics.paths },
                { title: 'Top Referrers', rows: analytics.referrers },
              ].map(({ title, rows }) => (
                <div key={title} className="glass-card rounded-2xl overflow-hidden">
                  <div className="px-6 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                    <p className="text-sm font-black text-white">{title}</p>
                  </div>
                  {rows.length === 0 ? (
                    <p className="px-6 py-8 text-sm text-center" style={{ color: 'var(--muted)' }}>No data yet — visit the site to start tracking</p>
                  ) : (
                    rows.map((row, i) => {
                      const maxVal = rows[0].total
                      return (
                        <div key={row.key} className="relative px-6 py-3" style={{ borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                          <div className="absolute inset-0 left-0" style={{ width: `${(row.total / maxVal) * 100}%`, background: 'rgba(224,0,42,.06)', borderRadius: '0' }} />
                          <div className="relative flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="text-xs font-bold w-4 text-center shrink-0" style={{ color: 'rgba(255,255,255,.25)' }}>{i + 1}</span>
                              <span className="text-sm truncate text-white font-medium">{row.key || '/'}</span>
                            </div>
                            <span className="text-sm font-black shrink-0" style={{ color: 'var(--red)' }}>{row.total.toLocaleString()}</span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              ))}
            </div>

            <p className="mt-6 text-xs text-center" style={{ color: 'rgba(255,255,255,.2)' }}>
              Tracked via jkissllc.com · Visitor counts use privacy-friendly HyperLogLog estimation · No cookies stored
            </p>
          </>
        )}

        {/* ── Shipments tab ──────────────────────────────────────────────── */}
        {tab === 'shipments' && (
          <ShipmentsPanel
            shipments={shipments}
            loading={shipmentsLoading}
            error={shipmentsError}
            editingBol={editingBol}
            showNewForm={showNewForm}
            onEdit={setEditingBol}
            onCancelEdit={() => { setEditingBol(null); setShowNewForm(false) }}
            onSave={saveShipment}
            onDelete={removeShipment}
          />
        )}
        </div>
      </main>
    </>
  )
}

// ── Shipments panel ──────────────────────────────────────────────────────────
function ShipmentsPanel({
  shipments, loading, error, editingBol, showNewForm,
  onEdit, onCancelEdit, onSave, onDelete,
}: {
  shipments: Shipment[]
  loading: boolean
  error: string
  editingBol: string | null
  showNewForm: boolean
  onEdit: (bol: string) => void
  onCancelEdit: () => void
  onSave: (s: Partial<Shipment>) => Promise<void>
  onDelete: (bol: string) => Promise<void>
}) {
  const noUpstash = error.includes('UPSTASH')

  if (loading) return <div className="text-center py-20 text-sm" style={{ color: 'var(--muted)' }}>Loading shipments…</div>

  if (noUpstash) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <p className="text-lg font-black text-white mb-3">Upstash Redis not configured</p>
        <p className="text-sm leading-relaxed max-w-lg mx-auto" style={{ color: 'var(--muted)' }}>
          Shipment tracking uses the same Upstash Redis database as analytics. Configure it in Vercel → Storage to enable.
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl p-5 text-sm text-center mb-6"
        style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.2)', color: '#f87171' }}>
        {error}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {showNewForm && (
        <ShipmentEditor shipment={null} onSave={onSave} onCancel={onCancelEdit} />
      )}

      {shipments.length === 0 && !showNewForm && (
        <div className="glass-card rounded-2xl p-8 text-center">
          <p className="text-base font-bold text-white mb-2">No shipments yet</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Click <strong className="text-white">+ New Shipment</strong> to create the first one. Customers will be able to look it up at{' '}
            <a href="/track" className="font-semibold hover:text-white" style={{ color: 'var(--red)' }}>/track</a>.
          </p>
        </div>
      )}

      {shipments.map(s => editingBol === s.bol ? (
        <ShipmentEditor key={s.bol} shipment={s} onSave={onSave} onCancel={onCancelEdit} />
      ) : (
        <ShipmentRow key={s.bol} s={s} onEdit={() => onEdit(s.bol)} onDelete={() => onDelete(s.bol)} />
      ))}
    </div>
  )
}

function ShipmentRow({ s, onEdit, onDelete }: { s: Shipment; onEdit: () => void; onDelete: () => void }) {
  const stepIndex = SHIPMENT_STATUSES.indexOf(s.status)
  const updatedAgo = relative(s.updatedAt)
  return (
    <div className="glass-card p-5" style={{ borderRadius: '16px' }}>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>BOL</p>
          <p className="text-lg font-black text-white" style={{ fontFamily: 'var(--font-mono)' }}>{s.bol}</p>
          {s.customerName && <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{s.customerName}</p>}
        </div>
        <div className="text-right">
          <p className="text-lg font-black" style={{ color: 'var(--red)', letterSpacing: '-0.02em' }}>{SHIPMENT_LABEL[s.status]}</p>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.4)' }}>updated {updatedAgo}</p>
        </div>
      </div>
      {(s.pickupCity || s.deliveryCity) && (
        <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
          <span className="font-mono">{s.pickupCity ?? '—'}</span>
          <span className="mx-2" style={{ color: 'var(--red)' }}>→</span>
          <span className="font-mono">{s.deliveryCity ?? '—'}</span>
        </p>
      )}
      <div className="flex items-center gap-2 mb-4">
        {SHIPMENT_STATUSES.map((st, i) => (
          <div key={st} className="flex-1 h-1 rounded-full" style={{ background: i <= stepIndex ? 'var(--red)' : 'rgba(255,255,255,.10)' }} />
        ))}
      </div>
      {s.notes && <p className="text-xs italic mb-4" style={{ color: 'rgba(255,255,255,.5)' }}>&quot;{s.notes}&quot;</p>}
      <div className="flex gap-2">
        <button onClick={onEdit}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
          Edit
        </button>
        <button onClick={onDelete}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.3)', color: '#ff6680' }}>
          Delete
        </button>
      </div>
    </div>
  )
}

function ShipmentEditor({ shipment, onSave, onCancel }: { shipment: Shipment | null; onSave: (s: Partial<Shipment>) => Promise<void>; onCancel: () => void }) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true); setErr('')
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      await onSave(data as Partial<Shipment>)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
      setSaving(false)
    }
  }
  return (
    <form onSubmit={handleSubmit} className="glass-card p-5 space-y-3" style={{ borderRadius: '16px', borderColor: 'rgba(224,0,42,.3)' }}>
      <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--red)', letterSpacing: '0.14em' }}>
        {shipment ? `Editing ${shipment.bol}` : 'New Shipment'}
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>BOL / PO #*</label>
          <input name="bol" required defaultValue={shipment?.bol} readOnly={!!shipment} style={iStyle} />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Status*</label>
          <select name="status" required defaultValue={shipment?.status ?? 'created'} style={{ ...iStyle, cursor: 'pointer' }}>
            {SHIPMENT_STATUSES.map(s => <option key={s} value={s}>{SHIPMENT_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Customer Name (ops only — not shown publicly)</label>
        <input name="customerName" defaultValue={shipment?.customerName} placeholder="Acme Logistics" style={iStyle} />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Pickup City</label>
          <input name="pickupCity" defaultValue={shipment?.pickupCity} placeholder="Dallas, TX" style={iStyle} />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Delivery City</label>
          <input name="deliveryCity" defaultValue={shipment?.deliveryCity} placeholder="Fort Worth, TX" style={iStyle} />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Public Notes (shown on /track)</label>
        <input name="notes" defaultValue={shipment?.notes} placeholder="ETA 2-4pm Tuesday" style={iStyle} />
      </div>
      {err && <p className="text-sm" style={{ color: '#f87171' }}>{err}</p>}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={saving} className="btn" style={{ padding: '8px 16px', fontSize: '13px' }}>
          {saving ? 'Saving…' : 'Save Shipment'}
        </button>
        <button type="button" onClick={onCancel}
          className="text-xs font-semibold px-3 py-2 rounded-lg"
          style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function relative(ts: number) {
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}
