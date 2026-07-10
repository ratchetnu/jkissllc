'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Home, ClipboardList, MessageSquare, CalendarCheck, CalendarOff, Wallet, User, LogOut } from 'lucide-react'
import { usePortalSession } from './usePortalSession'
import LastLogin from '../admin/operations/LastLogin'
import { OpsPilotMark, OpsPilotWordmark } from '../components/opspilot/OpsPilotMark'

const NAV = [
  { href: '/portal', label: 'Home', Icon: Home },
  { href: '/portal/routes', label: 'Routes', Icon: ClipboardList },
  { href: '/portal/messages', label: 'Messages', Icon: MessageSquare },
  { href: '/portal/availability', label: 'Availability', Icon: CalendarCheck },
  { href: '/portal/timeoff', label: 'Time Off', Icon: CalendarOff },
  { href: '/portal/pay', label: 'Pay', Icon: Wallet },
  { href: '/portal/profile', label: 'Profile', Icon: User },
]

const iStyle: React.CSSProperties = {
  width: '100%', padding: '13px 15px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}

export default function PortalShell({ children }: { children: React.ReactNode }) {
  const { me, authed, checked, error, loading, login, signOut, lastLogin } = usePortalSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const pathname = usePathname()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (await login(email, password)) { setPassword('') }
  }

  const activeHref = [...NAV]
    .filter(n => pathname === n.href || (n.href !== '/portal' && pathname.startsWith(n.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? '/portal'

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

      {/* Desktop dock */}
      <nav className="os-glass" style={{ position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 50, display: 'none', gap: 2, padding: 7, borderRadius: 999, boxShadow: 'var(--os-shadow)' }} data-dock="desktop">
        {NAV.map(n => {
          const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} className="os-dock-item" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, textDecoration: 'none', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <n.Icon size={17} /> {n.label}
            </Link>
          )
        })}
      </nav>

      {/* Mobile bottom nav */}
      <nav className="os-glass" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50, display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '10px 8px calc(10px + env(safe-area-inset-bottom))', borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }} data-dock="mobile">
        {NAV.map(n => {
          const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} aria-label={n.label} className="os-dock-item" style={{ display: 'inline-flex', alignItems: 'center', gap: active ? 7 : 0, padding: active ? '9px 15px' : '9px', borderRadius: 999, textDecoration: 'none', color: active ? '#fff' : 'var(--muted)', background: active ? 'var(--red)' : 'transparent' }}>
              <n.Icon size={20} />
              {active && <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{n.label}</span>}
            </Link>
          )
        })}
      </nav>

      <style>{`@media (min-width: 768px) { nav[data-dock="desktop"] { display: flex !important; } nav[data-dock="mobile"] { display: none !important; } }`}</style>
    </div>
  )
}
