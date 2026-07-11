'use client'

import AdminGate from '../AdminGate'
import { useState, useEffect, useCallback } from 'react'
import { useIdleLogout } from '../useIdleLogout'
import AiFeedback from '../AiFeedback'
import { SkeletonStats } from '../../components/Skeleton'
import type { BookingAnalytics, NamedTotal, DayPoint } from '../../lib/analytics'

type Range = '7d' | '30d' | '90d'
type Tab = 'overview' | 'analytics' | 'shipments'

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const money2 = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const SERVICE_LABEL: Record<string, string> = {
  'moving': 'Moving', 'junk-removal': 'Junk Removal', 'eviction': 'Eviction / Cleanout',
  'appliance-delivery': 'Appliance Delivery', 'freight': 'Freight', 'estate-cleanout': 'Estate Cleanout',
  'garage-cleanout': 'Garage Cleanout', 'other': 'Other',
}
const svcLabel = (k: string) => SERVICE_LABEL[k] ?? k

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

// ── Executive dashboard pieces ───────────────────────────────────────────────
function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="glass-card p-5" style={{ borderRadius: '16px' }}>
      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}>{label}</p>
      <p className="text-3xl font-black mt-1.5" style={{ color: accent ? 'var(--red)' : '#fff', letterSpacing: '-0.04em' }}>{value}</p>
      {sub && <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.4)' }}>{sub}</p>}
    </div>
  )
}

