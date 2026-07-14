'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { useAdminSession } from '../useAdminSession'
import { Home, ClipboardList, Users, Building2, Truck, MessageSquare, ShieldAlert, Settings, LogOut, Search, Plus, Zap } from 'lucide-react'
import CommandPalette from './CommandPalette'
import LastLogin from './LastLogin'
import Image from 'next/image'
import { OpsPilotWordmark } from '../../components/opspilot/OpsPilotMark'

// `adminOnly` tabs are hidden from managers in the UI AND gated server-side on the
// matching route (hiding is never the control — see the API guards).
const NAV = [
  { href: '/admin/operations', label: 'Home', Icon: Home },
  { href: '/admin/operations/book-now', label: 'Book Now', Icon: Zap },
  { href: '/admin/operations/list', label: 'Operations', Icon: ClipboardList },
  { href: '/admin/operations/employees', label: 'Crew', Icon: Users },
  { href: '/admin/operations/businesses', label: 'Businesses', Icon: Building2 },
  { href: '/admin/operations/equipment', label: 'Equipment', Icon: Truck },
  { href: '/admin/operations/claims', label: 'Claims', Icon: ShieldAlert },
  { href: '/admin/operations/messages', label: 'Messages', Icon: MessageSquare },
  { href: '/admin/operations/settings', label: 'Settings', Icon: Settings, adminOnly: true },
]

