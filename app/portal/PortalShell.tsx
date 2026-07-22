'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Home, ClipboardList, MessageSquare, Package, CalendarCheck, CalendarOff, Wallet, User, LogOut, Clock, FileText, MoreHorizontal, X } from 'lucide-react'
import { usePortalSession } from './usePortalSession'
import LastLogin from '../admin/operations/LastLogin'
import { OpsPilotMark, OpsPilotWordmark } from '../components/opspilot/OpsPilotMark'

// One nav model drives both docks. `primary` items live in the mobile bottom bar
// (the daily-use destinations); the rest collapse into a "More" sheet so the bar
// never crowds at 390px. The desktop dock shows everything.
//
// `flag` marks a destination that only exists when a feature flag is on. The flag
// is resolved SERVER-side in app/portal/layout.tsx and passed down, because a
// client component cannot read process.env — and a nav item pointing at a route
// that 404s is worse than no nav item at all.
const NAV = [
  { href: '/portal', label: 'Home', Icon: Home, primary: true },
  { href: '/portal/routes', label: 'Routes', Icon: ClipboardList, primary: true },
  { href: '/portal/clock', label: 'Clock', Icon: Clock, primary: true },
  { href: '/portal/messages', label: 'Messages', Icon: MessageSquare, primary: true },
  // "Jobs" is the unified feed (contract routes AND customer bookings). It is
  // SECONDARY for now: two near-identical primary tabs would just confuse, and it
  // is why the bottom bar stays at four — a fifth crowds at 390px. When bookings
  // are live, Jobs takes the Routes slot rather than sitting beside it.
  { href: '/portal/jobs', label: 'Jobs', Icon: Package, flag: 'jobs' as const },
  { href: '/portal/availability', label: 'Availability', Icon: CalendarCheck },
  { href: '/portal/timeoff', label: 'Time Off', Icon: CalendarOff },
  { href: '/portal/pay', label: 'Pay', Icon: Wallet },
  { href: '/portal/documents', label: 'Documents', Icon: FileText },
  { href: '/portal/profile', label: 'Profile', Icon: User },
]

// The nav a given crew member actually sees. With bookings off this is
// byte-identical to the portal's pre-Sprint-1 nav.
export function portalNav(showJobs: boolean) {
  return NAV.filter(n => n.flag !== 'jobs' || showJobs)
}

