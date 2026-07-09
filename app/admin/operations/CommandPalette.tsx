'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Plus, Home, ClipboardList, Users, Building2, Settings, ArrowRight, User, Briefcase, Rocket } from 'lucide-react'
import { fmtDay } from './ui'

type Op = { token: string; routeNumber: string; businessName: string; status: string; routeDate: string; reportTime: string; assignedStaffName?: string }
type Staff = { id: string; name: string; role?: string; active: boolean }

type Item = { id: string; label: string; sub?: string; Icon: typeof Search; href: string; group: string }

const ACTIONS: Item[] = [
  { id: 'a-new', label: 'New assignment', sub: 'Create a route', Icon: Plus, href: '/admin/operations/new', group: 'Actions' },
  { id: 'a-home', label: 'Home', Icon: Home, href: '/admin/operations', group: 'Go to' },
  { id: 'a-ops', label: 'Operations', Icon: ClipboardList, href: '/admin/operations/list', group: 'Go to' },
  { id: 'a-emp', label: 'Employees', Icon: Users, href: '/admin/operations/employees', group: 'Go to' },
  { id: 'a-biz', label: 'Businesses', Icon: Building2, href: '/admin/operations/businesses', group: 'Go to' },
  { id: 'a-set', label: 'Settings', Icon: Settings, href: '/admin/operations/settings', group: 'Go to' },
  { id: 'a-ops-wl', label: 'OpsPilot Waitlist', sub: 'Early-access requests', Icon: Rocket, href: '/admin/opspilot', group: 'Go to' },
]

export default function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [ops, setOps] = useState<Op[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Global ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o) }
      else if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Expose an opener for the shell's search button.
  useEffect(() => {
    const opener = () => setOpen(true)
    window.addEventListener('jkos-open-search', opener)
    return () => window.removeEventListener('jkos-open-search', opener)
  }, [])

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()).catch(() => ({})),
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()).catch(() => ({})),
      ])
      setOps(r.items || []); setStaff(s.items || [])
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { if (open) { load(); setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 30) } }, [open, load])

  const businesses = useMemo(() => [...new Set(ops.map(o => o.businessName).filter(Boolean))], [ops])

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase()
    const list: Item[] = []
    // Actions always available; filtered by query.
    for (const a of ACTIONS) if (!query || a.label.toLowerCase().includes(query)) list.push(a)
    if (query) {
      for (const b of businesses.filter(b => b.toLowerCase().includes(query)).slice(0, 5))
        list.push({ id: `b-${b}`, label: b, sub: 'Business', Icon: Building2, href: '/admin/operations/businesses', group: 'Businesses' })
      for (const s of staff.filter(s => s.name.toLowerCase().includes(query)).slice(0, 5))
        list.push({ id: `s-${s.id}`, label: s.name, sub: s.role || 'Contractor', Icon: User, href: '/admin/operations/employees', group: 'Employees' })
      for (const o of ops.filter(o => o.businessName.toLowerCase().includes(query) || o.routeNumber.toLowerCase().includes(query) || (o.assignedStaffName || '').toLowerCase().includes(query)).slice(0, 8))
        list.push({ id: `o-${o.token}`, label: `${o.businessName} · ${o.routeNumber}`, sub: `${fmtDay(o.routeDate)} · ${o.reportTime}${o.assignedStaffName ? ` · ${o.assignedStaffName}` : ''}`, Icon: Briefcase, href: `/admin/operations/${o.token}`, group: 'Operations' })
    }
    return list
  }, [q, ops, staff, businesses])

  useEffect(() => { if (active >= items.length) setActive(Math.max(0, items.length - 1)) }, [items, active])

  function go(item?: Item) { const t = item || items[active]; if (!t) return; setOpen(false); router.push(t.href) }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go() }
  }

  if (!open) return null

  let lastGroup = ''
  return (
    <div onMouseDown={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(3px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '12vh 16px 16px' }}>
      <div onMouseDown={e => e.stopPropagation()} className="os-rise" style={{ width: '100%', maxWidth: 560, borderRadius: 18, overflow: 'hidden', background: 'rgba(18,18,20,0.99)', border: '1px solid rgba(255,255,255,.14)', boxShadow: '0 24px 70px rgba(0,0,0,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <Search size={19} style={{ color: 'var(--muted)' }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder="Search operations, employees, businesses…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 16 }} />
          <kbd style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 6px' }}>esc</kbd>
        </div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: 6 }}>
          {items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>No matches.</div>
          ) : items.map((it, i) => {
            const showGroup = it.group !== lastGroup; lastGroup = it.group
            return (
              <div key={it.id}>
                {showGroup && <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', padding: '10px 12px 4px' }}>{it.group}</div>}
                <button onMouseEnter={() => setActive(i)} onClick={() => go(it)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 11, border: 'none', cursor: 'pointer', textAlign: 'left', background: i === active ? 'rgba(255,255,255,.08)' : 'transparent', color: 'var(--text)' }}>
                  <it.Icon size={17} style={{ color: 'var(--red-glow)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</div>
                    {it.sub && <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</div>}
                  </div>
                  {i === active && <ArrowRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