const iStyle: React.CSSProperties = {
  width: '100%', padding: '13px 15px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}

export default function OperationsShell({ children }: { children: React.ReactNode }) {
  const { authed, checked, error, loading, login, signOut, lastLogin, role } = useAdminSession()
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const pathname = usePathname()
  const router = useRouter()

  // Attention badge for the Book Now dock item: count of online submissions still
  // awaiting the owner (new / awaiting photos / AI / approval / quote-ready).
  // One fail-soft fetch; refreshed when you navigate back to the Home or queue.
  const [bookNowNew, setBookNowNew] = useState(0)
  useEffect(() => {
    let live = true
    fetch('/api/admin/book-now', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live && j?.counts) { const c = j.counts; setBookNowNew(c.new + c.awaiting_photos + c.ai_queued + c.ai_processing + c.ai_failed + c.manual_review + c.quote_ready) } })
      .catch(() => {})
    return () => { live = false }
  }, [pathname])

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault()
    if (await login(password, email)) {
      setPassword(''); setEmail('')
      // Land on the operations home after signing in, regardless of which admin
      // URL the session started on (a bookmarked /admin/bookings, etc.).
      if (pathname !== '/admin/operations') router.push('/admin/operations')
    }
  }

  // Managers don't see admin-only tabs (Settings). The matching APIs are gated
  // server-side too — this only tidies the dock.
  const nav = NAV.filter(n => !n.adminOnly || role !== 'manager')

  // Longest-prefix match so /admin/routes/invoices highlights Businesses, not Operations.
  const activeHref = [...nav].filter(n => pathname === n.href || pathname.startsWith(n.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]?.href

  // The create action is reachable from every tab, not just Home — one persistent
  // "+" that follows you. Hidden only on the builder itself (you're already there).
  const onBuilder = pathname === '/admin/operations/new' || pathname.startsWith('/admin/operations/new/')

  if (!checked) return (
    <div className="jkos" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="skeleton" style={{ width: 120, height: 14, borderRadius: 7 }} />
    </div>
  )

  // Sign-in: the tenant is named first, the platform underneath it. This is the
  // shape every future OpsPilot tenant's login will take — company on top,
  // "Powered by OpsPilot" below the fold of the form.
  if (!authed) return (
    <div className="jkos" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="os-card os-rise" style={{ width: '100%', maxWidth: 380, padding: 30 }}>
        <p className="jkos-h" style={{ fontSize: 26 }}>J KISS <span style={{ color: 'var(--red)' }}>Freight</span></p>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4, marginBottom: 22 }}>Sign in to your operations.</p>
        <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input type="email" autoComplete="username" placeholder="Email (managers)" value={email} onChange={e => setEmail(e.target.value)} style={iStyle} />
          <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} style={iStyle} required autoFocus />
          {error && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}
          <button type="submit" disabled={loading} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46 }}>{loading ? 'Checking…' : 'Sign In'}</button>
          <p style={{ color: 'var(--muted)', fontSize: 11.5, textAlign: 'center', margin: 0 }}>Owner: leave email blank. Crew sign in at <Link href="/portal" style={{ color: 'var(--muted)', textDecoration: 'underline' }}>the crew portal</Link>.</p>
        </form>

        <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--muted)' }}>
          <Image src="/operion-mark.png" alt="Operion" width={18} height={18} style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: 12.5 }}>
            Powered by <OpsPilotWordmark tm style={{ color: 'var(--text)', fontWeight: 600 }} />
          </span>
        </div>
      </div>
    </div>
  )

  return (
    <div className="jkos">
      <CommandPalette />
      <button onClick={() => window.dispatchEvent(new Event('jkos-open-search'))} aria-label="Search" className="os-tap"
        style={{ position: 'fixed', top: 'calc(14px + env(safe-area-inset-top))', left: 'calc(14px + env(safe-area-inset-left))', zIndex: 60, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--line)', cursor: 'pointer', maxWidth: 'calc(50vw - 20px)' }}>
        <Search size={14} /> Search <kbd className="hidden sm:inline" style={{ fontSize: 10.5, fontWeight: 700, border: '1px solid var(--line)', borderRadius: 5, padding: '1px 5px', marginLeft: 2 }}>⌘K</kbd>
      </button>
      <button onClick={signOut} aria-label="Sign out" className="os-tap"
        style={{ position: 'fixed', top: 'calc(14px + env(safe-area-inset-top))', right: 'calc(14px + env(safe-area-inset-right))', zIndex: 60, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--line)', cursor: 'pointer', maxWidth: 'calc(50vw - 20px)', whiteSpace: 'nowrap' }}>
        <LogOut size={14} /> Sign out
      </button>

      <main style={{ maxWidth: 940, margin: '0 auto', padding: 'calc(64px + env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) calc(120px + env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left))' }}>
        <LastLogin record={lastLogin} />
        {children}
      </main>

      {/* Persistent create action — a "+" that follows you across every tab, sitting
          clear of both docks. Same destination as every "New assignment" button. */}
      {!onBuilder && (
        <Link href="/admin/operations/new" aria-label="New assignment" title="New assignment" data-fab
          style={{ position: 'fixed', right: 'calc(18px + env(safe-area-inset-right))', bottom: 'calc(84px + env(safe-area-inset-bottom))', zIndex: 55, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 58, height: 58, borderRadius: 999, background: 'var(--red)', color: '#fff', boxShadow: 'var(--os-shadow)', textDecoration: 'none' }}
          className="os-tap">
          <Plus size={26} strokeWidth={2.4} />
        </Link>
      )}

      {/* Desktop floating dock */}
      <nav className="os-glass" style={{ position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 50, display: 'none', gap: 2, padding: 7, borderRadius: 999, boxShadow: 'var(--os-shadow)' }} data-dock="desktop">
        {nav.map(n => {
          const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} className="os-dock-item" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, textDecoration: 'none', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <n.Icon size={17} /> {n.label}
              {n.href === '/admin/operations/book-now' && bookNowNew > 0 && (
                <span aria-label={`${bookNowNew} new`} style={{ marginLeft: 2, fontSize: 10.5, fontWeight: 800, background: active ? '#fff' : 'var(--red)', color: active ? 'var(--red)' : '#fff', borderRadius: 999, minWidth: 17, height: 17, padding: '0 5px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{bookNowNew}</span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Mobile bottom nav — same dock look: icon-only inactive, red pill for the active tab */}
      <nav className="os-glass" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50, display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '10px 8px calc(10px + env(safe-area-inset-bottom))', borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }} data-dock="mobile">
        {nav.map(n => {
          const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} aria-label={n.label} className="os-dock-item" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: active ? 7 : 0, padding: active ? '9px 15px' : '9px', borderRadius: 999, textDecoration: 'none', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <n.Icon size={20} />
              {active && <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{n.label}</span>}
              {n.href === '/admin/operations/book-now' && bookNowNew > 0 && (
                <span aria-label={`${bookNowNew} new`} style={{ position: 'absolute', top: 2, right: 2, fontSize: 9.5, fontWeight: 800, background: 'var(--red)', color: '#fff', borderRadius: 999, minWidth: 15, height: 15, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--card)' }}>{bookNowNew}</span>
              )}
            </Link>
          )
        })}
      </nav>

      <style>{`
        /* 900px, not 768: the desktop dock is a fixed row of up to 8 pills (~800px)
           and clipped at both edges on a 768px tablet-portrait screen. Below 900 the
           full-width mobile bottom nav (space-around, always fits) is used instead. */
        @media (min-width: 900px) { nav[data-dock="desktop"] { display: flex !important; } nav[data-dock="mobile"] { display: none !important; } [data-fab] { right: 26px !important; bottom: 26px !important; } }
      `}</style>
    </div>
  )
}