const iStyle: React.CSSProperties = {
  width: '100%', padding: '13px 15px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}

export default function PortalShell({ children, showJobs = false }: { children: React.ReactNode; showJobs?: boolean }) {
  const { me, authed, checked, error, loading, login, signOut, lastLogin } = usePortalSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const pathname = usePathname()

  // Defaults to `false`: if a future caller forgets to pass the flag, the portal
  // falls back to the nav it has always had rather than exposing a 404 route.
  const nav = portalNav(showJobs)
  const PRIMARY = nav.filter(n => n.primary)
  const MORE = nav.filter(n => !n.primary)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (await login(email, password)) { setPassword('') }
  }

  const activeHref = [...nav]
    .filter(n => pathname === n.href || (n.href !== '/portal' && pathname.startsWith(n.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? '/portal'
  // Highlight the "More" trigger when the current page lives in the overflow group.
  const moreActive = MORE.some(n => n.href === activeHref)

  if (!checked) return (
    <div className="jkos" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="skeleton" style={{ width: 120, height: 14, borderRadius: 7 }} />
    </div>
  )

  if (!authed) return (
    <div className="jkos" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="os-card os-rise" style={{ width: '100%', maxWidth: 380, padding: 30 }}>
        <p className="jkos-h" style={{ fontSize: 26 }}>Crew <span style={{ color: 'var(--red)' }}>Portal</span></p>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4, marginBottom: 22 }}>Sign in to see your routes and pay.</p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input type="email" autoComplete="username" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={iStyle} required autoFocus />
          <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} style={iStyle} required />
          {error && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}
          <button type="submit" disabled={loading} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46 }}>{loading ? 'Checking…' : 'Sign In'}</button>
        </form>
        <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--muted)' }}>
          <OpsPilotMark size={15} />
          <span style={{ fontSize: 12.5 }}>Powered by <OpsPilotWordmark tm style={{ color: 'var(--text)', fontWeight: 600 }} /></span>
        </div>
      </div>
    </div>
  )

  return (
    <div className="jkos">
      <button onClick={signOut} aria-label="Sign out" className="os-tap"
        style={{ position: 'fixed', top: 16, right: 16, zIndex: 60, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', cursor: 'pointer' }}>
        <LogOut size={14} /> Sign out
      </button>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '58px 18px 120px' }}>
        <LastLogin record={lastLogin} />
        {me?.onboarding && (
          <div className="os-card" style={{ padding: '12px 16px', marginBottom: 14, fontSize: 13.5, color: 'var(--muted)' }}>
            Welcome, {me.name.split(' ')[0]} — your onboarding is still in progress. Some sections fill in as your admin completes setup.
          </div>
        )}
        {children}
      </main>

      {/* Desktop dock — every destination in one row (scrolls if the viewport is tight) */}
      <nav className="os-glass" style={{ position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 50, display: 'none', gap: 2, padding: 7, borderRadius: 999, boxShadow: 'var(--os-shadow)', maxWidth: 'calc(100vw - 32px)', overflowX: 'auto' }} data-dock="desktop">
        {NAV.map(n => {
          const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} className="os-dock-item" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <n.Icon size={16} /> {n.label}
            </Link>
          )
        })}
      </nav>

      {/* Mobile "More" sheet — the overflow destinations, above the bottom bar */}
      {moreOpen && (
        <>
          <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(0,0,0,.45)' }} data-dock="mobile-sheet" aria-hidden />
          <div role="menu" aria-label="More" className="os-glass os-rise" style={{ position: 'fixed', left: 12, right: 12, bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 56, padding: 10, borderRadius: 20, boxShadow: 'var(--os-shadow)' }} data-dock="mobile-sheet">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 10px' }}>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>More</span>
              <button onClick={() => setMoreOpen(false)} aria-label="Close" className="os-tap" style={{ display: 'inline-flex', padding: 6, borderRadius: 999, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {MORE.map(n => {
                const active = n.href === activeHref
                return (
                  <Link key={n.href} href={n.href} role="menuitem" onClick={() => setMoreOpen(false)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderRadius: 13, fontSize: 14.5, fontWeight: 700, textDecoration: 'none', color: active ? '#fff' : 'var(--text)', background: active ? 'var(--red)' : 'rgba(255,255,255,.05)', border: '1px solid var(--line)' }}>
                    <n.Icon size={18} /> {n.label}
                  </Link>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* Mobile bottom nav — primary destinations + a More trigger */}
      <nav className="os-glass" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 57, display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '10px 8px calc(10px + env(safe-area-inset-bottom))', borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }} data-dock="mobile">
        {PRIMARY.map(n => {
          const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} aria-label={n.label} aria-current={active ? 'page' : undefined} onClick={() => setMoreOpen(false)} className="os-dock-item" style={{ display: 'inline-flex', alignItems: 'center', gap: active ? 7 : 0, padding: active ? '9px 15px' : '9px', borderRadius: 999, textDecoration: 'none', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <n.Icon size={20} />
              {active && <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{n.label}</span>}
            </Link>
          )
        })}
        {(() => {
          const active = moreActive
          return (
            <button onClick={() => setMoreOpen(o => !o)} aria-label="More" aria-expanded={moreOpen} className="os-dock-item os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: active ? 7 : 0, padding: active ? '9px 15px' : '9px', borderRadius: 999, border: 'none', cursor: 'pointer', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <MoreHorizontal size={20} />
              {active && <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>More</span>}
            </button>
          )
        })()}
      </nav>

      <style>{`@media (min-width: 768px) { nav[data-dock="desktop"] { display: flex !important; } nav[data-dock="mobile"], [data-dock="mobile-sheet"] { display: none !important; } }`}</style>
    </div>
  )
}
