'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useAdminSession } from '../useAdminSession'
import { Home, ClipboardList, Users, Building2, MessageSquare, ShieldAlert, Settings, LogOut, Search } from 'lucide-react'
import CommandPalette from './CommandPalette'
import { OpsPilotMark, OpsPilotWordmark } from '../../components/opspilot/OpsPilotMark'

const NAV = [
  { href: '/admin/operations', label: 'Home', Icon: Home },
  { href: '/admin/operations/list', label: 'Operations', Icon: ClipboardList },
  { href: '/admin/operations/employees', label: 'Employees', Icon: Users },
  { href: '/admin/operations/businesses', label: 'Businesses', Icon: Building2 },
  { href: '/admin/operations/claims', label: 'Claims', Icon: ShieldAlert },
  { href: '/admin/operations/messages', label: 'Messages', Icon: MessageSquare },
  { href: '/admin/operations/settings', label: 'Settings', Icon: Settings },
]

const iStyle: React.CSSProperties = {
  width: '100%', padding: '13px 15px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}

export default function OperationsShell({ children }: { children: React.ReactNode }) {
  const { authed, checked, error, loading, login, signOut } = useAdminSession()
  const [password, setPassword] = useState('')
  const pathname = usePathname()

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault()
    if (await login(password)) setPassword('')
  }

  // Longest-prefix match so /admin/routes/invoices highlights Businesses, not Operations.
  const activeHref = [...NAV].filter(n => pathname === n.href || pathname.startsWith(n.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]?.href

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
        <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input type="password" placeholder="Admin password" value={password} onChange={e => setPassword(e.target.value)} style={iStyle} required autoFocus />
          {error && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}
          <button type="submit" disabled={loading} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46 }}>{loading ? 'Checking…' : 'Sign In'}</button>
        </form>

        <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--muted)' }}>
          <OpsPilotMark size={15} />
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
        style={{ position: 'fixed', top: 16, left: 16, zIndex: 60, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', cursor: 'pointer' }}>
        <Search size={14} /> Search <kbd className="hidden sm:inline" style={{ fontSize: 10.5, fontWeight: 700, border: '1px solid var(--line)', borderRadius: 5, padding: '1px 5px', marginLeft: 2 }}>⌘K</kbd>
      </button>
      <button onClick={signOut} aria-label="Sign out" className="os-tap"
        style={{ position: 'fixed', top: 16, right: 16, zIndex: 60, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', cursor: 'pointer' }}>
        <LogOut size={14} /> Sign out
      </button>

      <main style={{ maxWidth: 940, margin: '0 auto', padding: '64px 18px 132px' }}>{children}</main>

      {/* Desktop floating dock */}
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

      {/* Mobile bottom nav — same dock look: icon-only inactive, red pill for the active tab */}
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

      <style>{`
        @media (min-width: 768px) { nav[data-dock="desktop"] { display: flex !important; } nav[data-dock="mobile"] { display: none !important; } }
      `}</style>
    </div>
  )
}
