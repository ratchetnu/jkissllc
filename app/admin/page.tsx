'use client'

import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'jk_admin_pw'
type Range = '7d' | '30d' | '90d'

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

const iStyle: React.CSSProperties = {
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

  const [range, setRange] = useState<Range>('30d')
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved) { setPassword(saved); setAuthed(true) }
  }, [])

  const fetchAnalytics = useCallback(async (pw: string, r: Range) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/analytics?range=${r}`, {
        headers: { 'x-admin-password': pw },
      })
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
    if (authed && password) fetchAnalytics(password, range)
  }, [authed, password, range, fetchAnalytics])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (res.ok && data.valid) {
        sessionStorage.setItem(STORAGE_KEY, password)
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

  // ── Login ─────────────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6"
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
    )
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const noUpstash = error.includes('UPSTASH')

  return (
    <main className="min-h-screen px-6 py-10" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.04em' }}>
              J Kiss <span style={{ color: 'var(--red)' }}>LLC</span> — Analytics
            </p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>Live visitor dashboard · jkissllc.com</p>
          </div>
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
            <button onClick={() => fetchAnalytics(password, range)}
              className="px-4 py-2 text-sm font-semibold rounded-xl"
              style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
              ↻
            </button>
            <button onClick={() => { sessionStorage.removeItem(STORAGE_KEY); setAuthed(false); setPassword(''); setAnalytics(null) }}
              className="px-4 py-2 text-sm font-semibold rounded-xl"
              style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
              Sign Out
            </button>
          </div>
        </div>

        {loading && <div className="text-center py-20 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>}

        {/* Upstash not configured */}
        {noUpstash && !loading && (
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
        {error && !noUpstash && !loading && (
          <div className="rounded-2xl p-5 text-sm text-center mb-6"
            style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.2)', color: '#f87171' }}>
            {error}
          </div>
        )}

        {/* Live dashboard */}
        {!loading && !error && analytics && (
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
      </div>
    </main>
  )
}