function RevenueTrend({ series }: { series: DayPoint[] }) {
  const max = Math.max(...series.map(p => p.amountCents), 1)
  const W = 600, H = 130, n = series.length
  const xs = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W)
  const ys = (v: number) => H - (v / max) * (H - 12) - 6
  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.amountCents).toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 130, display: 'block' }} role="img" aria-label="Daily collected revenue, last 30 days">
      <defs>
        <linearGradient id="rvgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(224,0,42,.35)" />
          <stop offset="100%" stopColor="rgba(224,0,42,0)" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#rvgrad)" />
      <path d={line} fill="none" stroke="#E0002A" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function BarList({ rows, label, empty }: { rows: NamedTotal[]; label?: (k: string) => string; empty: string }) {
  if (rows.length === 0) return <p className="px-5 py-8 text-sm text-center" style={{ color: 'var(--muted)' }}>{empty}</p>
  const max = rows[0].amountCents || 1
  return (
    <>
      {rows.map((r, i) => (
        <div key={r.key} className="relative px-5 py-2.5" style={{ borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
          <div className="absolute inset-y-0 left-0" style={{ width: `${(r.amountCents / max) * 100}%`, background: 'rgba(224,0,42,.07)' }} />
          <div className="relative flex items-center justify-between gap-3">
            <span className="text-sm truncate text-white">{label ? label(r.key) : r.key} <span style={{ color: 'rgba(255,255,255,.3)' }}>· {r.count}</span></span>
            <span className="text-sm font-black shrink-0" style={{ color: 'var(--red)' }}>{money(r.amountCents)}</span>
          </div>
        </div>
      ))}
    </>
  )
}

const PAY_STATUS_META: { key: keyof BookingAnalytics['paymentStatus']; label: string; color: string }[] = [
  { key: 'paid_in_full', label: 'Paid in full', color: '#34d399' },
  { key: 'partially_paid', label: 'Partially paid', color: '#fbbf24' },
  { key: 'deposit_paid', label: 'Deposit paid', color: '#60a5fa' },
  { key: 'unpaid', label: 'Unpaid', color: '#f87171' },
]
function PaymentStatusBar({ status }: { status: BookingAnalytics['paymentStatus'] }) {
  const total = PAY_STATUS_META.reduce((s, m) => s + status[m.key], 0) || 1
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.05)' }}>
        {PAY_STATUS_META.map(m => status[m.key] > 0 && (
          <div key={m.key} style={{ width: `${(status[m.key] / total) * 100}%`, background: m.color }} title={`${m.label}: ${status[m.key]}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
        {PAY_STATUS_META.map(m => (
          <div key={m.key} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: m.color, display: 'inline-block' }} />
            {m.label} <span className="font-bold text-white">{status[m.key]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AnalyticsInner() {
  // The OS shell (AdminGate → OperationsShell) owns sign-in and chrome. This flag
  // only gates data fetches; it starts true because content renders only when the
  // shell has already authenticated, and flips false if any API returns 401.
  const [authed, setAuthed] = useState(true)

  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<Range>('30d')
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ── Executive overview state ────────────────────────────────────────────────
  const [overview, setOverview] = useState<BookingAnalytics | null>(null)
  const [ovLoading, setOvLoading] = useState(false)
  const [ovError, setOvError] = useState('')
  const fetchOverview = useCallback(async () => {
    setOvLoading(true); setOvError('')
    try {
      const res = await fetch('/api/admin/reports', { credentials: 'same-origin' })
      if (res.status === 401) { setAuthed(false); return }
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Error loading reports')
      setOverview(j.data)
    } catch (e) {
      setOvError(e instanceof Error ? e.message : 'Error loading reports')
    } finally { setOvLoading(false) }
  }, [])

  // ── AI insights ─────────────────────────────────────────────────────────────
  const [insights, setInsights] = useState('')
  const [insightsCallId, setInsightsCallId] = useState<string | undefined>()
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsErr, setInsightsErr] = useState('')
  async function fetchInsights() {
    setInsightsLoading(true); setInsightsErr('')
    try {
      const res = await fetch('/api/admin/ai/insights', { credentials: 'same-origin' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Could not generate insights.')
      setInsights(j.insights); setInsightsCallId(j.callId)
    } catch (e) { setInsightsErr(e instanceof Error ? e.message : 'Failed') }
    finally { setInsightsLoading(false) }
  }

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
    if (tab === 'overview') fetchOverview()
    if (tab === 'analytics') fetchAnalytics(range)
    if (tab === 'shipments') fetchShipments()
  }, [authed, tab, range, fetchOverview, fetchAnalytics, fetchShipments])

  async function handleSignOut() {
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      // best-effort — clear locally regardless
    }
    setAuthed(false)
    setAnalytics(null)
  }

  // Auto sign-out after 10 minutes of inactivity.
  useIdleLogout(authed, handleSignOut)

  // ── Dashboard (chrome — the floating dock / bottom nav — is provided by the OS shell) ──
  const noUpstash = error.includes('UPSTASH')

  return (
    <div className="max-w-6xl mx-auto">

        {/* Tab switcher */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,.1)' }}>
            {([
              { id: 'overview' as Tab, label: 'Overview' },
              { id: 'analytics' as Tab, label: 'Traffic' },
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
          {tab === 'overview' && (
            <button onClick={fetchOverview}
              className="px-4 py-2 text-sm font-semibold rounded-xl"
              style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>↻ Refresh</button>
          )}
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
              <button onClick={() => fetchAnalytics(range)} aria-label="Refresh analytics"
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
              <button onClick={fetchShipments} aria-label="Refresh shipments"
                className="px-4 py-2 text-sm font-semibold rounded-xl"
                style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>↻</button>
            </div>
          )}
        </div>

        {/* Page title — context-aware */}
        <div className="mb-8">
          <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.04em' }}>
            {tab === 'overview' ? 'Business Overview' : tab === 'analytics' ? 'Website Traffic' : 'Shipments'}
          </p>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>
            {tab === 'overview' ? 'Revenue, jobs & outstanding payments · live from your bookings'
              : tab === 'analytics' ? 'Live visitor dashboard · jkissllc.com'
              : 'Manage BOL status updates that customers see on /track'}
          </p>
        </div>

        {/* ── Overview (executive dashboard) ─────────────────────────────── */}
        {tab === 'overview' && ovLoading && (
          <div className="space-y-6">
            <SkeletonStats count={4} />
            <SkeletonStats count={4} />
            <div className="glass-card p-6" style={{ borderRadius: 16 }}><div className="skeleton" style={{ height: 130 }} aria-hidden="true" /></div>
          </div>
        )}
        {tab === 'overview' && ovError && !ovLoading && (
          <div className="rounded-2xl p-5 text-sm text-center mb-6" style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.2)', color: '#f87171' }}>
            {ovError.includes('UPSTASH') ? 'Connect Upstash Redis to enable business reporting.' : ovError}
          </div>
        )}
        {tab === 'overview' && !ovLoading && !ovError && overview && (
          <>
            {/* AI insights */}
            <div className="glass-card p-5 mb-6" style={{ borderRadius: 16, border: '1px solid rgba(224,0,42,.22)' }}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-black text-white">✨ AI Insights</p>
                <button onClick={fetchInsights} disabled={insightsLoading} className="text-xs font-bold px-3 py-1.5 rounded-lg" style={{ background: 'var(--red)', color: '#fff' }}>
                  {insightsLoading ? 'Analyzing…' : insights ? 'Regenerate' : 'Analyze my numbers'}
                </button>
              </div>
              {insightsErr && <p className="text-sm mt-3" role="alert" style={{ color: '#f87171' }}>{insightsErr}</p>}
              {insights
                ? <><pre className="text-sm mt-3 whitespace-pre-wrap" style={{ color: 'var(--text)', fontFamily: 'var(--font-body)', lineHeight: 1.6 }}>{insights}</pre><AiFeedback callId={insightsCallId} label="Was this briefing useful?" /></>
                : !insightsErr && !insightsLoading && <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>Get a plain-English read on your revenue, A/R, and job mix — plus what to do this week.</p>}
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              <StatCard label="Today" value={money(overview.revenue.today)} accent />
              <StatCard label="This Week" value={money(overview.revenue.week)} />
              <StatCard label="This Month" value={money(overview.revenue.month)} sub={`Projected ${money(overview.revenue.forecastMonth)}`} />
              <StatCard label="This Year" value={money(overview.revenue.year)} sub={`All-time ${money(overview.revenue.allTime)}`} />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <StatCard label="Outstanding" value={money(overview.outstandingCents)} accent sub="unpaid balances" />
              <StatCard label="Avg Ticket" value={money(overview.averageTicketCents)} />
              <StatCard label="Active Jobs" value={String(overview.jobs.active)} sub={`${overview.jobs.completed} completed all-time`} />
              <StatCard label="Booked This Mo." value={String(overview.jobs.bookedThisMonth)} sub={`${overview.jobs.completedThisMonth} completed this mo.`} />
            </div>

            {overview.disposal && (overview.disposal.totalCents > 0 || overview.revenue.allTime > 0) && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <StatCard label="Net After Disposal" value={money(overview.disposal.netAfterDisposalCents)} accent sub="collected − disposal cost" />
                <StatCard label="Disposal Cost" value={money(overview.disposal.totalCents)} sub={overview.disposal.actualEnteredCount > 0 ? `${overview.disposal.actualEnteredCount} actual + est.` : 'estimated'} />
                <StatCard label="Disposal (Actual)" value={money(overview.disposal.actualCents)} sub={`${overview.disposal.actualEnteredCount} job${overview.disposal.actualEnteredCount === 1 ? '' : 's'} entered`} />
                <StatCard label="Refunds" value={money(overview.refunds?.totalCents ?? 0)} sub={`${((overview.refunds?.rate ?? 0) * 100).toFixed(1)}% rate · ${overview.refunds?.bookingsCount ?? 0} job${(overview.refunds?.bookingsCount ?? 0) === 1 ? '' : 's'}`} />
              </div>
            )}

            {overview.continued && overview.continued.count > 0 && (
              <div className="glass-card rounded-2xl p-6 mb-6">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
                  <p className="text-sm font-black text-white">Continued / Multi-Day Jobs</p>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>
                    {overview.continued.count} total · <span style={{ color: '#fb923c' }}>{overview.continued.openCount} awaiting return</span>
                    {overview.continued.avgDelayDays > 0 && <> · avg {overview.continued.avgDelayDays}-day completion delay</>}
                  </p>
                </div>
                {overview.continued.reasons.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {overview.continued.reasons.map(r => (
                      <span key={r.key} className="text-xs px-2.5 py-1 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>{r.key} <span className="font-bold text-white">×{r.count}</span></span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="glass-card rounded-2xl p-6 mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-black text-white">Collected Revenue — Last 30 Days</p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>Avg {money(overview.revenue.avgDaily30)}/day</p>
              </div>
              <RevenueTrend series={overview.revenue.series} />
              <div className="flex justify-between mt-2 text-xs" style={{ color: 'rgba(255,255,255,.25)' }}>
                <span>{overview.revenue.series[0]?.date}</span>
                <span>{overview.revenue.series[overview.revenue.series.length - 1]?.date}</span>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6 mb-6">
              <div className="glass-card rounded-2xl p-6">
                <p className="text-sm font-black text-white mb-4">Payment Status</p>
                <PaymentStatusBar status={overview.paymentStatus} />
              </div>
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}><p className="text-sm font-black text-white">Revenue by Service</p></div>
                <BarList rows={overview.byService} label={svcLabel} empty="No collected revenue yet" />
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6 mb-6">
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}><p className="text-sm font-black text-white">Revenue by City</p></div>
                <BarList rows={overview.byCity} empty="Add “City, ST” to job addresses to see this" />
              </div>
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}><p className="text-sm font-black text-white">Revenue by ZIP</p></div>
                <BarList rows={overview.byZip} empty="Add ZIP codes to job addresses to see this" />
              </div>
            </div>

            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                <p className="text-sm font-black text-white">Outstanding Payments</p>
                <span className="text-sm font-black" style={{ color: 'var(--red)' }}>{money2(overview.outstandingCents)}</span>
              </div>
              {overview.outstanding.length === 0 ? (
                <p className="px-5 py-8 text-sm text-center" style={{ color: 'var(--muted)' }}>Nothing outstanding — everyone&apos;s paid up.</p>
              ) : overview.outstanding.map((o, i) => (
                <a key={o.token} href="/admin/bookings" className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-white/[.02]"
                  style={{ borderBottom: i < overview.outstanding.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                  <div className="min-w-0">
                    <p className="text-sm text-white font-medium truncate">{o.customerName}</p>
                    <p className="text-xs" style={{ color: 'rgba(255,255,255,.4)' }}>{o.bookingNumber} · {o.status.replace(/_/g, ' ')}</p>
                  </div>
                  <span className="text-sm font-black shrink-0" style={{ color: 'var(--red)' }}>{money2(o.balanceCents)}</span>
                </a>
              ))}
            </div>

            {overview.reviews && overview.reviews.count > 0 && (
              <p className="mt-6 text-xs text-center" style={{ color: 'rgba(255,255,255,.3)' }}>
                ★ {overview.reviews.rating.toFixed(1)} average across {overview.reviews.count} customer review{overview.reviews.count === 1 ? '' : 's'}
              </p>
            )}
          </>
        )}

        {tab === 'analytics' && loading && (
          <div className="space-y-6"><SkeletonStats count={4} /><div className="glass-card p-6" style={{ borderRadius: 16 }}><div className="skeleton" style={{ height: 64 }} aria-hidden="true" /></div></div>
        )}

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

export default function AnalyticsPage() {
  return <AdminGate title="Analytics"><AnalyticsInner /></AdminGate>
}
