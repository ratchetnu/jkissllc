'use client'

import Link from 'next/link'
import { useState, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useIdleLogout } from './useIdleLogout'

const iStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)',
  borderRadius: '10px', color: '#f3f4f6', fontSize: '14px', outline: 'none',
}

// Grouped admin destinations for the Menu dropdown.
const NAV_GROUPS: { label: string; items: { href: string; label: string; badge?: boolean }[] }[] = [
  { label: 'Operations', items: [
    { href: '/admin/routes', label: 'Route Dispatch' },
    { href: '/admin/routes/pay', label: 'Contractor Pay' },
    { href: '/admin/routes/invoices', label: 'Client Invoices' },
  ] },
  { label: 'Customers', items: [
    { href: '/admin/bookings', label: 'Bookings' },
    { href: '/admin/inbox', label: 'Inbox', badge: true },
    { href: '/admin/promos', label: 'Promos' },
    { href: '/admin/reviews', label: 'Reviews' },
  ] },
  { label: 'Team', items: [
    { href: '/admin/staff', label: 'Crew' },
    { href: '/admin/careers', label: 'Careers' },
    { href: '/admin/availability', label: 'Availability' },
  ] },
  { label: 'Business', items: [
    { href: '/admin/disposal', label: 'Disposal Pricing' },
    { href: '/admin/policy', label: 'Policy' },
    { href: '/admin/analytics', label: 'Analytics' },
  ] },
]

// Shared admin auth gate. Checks the httpOnly session, renders a login form when
// signed out, and renders children + a nav header once authenticated.
export default function AdminGate({ title, children }: { title: string; children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [checked, setChecked] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [unread, setUnread] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = usePathname()
  const navRef = useRef<HTMLDivElement>(null)

  // Close the menu on outside click / Escape, and whenever the route changes.
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => { if (navRef.current && !navRef.current.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])
  useEffect(() => { setMenuOpen(false) }, [pathname])

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => setAuthed(!!d.authed))
      .catch(() => {})
      .finally(() => setChecked(true))
  }, [])

  // Poll the unread customer-reply count for the Inbox nav badge while signed in.
  useEffect(() => {
    if (!authed) return
    let alive = true
    const tick = () => fetch('/api/admin/messages/count', { credentials: 'same-origin' })
      .then(r => r.json()).then(j => { if (alive) setUnread(j.unread ?? 0) }).catch(() => {})
    tick()
    const t = setInterval(tick, 45000)
    return () => { alive = false; clearInterval(t) }
  }, [authed])

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

  // Longest-prefix active match (so /admin/routes/pay highlights Contractor Pay).
  const allItems = NAV_GROUPS.flatMap(g => g.items)
  const activeHref = pathname === '/'
    ? '/'
    : allItems.filter(i => pathname === i.href || pathname.startsWith(i.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]?.href

  const Header = () => (
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center gap-2.5 px-4 sm:px-6 py-3.5"
      style={{ background: 'rgba(11,11,12,0.96)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
      <Link href="/" className="text-lg font-black tracking-tight shrink-0" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
        J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
      </Link>
      {title && <span className="text-sm font-semibold shrink truncate" style={{ color: 'var(--muted)' }}>· {title}</span>}

      <div ref={navRef} className="relative shrink-0 flex items-center gap-2" style={{ marginLeft: 'auto' }}>
        <a href="/admin/operations" className="hidden sm:inline-flex items-center gap-1.5 px-3.5 rounded-xl text-sm font-bold" style={{ height: 40, background: 'rgba(224,0,42,.16)', border: '1px solid rgba(224,0,42,.45)', color: '#fff' }}>✦ Operations</a>
        <button onClick={() => setMenuOpen(o => !o)} aria-label="Menu" aria-expanded={menuOpen}
          className="relative inline-flex items-center gap-2 px-3.5 rounded-xl text-sm font-bold"
          style={{ height: 40, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)', color: '#fff' }}>
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }} aria-hidden>
            <span style={{ width: 15, height: 2, background: '#fff', borderRadius: 2 }} />
            <span style={{ width: 15, height: 2, background: '#fff', borderRadius: 2 }} />
            <span style={{ width: 15, height: 2, background: '#fff', borderRadius: 2 }} />
          </span>
          Menu
          {!menuOpen && unread > 0 && <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 4px', borderRadius: 99, background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unread > 99 ? '99+' : unread}</span>}
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-2 rounded-2xl overflow-hidden"
            style={{ width: 268, maxHeight: '78vh', overflowY: 'auto', background: 'rgba(18,18,20,0.98)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 18px 54px rgba(0,0,0,.55)' }}>
            <a href="/admin/operations" onClick={() => setMenuOpen(false)} className="flex items-center px-4 py-3" style={{ background: 'rgba(224,0,42,.16)', color: '#fff', fontWeight: 800, fontSize: 14 }}>✦ Operations Home</a>
            {NAV_GROUPS.map(g => (
              <div key={g.label} style={{ borderTop: '1px solid rgba(255,255,255,.07)', padding: '7px 0' }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', padding: '3px 16px 5px' }}>{g.label}</div>
                {g.items.map(it => {
                  const active = it.href === activeHref
                  return (
                    <a key={it.href} href={it.href} onClick={() => setMenuOpen(false)} className="flex items-center justify-between px-4 py-2.5"
                      style={{ fontSize: 14, fontWeight: 600, color: active ? '#fff' : 'var(--muted)', background: active ? 'rgba(255,255,255,.06)' : 'transparent' }}>
                      <span>{it.label}</span>
                      {it.badge && unread > 0
                        ? <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99, background: 'var(--red)', color: '#fff', fontSize: 10.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unread > 99 ? '99+' : unread}</span>
                        : active ? <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--red)' }} /> : null}
                    </a>
                  )
                })}
              </div>
            ))}
            <div style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
              <a href="/" onClick={() => setMenuOpen(false)} className="block px-4 py-2.5" style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>← Public site</a>
              {authed && <button onClick={() => { setMenuOpen(false); signOut() }} className="block w-full text-left px-4 py-2.5" style={{ fontSize: 14, fontWeight: 700, color: '#fca5a5', background: 'none', border: 'none', cursor: 'pointer' }}>Sign Out</button>}
            </div>
          </div>
        )}
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
