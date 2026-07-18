'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { useAdminSession } from '../useAdminSession'
import { Home, ClipboardList, Users, Building2, Truck, MessageSquare, ShieldAlert, Settings, LogOut, Search, Plus, Zap, Rocket, MoreHorizontal, X, Sparkles, Mail, CalendarDays, LayoutGrid, Bell, ChevronDown, CircleDollarSign, Layers, RefreshCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import CommandPalette from './CommandPalette'
import LastLogin from './LastLogin'
import Image from 'next/image'
import { OpsPilotWordmark } from '../../components/opspilot/OpsPilotMark'
import {
  NAV_ITEMS, BOOK_NOW_HREF, visibleNav, desktopPrimaryNav, mobilePrimaryNav, menuGroups, mobileMoreGroups,
} from './nav-config'

// Icons live here (by href) so the nav model stays pure + testable. `adminOnly`/`ownerOnly`
// tabs are hidden by role AND gated server-side on the matching route (hiding is never the control).
const ICONS: Record<string, LucideIcon> = {
  '/admin/operations': Home,
  '/admin/operations/schedule': CalendarDays,
  '/admin/operations/list': ClipboardList,
  '/admin/operations/messages': MessageSquare,
  '/admin/operations/employees': Users,
  '/admin/operations/book-now': Zap,
  '/admin/operations/communications': Mail,
  '/admin/operations/ai': Sparkles,
  '/admin/operations/businesses': Building2,
  '/admin/operations/equipment': Truck,
  '/admin/operations/claims': ShieldAlert,
  '/admin/operations/pay-statements': CircleDollarSign,
  '/admin/operations/settings': Settings,
  '/admin/operations/release': Rocket,
  '/admin/operations/platform': Layers,
  '/admin/operations/sync': RefreshCw,
}
const iconFor = (href: string): LucideIcon => ICONS[href] ?? Home

const iStyle: React.CSSProperties = {
  width: '100%', padding: '13px 15px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}

// This shell is rendered *inside each page*, not a shared layout, so it fully unmounts/remounts on
// every navigation. Seeding these two async flags from module-scoped last-known values keeps the bar
// stable across remounts (owner-only items + the Book Now badge don't pop in on every click).
const navCache = { isOwner: false, bookNowNew: 0 }

function initials(name: string | null, role: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/)
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || 'JK'
  }
  return role === 'manager' ? 'MG' : 'JK' // legacy owner has no name record → J KISS mark
}

