'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Home, ClipboardList, MessageSquare, Package, CalendarCheck, CalendarOff, Wallet, User, LogOut, Clock, FileText, MoreHorizontal, X, LayoutGrid, ChevronDown } from 'lucide-react'
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

// Mirrors OperationsShell.navItemStyle EXACTLY: a filled NEUTRAL background + higher
// contrast + a thin red underline. Red stays a brand accent, never a giant capsule.
function navItemStyle(active: boolean): React.CSSProperties {
  return active
    ? { color: 'var(--text)', background: 'color-mix(in srgb, #fff 9%, var(--card))', boxShadow: 'inset 0 -2px 0 var(--red)' }
    : { color: 'var(--muted)', background: 'transparent' }
}

// Crew initials for the account chip. Falls back to the crew mark rather than
// rendering an empty circle when a name has not synced yet.
function initials(name: string | null | undefined): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/)
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || 'CR'
  }
  return 'CR'
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
  // Desktop menus: the "More" mega-menu and the account menu. Kept separate from the
  // mobile `moreOpen` sheet so one does not close the other on a resize.
  const [megaOpen, setMegaOpen] = useState(false)
  const [acctOpen, setAcctOpen] = useState(false)
  const megaRef = useRef<HTMLDivElement>(null)
  const acctRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const pathname = usePathname()

  // Outside-click + Escape, same contract as the admin shell: clicking away closes,
  // Escape closes and returns focus to the trigger that opened the panel.
  useEffect(() => {
    if (!megaOpen && !acctOpen) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (megaOpen && megaRef.current && !megaRef.current.contains(t)) setMegaOpen(false)
      if (acctOpen && acctRef.current && !acctRef.current.contains(t)) setAcctOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (megaOpen) { setMegaOpen(false); moreBtnRef.current?.focus() }
      if (acctOpen) setAcctOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [megaOpen, acctOpen])

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
      {/* ── Desktop top bar ────────────────────────────────────────────────────
          Same structure, geometry and tokens as the admin shell's top bar
          (OperationsShell) so Operations and the Crew Portal read as ONE product:
          brand left, primary nav + a grouped "More" mega-menu centre, account chip
          right. Deliberately WITHOUT admin's Search and notification Bell — crew has
          no search index and no notification centre, and a control that does nothing
          reads as broken rather than as parity. Sign out moved off its detached
          corner pill and into the account menu, where admin keeps it. */}
      <header data-topbar style={{ position: 'fixed', top: 'calc(14px + env(safe-area-inset-top))', left: 0, right: 0, zIndex: 50, display: 'none', padding: '0 16px' }}>
        <div className="os-glass" style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 18, boxShadow: 'var(--os-shadow)' }}>
          {/* LEFT — brand */}
          <Link href="/portal" aria-label="Crew Portal — Home" className="os-tap" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 12, textDecoration: 'none' }}>
            <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1 }}>
              <span className="jkos-h" style={{ fontSize: 18, letterSpacing: '-.02em', color: 'var(--text)' }}>Crew</span>
              <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '.28em', color: 'var(--red)', marginTop: 1 }}>PORTAL</span>
            </span>
          </Link>

          {/* CENTER — primary navigation + More */}
          <nav aria-label="Primary" style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2 }}>
            {PRIMARY.map(n => {
              const active = n.href === activeHref
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                  className={`os-dock-item${active ? ' is-active' : ''}`}
                  style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 12, fontSize: 13.5, fontWeight: 650, textDecoration: 'none', whiteSpace: 'nowrap', ...navItemStyle(active) }}>
                  <n.Icon size={16} strokeWidth={active ? 2.2 : 1.9} /> {n.label}
                </Link>
              )
            })}
            {MORE.length > 0 && (
              <div ref={megaRef} style={{ position: 'relative', display: 'inline-flex' }}>
                <button ref={moreBtnRef} type="button" aria-haspopup="true" aria-expanded={megaOpen} onClick={() => { setMegaOpen(v => !v); setAcctOpen(false) }}
                  className={`os-dock-item${(megaOpen || moreActive) ? ' is-active' : ''}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 12, fontSize: 13.5, fontWeight: 650, cursor: 'pointer', border: 'none', whiteSpace: 'nowrap', ...navItemStyle(megaOpen || moreActive) }}>
                  <LayoutGrid size={16} strokeWidth={1.9} /> More
                </button>
                {megaOpen && (
                  <div role="menu" aria-label="More navigation"
                    style={{ position: 'fixed', top: 'calc(76px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)', width: 'min(620px, 92vw)', zIndex: 51, background: 'color-mix(in srgb, var(--card) 96%, transparent)', backdropFilter: 'blur(22px) saturate(1.5)', WebkitBackdropFilter: 'blur(22px) saturate(1.5)', border: '1px solid var(--line)', borderRadius: 18, boxShadow: 'var(--os-shadow)', padding: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))', gap: 8 }}>
                    {MORE.map(n => {
                      const active = n.href === activeHref
                      return (
                        <Link key={n.href} href={n.href} role="menuitem" onClick={() => setMegaOpen(false)} aria-current={active ? 'page' : undefined}
                          className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px', borderRadius: 11, textDecoration: 'none', color: 'var(--text)', background: active ? 'color-mix(in srgb, #fff 8%, var(--card))' : 'transparent', fontSize: 13.5, fontWeight: 600 }}>
                          <n.Icon size={17} strokeWidth={1.9} style={{ color: active ? 'var(--text)' : 'var(--muted)' }} />
                          <span style={{ whiteSpace: 'nowrap' }}>{n.label}</span>
                        </Link>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </nav>

          {/* RIGHT — account only. No Search / no Bell: see the note above. */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            <div ref={acctRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button type="button" aria-haspopup="true" aria-expanded={acctOpen} onClick={() => { setAcctOpen(v => !v); setMegaOpen(false) }}
                className="os-tap" aria-label="Account menu"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 6px 4px 4px', borderRadius: 999, border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
                <span aria-hidden style={{ width: 30, height: 30, borderRadius: 999, background: 'color-mix(in srgb, var(--red) 22%, var(--card))', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 800, letterSpacing: '.02em' }}>{initials(me?.name)}</span>
                <ChevronDown size={15} style={{ color: 'var(--muted)', transform: acctOpen ? 'rotate(180deg)' : 'none', transition: 'transform .18s var(--os-ease)' }} />
              </button>
              {acctOpen && (
                <div role="menu" aria-label="Account"
                  style={{ position: 'fixed', top: 'calc(76px + env(safe-area-inset-top))', right: 16, zIndex: 51, width: 232, background: 'color-mix(in srgb, var(--card) 96%, transparent)', backdropFilter: 'blur(22px) saturate(1.5)', WebkitBackdropFilter: 'blur(22px) saturate(1.5)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'var(--os-shadow)', padding: 12 }}>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{me?.name || 'Crew'}</p>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>{me?.role || 'Crew member'}</p>
                  {lastLogin?.at && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>Last login {new Date(lastLogin.at).toLocaleString()}</p>}
                  <div style={{ height: 1, background: 'var(--line)', margin: '12px 0' }} />
                  <Link href="/portal/profile" role="menuitem" onClick={() => setAcctOpen(false)}
                    className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '10px', borderRadius: 11, color: 'var(--text)', textDecoration: 'none', fontSize: 13.5, fontWeight: 600 }}>
                    <User size={16} /> Profile
                  </Link>
                  <button type="button" role="menuitem" onClick={() => { setAcctOpen(false); signOut() }}
                    className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', marginTop: 6, padding: '10px', borderRadius: 11, color: '#ff6680', background: 'transparent', border: '1px solid rgba(224,0,42,.35)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                    <LogOut size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--jk-main-pt, 58px) 18px var(--jk-main-pb, 120px)' }}>
        <LastLogin record={lastLogin} />
        {me?.onboarding && (
          <div className="os-card" style={{ padding: '12px 16px', marginBottom: 14, fontSize: 13.5, color: 'var(--muted)' }}>
            Welcome, {me.name.split(' ')[0]} — your onboarding is still in progress. Some sections fill in as your admin completes setup.
          </div>
        )}
        {children}
      </main>

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

      <style>{`
        /* ≥900px: desktop top bar; below, the mobile bottom bar + sheet. The SAME
           breakpoint and the same swap as OperationsShell — a crew member and an
           admin on the same laptop must not see two different nav architectures. */
        @media (min-width: 900px) {
          header[data-topbar] { display: block !important; }
          nav[data-dock="mobile"], [data-dock="mobile-sheet"] { display: none !important; }
          .jkos main { --jk-main-pt: calc(94px + env(safe-area-inset-top)); --jk-main-pb: 40px; }
        }
      `}</style>
    </div>
  )
}
