'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { useIdleLogout } from './useIdleLogout'

const iStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)',
  borderRadius: '10px', color: '#f3f4f6', fontSize: '14px', outline: 'none',
}

// Shared admin auth gate. Checks the httpOnly session, renders a login form when
// signed out, and renders children + a nav header once authenticated.
export default function AdminGate({ title, children }: { title: string; children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [checked, setChecked] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => setAuthed(!!d.authed))
      .catch(() => {})
      .finally(() => setChecked(true))
  }, [])

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), credentials: 'same-origin',
      })
      const d = await res.json()
      if (res.ok && d.valid) { setAuthed(true); setPassword('') }
      else setError(d.error ?? 'Incorrect password')
    } catch { setError('Connection error — try again') }
    finally { setLoading(false) }
  }

  async function signOut() {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    setAuthed(false)
  }

  // Auto sign-out after 10 minutes of inactivity.
  useIdleLogout(authed, signOut)

  const Header = () => (
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-5 py-3.5"
      style={{ background: 'rgba(11,11,12,0.96)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
      <a href="/admin/bookings" className="text-lg font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
        J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
      </a>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Link href="/" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Home</Link>
        <a href="/admin/bookings" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Bookings</a>
        <a href="/admin/promos" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Promos</a>
        <a href="/admin/staff" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Crew</a>
        <a href="/admin/availability" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Availability</a>
        <a href="/admin/policy" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Policy</a>
        <a href="/admin/reviews" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Reviews</a>
        <a href="/admin" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Analytics</a>
        {authed && <button onClick={signOut} className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>Sign Out</button>}
      </div>
    </header>
  )

  if (!checked) {
    return (<><Header /><main className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}><p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p></main></>)
  }

  if (!authed) {
    return (
      <>
        <Header />
        <main className="flex min-h-screen items-center justify-center px-6 pt-20" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
          <div className="glass-card w-full max-w-sm p-8" style={{ borderRadius: '20px' }}>
            <p className="text-xl font-black text-white mb-1" style={{ letterSpacing: '-0.03em' }}>Admin</p>
            <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>{title} — enter password to continue</p>
            <form onSubmit={login} className="flex flex-col gap-4">
              <input type="password" placeholder="Admin password" value={password} onChange={e => setPassword(e.target.value)} style={iStyle} required autoFocus />
              {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
              <button type="submit" disabled={loading} className="btn w-full" style={{ justifyContent: 'center' }}>{loading ? 'Checking…' : 'Sign In →'}</button>
            </form>
          </div>
        </main>
      </>
    )
  }

  return (<><Header /><main className="min-h-screen px-4 pt-20 pb-16" style={{ background: 'var(--bg)', color: 'var(--text)' }}>{children}</main></>)
}