export default function OperationsShell({ children }: { children: React.ReactNode }) {
  const { authed, checked, error, loading, login, signOut, lastLogin, role, name } = useAdminSession()
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const pathname = usePathname()
  const router = useRouter()

  // Attention badge for Book Now: count of online submissions still awaiting the owner. One fail-soft
  // fetch; refreshed when you navigate. (Unchanged source + logic — same counts as before.)
  const [bookNowNew, setBookNowNew] = useState(navCache.bookNowNew)
  useEffect(() => {
    let live = true
    fetch('/api/admin/book-now', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live && j?.counts) { const c = j.counts; const total = c.new + c.awaiting_photos + c.ai_queued + c.ai_processing + c.ai_failed + c.manual_review + c.quote_ready; navCache.bookNowNew = total; setBookNowNew(total) } })
      .catch(() => {})
    return () => { live = false }
  }, [pathname])

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault()
    if (await login(password, email)) {
      setPassword(''); setEmail('')
      if (pathname !== '/admin/operations') router.push('/admin/operations')
    }
  }

  // Platform surfaces are platform-owner-only. Ask the server; the real gate is requirePlatformOwner on
  // every platform route — this only hides the links.
  const [isPlatformOwner, setIsPlatformOwner] = useState(navCache.isOwner)
  useEffect(() => {
    if (!authed) return
    let live = true
    fetch('/api/admin/platform/whoami', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live) { const owner = !!j?.owner; navCache.isOwner = owner; setIsPlatformOwner(owner) } })
      .catch(() => {})
    return () => { live = false }
  }, [authed])

  // Role-aware nav model (permissions preserved + enforced server-side).
  const nav = visibleNav(NAV_ITEMS, { role: role ?? undefined, isOwner: isPlatformOwner })
  const deskPrimary = desktopPrimaryNav(nav)
  const deskGroups = menuGroups(nav)
  const mobPrimary = mobilePrimaryNav(nav)
  const mobGroups = mobileMoreGroups(nav)
  const bookNow = nav.find(n => n.href === BOOK_NOW_HREF)

  // Menus: desktop "More" mega-menu, desktop account menu, mobile "More" sheet.
  const [megaOpen, setMegaOpen] = useState(false)
  const [acctOpen, setAcctOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const megaRef = useRef<HTMLDivElement>(null)
  const acctRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  // Close every menu on navigation (the shell also remounts, but this resets focus/state cleanly).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close menus on route change
  useEffect(() => { setMegaOpen(false); setAcctOpen(false); setMoreOpen(false) }, [pathname])

  // Outside-click + Escape close for the desktop popovers and the mobile sheet.
  useEffect(() => {
    if (!megaOpen && !acctOpen && !moreOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (megaOpen && megaRef.current && !megaRef.current.contains(t)) setMegaOpen(false)
      if (acctOpen && acctRef.current && !acctRef.current.contains(t)) setAcctOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (megaOpen) { setMegaOpen(false); moreBtnRef.current?.focus() }
      setAcctOpen(false); setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [megaOpen, acctOpen, moreOpen])

  // Longest-prefix match so /admin/routes/invoices highlights Businesses, not Operations.
  const activeItem = [...nav].filter(n => pathname === n.href || pathname.startsWith(n.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]
  const activeHref = activeItem?.href
  const activeInMenu = !!activeItem?.group                        // desktop: active route lives in the mega-menu
  const activeInMobileMore = !!activeItem && !activeItem.mobilePrimary && activeItem.href !== BOOK_NOW_HREF

  // Persistent "New assignment" create action — a "+" that follows you (distinct from Book Now).
  const onBuilder = pathname === '/admin/operations/new' || pathname.startsWith('/admin/operations/new/')

  if (!checked) return (
    <div className="jkos" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="skeleton" style={{ width: 120, height: 14, borderRadius: 7 }} />
    </div>
  )

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
          <span style={{ fontSize: 12.5 }}>Powered by <OpsPilotWordmark tm style={{ color: 'var(--text)', fontWeight: 600 }} /></span>
        </div>
      </div>
    </div>
  )

  const roleLabel = role === 'manager' ? 'Manager' : isPlatformOwner ? 'Owner' : 'Admin'

  return (
    <div className="jkos">
      <CommandPalette />

      {/* ── Desktop top bar (Apple-style, three zones) ───────────────────────────── */}
      <header data-topbar style={{ position: 'fixed', top: 'calc(14px + env(safe-area-inset-top))', left: 0, right: 0, zIndex: 50, display: 'none', padding: '0 16px' }}>
        <div className="os-glass" style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 18, boxShadow: 'var(--os-shadow)' }}>
          {/* LEFT — brand */}
          <Link href="/admin/operations" aria-label="J KISS LLC — Home" className="os-tap" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 12, textDecoration: 'none' }}>
            <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1 }}>
              <span className="jkos-h" style={{ fontSize: 18, letterSpacing: '-.02em', color: 'var(--text)' }}>J&nbsp;KISS</span>
              <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '.28em', color: 'var(--muted)', marginTop: 1 }}>LLC</span>
            </span>
          </Link>

          {/* CENTER — primary navigation + More */}
          <nav aria-label="Primary" style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2 }}>
            {deskPrimary.map(n => {
              const active = n.href === activeHref; const Icon = iconFor(n.href)
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                  className={`os-dock-item${active ? ' is-active' : ''}`}
                  style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 12, fontSize: 13.5, fontWeight: 650, textDecoration: 'none', whiteSpace: 'nowrap', ...navItemStyle(active) }}>
                  <Icon size={16} strokeWidth={active ? 2.2 : 1.9} /> {n.label}
                </Link>
              )
            })}
            {/* More — mega-menu trigger. Wrapper holds trigger + panel so outside-click detection works. */}
            <div ref={megaRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button ref={moreBtnRef} type="button" aria-haspopup="true" aria-expanded={megaOpen} onClick={() => { setMegaOpen(v => !v); setAcctOpen(false) }}
                className={`os-dock-item${(megaOpen || activeInMenu) ? ' is-active' : ''}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 12, fontSize: 13.5, fontWeight: 650, cursor: 'pointer', border: 'none', whiteSpace: 'nowrap', ...navItemStyle(megaOpen || activeInMenu) }}>
                <LayoutGrid size={16} strokeWidth={1.9} /> More
              </button>
              {megaOpen && (
                <div role="menu" aria-label="More navigation"
                  style={{ position: 'fixed', top: 'calc(76px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)', width: 'min(940px, 92vw)', zIndex: 51, background: 'color-mix(in srgb, var(--card) 96%, transparent)', backdropFilter: 'blur(22px) saturate(1.5)', WebkitBackdropFilter: 'blur(22px) saturate(1.5)', border: '1px solid var(--line)', borderRadius: 18, boxShadow: 'var(--os-shadow)', padding: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))', gap: 8 }}>
                  {deskGroups.map(g => (
                    <div key={g.key} style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.09em', color: 'var(--muted)', margin: '2px 0 8px 8px' }}>{g.label}</p>
                      <div style={{ display: 'grid', gap: 2 }}>
                        {g.items.map(n => {
                          const Icon = iconFor(n.href); const active = n.href === activeHref
                          const isSync = n.href === '/admin/operations/sync' // reference: Sync Status carries the red brand accent
                          return (
                            <Link key={n.href} href={n.href} role="menuitem" onClick={() => setMegaOpen(false)} aria-current={active ? 'page' : undefined}
                              className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px', borderRadius: 11, textDecoration: 'none', color: isSync && !active ? 'var(--red)' : 'var(--text)', background: active ? 'color-mix(in srgb, #fff 8%, var(--card))' : 'transparent', fontSize: 13.5, fontWeight: 600 }}>
                              <Icon size={17} strokeWidth={1.9} style={{ color: isSync ? 'var(--red)' : active ? 'var(--text)' : 'var(--muted)' }} />
                              <span style={{ whiteSpace: 'nowrap' }}>{n.label}</span>
                            </Link>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </nav>

          {/* RIGHT — utilities (only real, authorized controls; no theme toggle — admin is single-theme) */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            <button type="button" onClick={() => window.dispatchEvent(new Event('jkos-open-search'))} aria-label="Search (⌘K)" title="Search  ⌘K"
              className="os-tap" style={utilBtn}>
              <Search size={18} strokeWidth={1.9} />
            </button>
            {bookNow && (
              <Link href={bookNow.href} aria-label={bookNowNew > 0 ? `Book Now — ${bookNowNew} pending` : 'Book Now'} title="Book Now"
                className="os-tap" style={{ ...utilBtn, position: 'relative', color: activeHref === BOOK_NOW_HREF ? 'var(--text)' : 'var(--muted)', textDecoration: 'none' }}>
                <Bell size={18} strokeWidth={1.9} />
                {bookNowNew > 0 && (
                  <span aria-hidden style={{ position: 'absolute', top: 3, right: 2, fontSize: 9.5, fontWeight: 800, background: 'var(--red)', color: '#fff', borderRadius: 999, minWidth: 16, height: 16, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid color-mix(in srgb, var(--bg) 80%, transparent)' }}>{bookNowNew}</span>
                )}
              </Link>
            )}
            <div ref={acctRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button type="button" aria-haspopup="true" aria-expanded={acctOpen} onClick={() => { setAcctOpen(v => !v); setMegaOpen(false) }}
                className="os-tap" aria-label="Account menu"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 6px 4px 4px', borderRadius: 999, border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
                <span aria-hidden style={{ width: 30, height: 30, borderRadius: 999, background: 'color-mix(in srgb, var(--red) 22%, var(--card))', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 800, letterSpacing: '.02em' }}>{initials(name, role)}</span>
                <ChevronDown size={15} style={{ color: 'var(--muted)', transform: acctOpen ? 'rotate(180deg)' : 'none', transition: 'transform .18s var(--os-ease)' }} />
              </button>
              {acctOpen && (
                <div role="menu" aria-label="Account"
                  style={{ position: 'fixed', top: 'calc(76px + env(safe-area-inset-top))', right: 16, zIndex: 51, width: 232, background: 'color-mix(in srgb, var(--card) 96%, transparent)', backdropFilter: 'blur(22px) saturate(1.5)', WebkitBackdropFilter: 'blur(22px) saturate(1.5)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'var(--os-shadow)', padding: 12 }}>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{name || 'J KISS LLC'}</p>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>{roleLabel}</p>
                  {lastLogin?.at && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>Last login {new Date(lastLogin.at).toLocaleString()}</p>}
                  <div style={{ height: 1, background: 'var(--line)', margin: '12px 0' }} />
                  <button type="button" role="menuitem" onClick={() => { setAcctOpen(false); signOut() }}
                    className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '10px 10px', borderRadius: 11, color: '#ff6680', background: 'transparent', border: '1px solid rgba(224,0,42,.35)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                    <LogOut size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 940, margin: '0 auto', padding: 'var(--jk-main-pt, calc(20px + env(safe-area-inset-top))) max(18px, env(safe-area-inset-right)) calc(116px + env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left))' }}>
        <LastLogin record={lastLogin} />
        {children}
      </main>

      {/* Persistent "New assignment" create action — distinct from Book Now, follows you across tabs. */}
      {!onBuilder && (
        <Link href="/admin/operations/new" aria-label="New assignment" title="New assignment" data-fab
          style={{ position: 'fixed', right: 'calc(18px + env(safe-area-inset-right))', bottom: 'calc(96px + env(safe-area-inset-bottom))', zIndex: 45, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 54, height: 54, borderRadius: 999, background: 'color-mix(in srgb, var(--card) 92%, transparent)', border: '1px solid var(--line)', color: 'var(--text)', boxShadow: 'var(--os-shadow)', textDecoration: 'none' }}
          className="os-tap">
          <Plus size={24} strokeWidth={2.2} />
        </Link>
      )}

      {/* ── Mobile bottom bar — 4 destinations + raised Book Now centre + More ────── */}
      <nav aria-label="Primary" className="os-glass" data-dock="mobile"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50, display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', padding: '8px 6px calc(8px + env(safe-area-inset-bottom))', borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }}>
        {mobPrimary.slice(0, 3).map(n => {
          const Icon = iconFor(n.href); const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} aria-label={n.label} aria-current={active ? 'page' : undefined} className={`os-dock-item${active ? ' is-active' : ''}`}
              style={{ flex: 1, display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 2px', borderRadius: 14, textDecoration: 'none', color: active ? 'var(--text)' : 'var(--muted)', minWidth: 0 }}>
              <Icon size={22} strokeWidth={active ? 2.2 : 1.9} />
              <span style={{ fontSize: 10.5, fontWeight: active ? 800 : 700, whiteSpace: 'nowrap' }}>{n.label}</span>
            </Link>
          )
        })}
        {bookNow && (
          <Link href={bookNow.href} aria-label={bookNowNew > 0 ? `Book Now — ${bookNowNew} pending` : 'Book Now'}
            className="os-tap" style={{ flex: 1, display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 5, textDecoration: 'none', minWidth: 0 }}>
            <span style={{ position: 'relative', width: 52, height: 52, marginTop: -22, borderRadius: 999, background: 'var(--red)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--os-shadow)', border: '3px solid var(--bg)' }}>
              <Plus size={26} strokeWidth={2.4} />
              {bookNowNew > 0 && <span aria-hidden style={{ position: 'absolute', top: -3, right: -3, fontSize: 9.5, fontWeight: 800, background: '#fff', color: 'var(--red)', borderRadius: 999, minWidth: 17, height: 17, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--bg)' }}>{bookNowNew}</span>}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: activeHref === BOOK_NOW_HREF ? 'var(--text)' : 'var(--muted)' }}>Book Now</span>
          </Link>
        )}
        {mobPrimary.slice(3).map(n => {
          const Icon = iconFor(n.href); const active = n.href === activeHref
          return (
            <Link key={n.href} href={n.href} aria-label={n.label} aria-current={active ? 'page' : undefined} className={`os-dock-item${active ? ' is-active' : ''}`}
              style={{ flex: 1, display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 2px', borderRadius: 14, textDecoration: 'none', color: active ? 'var(--text)' : 'var(--muted)', minWidth: 0 }}>
              <Icon size={22} strokeWidth={active ? 2.2 : 1.9} />
              <span style={{ fontSize: 10.5, fontWeight: active ? 800 : 700, whiteSpace: 'nowrap' }}>{n.label}</span>
            </Link>
          )
        })}
        <button type="button" aria-label="More" aria-expanded={moreOpen} onClick={() => setMoreOpen(v => !v)}
          className={`os-dock-item os-tap${(moreOpen || activeInMobileMore) ? ' is-active' : ''}`}
          style={{ flex: 1, display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 2px', borderRadius: 14, border: 'none', cursor: 'pointer', background: 'transparent', color: (moreOpen || activeInMobileMore) ? 'var(--text)' : 'var(--muted)', minWidth: 0 }}>
          <MoreHorizontal size={22} strokeWidth={2} />
          <span style={{ fontSize: 10.5, fontWeight: 700 }}>More</span>
        </button>
      </nav>

      {/* ── Mobile More sheet — grouped, role-filtered, safe-area padded ──────────── */}
      {moreOpen && (
        <>
          <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 58, background: 'rgba(0,0,0,.45)' }} data-dock="mobile-more-overlay" />
          <div role="dialog" aria-modal="true" aria-label="More navigation" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 59, maxHeight: '82vh', overflowY: 'auto', background: 'var(--card)', borderTop: '1px solid var(--line)', borderTopLeftRadius: 20, borderTopRightRadius: 20, boxShadow: 'var(--os-shadow)', padding: '10px 16px calc(20px + env(safe-area-inset-bottom))' }} data-dock="mobile-more">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0 12px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 999, background: 'var(--line)', position: 'absolute', left: 0, right: 0, top: 8, margin: '0 auto' }} />
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 800, fontSize: 15, margin: 0 }}>More</p>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>{roleLabel}</p>
              </div>
              <button onClick={() => { setMoreOpen(false); window.dispatchEvent(new Event('jkos-open-search')) }} aria-label="Search" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 999, fontSize: 13, fontWeight: 700, color: 'var(--muted)', background: 'transparent', border: '1px solid var(--line)', cursor: 'pointer' }}><Search size={15} /> Search</button>
              <button onClick={() => setMoreOpen(false)} aria-label="Close" className="os-tap" style={{ display: 'inline-flex', padding: 9, borderRadius: 999, color: 'var(--muted)', background: 'transparent', border: '1px solid var(--line)', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            {mobGroups.map(g => (
              <div key={g.key} style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '0 0 6px 2px' }}>{g.label}</p>
                <div style={{ display: 'grid', gap: 6 }}>
                  {g.items.map(n => {
                    const active = n.href === activeHref; const Icon = iconFor(n.href); const isSync = n.href === '/admin/operations/sync'
                    return (
                      <Link key={n.href} href={n.href} onClick={() => setMoreOpen(false)} aria-current={active ? 'page' : undefined} className="os-tap"
                        style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 50, padding: '0 14px', borderRadius: 14, textDecoration: 'none', color: active ? 'var(--text)' : (isSync ? 'var(--red)' : 'var(--text)'), background: active ? 'color-mix(in srgb, #fff 9%, var(--card))' : 'color-mix(in srgb, var(--card) 90%, transparent)', border: `1px solid ${active ? 'var(--line)' : 'var(--line)'}` }}>
                        <Icon size={19} style={isSync && !active ? { color: 'var(--red)' } : undefined} /> <span style={{ fontSize: 15, fontWeight: 600 }}>{n.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
            <button onClick={() => { setMoreOpen(false); signOut() }} className="os-tap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', minHeight: 48, borderRadius: 14, marginTop: 4, color: '#ff6680', background: 'transparent', border: '1px solid rgba(224,0,42,.4)', fontSize: 14.5, fontWeight: 700, cursor: 'pointer' }}><LogOut size={16} /> Sign out</button>
          </div>
        </>
      )}

      <style>{`
        /* ≥900px: desktop top bar; below, the mobile bottom bar + sheet. */
        @media (min-width: 900px) {
          header[data-topbar] { display: block !important; }
          nav[data-dock="mobile"] { display: none !important; }
          .jkos main { --jk-main-pt: calc(94px + env(safe-area-inset-top)); padding-bottom: 40px !important; }
          [data-fab] { right: 26px !important; bottom: 26px !important; }
        }
      `}</style>
    </div>
  )
}


// Restrained active state: a filled NEUTRAL background + higher-contrast text + a thin red underline —
// never a giant red capsule (red stays a brand/notification accent).
function navItemStyle(active: boolean): React.CSSProperties {
  return active
    ? { color: 'var(--text)', background: 'color-mix(in srgb, #fff 9%, var(--card))', boxShadow: 'inset 0 -2px 0 var(--red)' }
    : { color: 'var(--muted)', background: 'transparent' }
}

const utilBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 999,
  border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
}

