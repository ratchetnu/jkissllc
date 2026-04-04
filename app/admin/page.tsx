'use client'

import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'jk_admin_pw'

type Range = '7d' | '30d' | '90d'

interface AnalyticsData {
  pageviews: { total: number; data?: { key: string; total: number }[] } | null
  visitors: { total: number; data?: { key: string; total: number }[] } | null
  referrers: { data?: { key: string; total: number }[] } | null
  paths: { data?: { key: string; total: number }[] } | null
  range: string
}

// ── Input style ───────────────────────────────────────────────────────────────
const iStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.10)',
  borderRadius: '10px',
  color: '#f3f4f6',
  fontSize: '14px',
  outline: 'none',
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

  // Restore session
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
      if (!res.ok) throw new Error('Failed to load analytics')
      setAnalytics(await res.json())
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

  function handleLogout() {
    sessionStorage.removeItem(STORAGE_KEY)
    setAuthed(false)
    setPassword('')
    setAnalytics(null)
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
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={iStyle}
              required
              autoFocus
            />
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
  const totalVisitors = analytics?.visitors?.total ?? null
  const totalPageviews = analytics?.pageviews?.total ?? null
  const topPaths = analytics?.paths?.data?.slice(0, 8) ?? []
  const topReferrers = analytics?.referrers?.data?.slice(0, 8) ?? []
  const noData = !loading && analytics && totalVisitors === null && totalPageviews === null

  return (
    <main className="min-h-screen px-6 py-10" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.04em' }}>
              J Kiss <span style={{ color: 'var(--red)' }}>LLC</span> — Analytics
            </p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>Site visitor dashboard · jkissllc.com</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Range selector */}
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
              className="px-4 py-2 text-sm font-semibold rounded-xl transition-colors"
              style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
              ↻
            </button>
            <button onClick={handleLogout}
              className="px-4 py-2 text-sm font-semibold rounded-xl transition-colors"
              style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
              Sign Out
            </button>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="text-center py-20 text-sm" style={{ color: 'var(--muted)' }}>Loading analytics…</div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="rounded-2xl p-6 text-sm text-center mb-8"
            style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.2)', color: '#f87171' }}>
            {error}
          </div>
        )}

        {/* Setup prompt — if env vars missing */}
        {noData && !error && (
          <div className="glass-card rounded-2xl p-8 text-center mb-8">
            <p className="text-lg font-black text-white mb-3">Setup Required</p>
            <p className="text-sm leading-relaxed max-w-lg mx-auto" style={{ color: 'var(--muted)' }}>
              Analytics data requires two environment variables in your Vercel project:
            </p>
            <div className="mt-5 inline-block text-left text-sm font-mono rounded-xl p-5 space-y-2"
              style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)' }}>
              <p><span style={{ color: 'var(--red)' }}>VERCEL_TOKEN</span> — your personal access token from vercel.com/account/tokens</p>
              <p><span style={{ color: 'var(--red)' }}>VERCEL_PROJECT_ID</span> — found in your project Settings → General</p>
            </div>
          </div>
        )}

        {/* Stat cards */}
        {!loading && analytics && !noData && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
              {[
                { label: 'Unique Visitors', value: totalVisitors, sub: `Last ${range}` },
                { label: 'Page Views', value: totalPageviews, sub: `Last ${range}` },
                {
                  label: 'Avg Daily Visitors',
                  value: totalVisitors != null
                    ? Math.round(totalVisitors / parseInt(range))
                    : null,
                  sub: 'Per day',
                },
              ].map(card => (
                <div key={card.label} className="glass-card p-6 text-center" style={{ borderRadius: '16px' }}>
                  <p className="text-4xl font-black mb-1" style={{ color: 'var(--red)', letterSpacing: '-0.04em' }}>
                    {card.value != null ? card.value.toLocaleString() : '—'}
                  </p>
                  <p className="text-sm font-semibold text-white">{card.label}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{card.sub}</p>
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Top pages */}
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-6 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                  <p className="text-sm font-black text-white">Top Pages</p>
                </div>
                {topPaths.length === 0 ? (
                  <p className="px-6 py-8 text-sm text-center" style={{ color: 'var(--muted)' }}>No page data yet</p>
                ) : (
                  <div className="divide-y" style={{ '--divide-color': 'rgba(255,255,255,.04)' } as React.CSSProperties}>
                    {topPaths.map((p, i) => (
                      <div key={p.key} className="flex items-center justify-between px-6 py-3 gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-xs font-bold w-4 shrink-0 text-center" style={{ color: 'rgba(255,255,255,.25)' }}>{i + 1}</span>
                          <span className="text-sm truncate text-white font-medium">{p.key || '/'}</span>
                        </div>
                        <span className="text-sm font-black shrink-0" style={{ color: 'var(--red)' }}>
                          {p.total.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Top referrers */}
              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-6 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                  <p className="text-sm font-black text-white">Top Referrers</p>
                </div>
                {topReferrers.length === 0 ? (
                  <p className="px-6 py-8 text-sm text-center" style={{ color: 'var(--muted)' }}>No referrer data yet</p>
                ) : (
                  <div className="divide-y" style={{ '--divide-color': 'rgba(255,255,255,.04)' } as React.CSSProperties}>
                    {topReferrers.map((r, i) => (
                      <div key={r.key} className="flex items-center justify-between px-6 py-3 gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-xs font-bold w-4 shrink-0 text-center" style={{ color: 'rgba(255,255,255,.25)' }}>{i + 1}</span>
                          <span className="text-sm truncate text-white font-medium">{r.key || 'Direct'}</span>
                        </div>
                        <span className="text-sm font-black shrink-0" style={{ color: 'var(--red)' }}>
                          {r.total.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer note */}
            <p className="mt-8 text-xs text-center" style={{ color: 'rgba(255,255,255,.2)' }}>
              Data sourced from Vercel Web Analytics · <a href="https://vercel.com/analytics" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors" style={{ color: 'rgba(255,255,255,.35)' }}>Open full dashboard ↗</a>
            </p>
          </>
        )}
      </div>
    </main>
  )
}
