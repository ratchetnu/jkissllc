'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Building2, ChevronDown, Link2, FileText, Plus, Check } from 'lucide-react'
import OperationsShell from '../OperationsShell'

type RouteLite = { routeNumber: string; businessName: string; status: string; routeDate: string; reportTime: string }
type Portal = { token: string; businessName: string; label?: string }
type Invoice = { token: string; invoiceNumber: string; businessName: string; status: 'draft' | 'sent' | 'paid' | 'void'; subtotalCents: number; amountPaidCents: number }

type Biz = {
  key: string; name: string
  routeCount: number; upcoming: RouteLite[]; lastDate?: string
  portal?: Portal; invoices: Invoice[]; outstandingCents: number
}

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtDay = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) }
const norm = (s: string) => s.trim().toLowerCase()

const INV_CHIP: Record<Invoice['status'], { fg: string; label: string }> = {
  draft: { fg: '#cbd5e1', label: 'Draft' }, sent: { fg: '#93c5fd', label: 'Sent' }, paid: { fg: '#86efac', label: 'Paid' }, void: { fg: '#94a3b8', label: 'Void' },
}

function Hub() {
  const [routes, setRoutes] = useState<RouteLite[]>([])
  const [portals, setPortals] = useState<Portal[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [openKey, setOpenKey] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, p, i] = await Promise.all([
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/client-portals', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/route-invoices', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      setRoutes(r.items || []); setPortals(p.items || []); setInvoices(i.items || [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const today = ymd(new Date())
  const businesses = useMemo<Biz[]>(() => {
    const map = new Map<string, Biz>()
    const get = (name: string) => {
      const k = norm(name)
      let b = map.get(k)
      if (!b) { b = { key: k, name: name.trim(), routeCount: 0, upcoming: [], invoices: [], outstandingCents: 0 }; map.set(k, b) }
      return b
    }
    for (const r of routes) {
      if (!r.businessName) continue
      const b = get(r.businessName)
      if (r.status !== 'cancelled') b.routeCount++
      if (!b.lastDate || r.routeDate > b.lastDate) b.lastDate = r.routeDate
      if (['assigned', 'text_sent', 'confirmed', 'draft'].includes(r.status) && r.routeDate >= today) b.upcoming.push(r)
    }
    for (const p of portals) if (p.businessName) { const b = get(p.businessName); b.portal = p }
    for (const inv of invoices) {
      if (!inv.businessName) continue
      const b = get(inv.businessName)
      b.invoices.push(inv)
      if (inv.status !== 'paid' && inv.status !== 'void') b.outstandingCents += inv.subtotalCents - inv.amountPaidCents
    }
    for (const b of map.values()) b.upcoming.sort((a, c) => a.routeDate.localeCompare(c.routeDate))
    return [...map.values()].sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || a.name.localeCompare(b.name))
  }, [routes, portals, invoices, today])

  async function createPortal(name: string) {
    try {
      const res = await fetch('/api/admin/client-portals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ businessName: name }) })
      const d = await res.json()
      if (res.ok) { setMsg('Client portal created — copy the link to share.'); load() } else setMsg(d.error || 'Could not create portal.')
    } catch { setMsg('Network error.') }
  }

  return (
    <div>
      <div className="os-rise" style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>{businesses.length} {businesses.length === 1 ? 'client' : 'clients'}</p>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Businesses</h1>
      </div>

      {msg && <div className="os-card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13.5, color: '#86efac' }}>{msg}</div>}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 16, display: 'flex', gap: 13, alignItems: 'center' }}><div className="skeleton" style={{ width: 46, height: 46, borderRadius: 12 }} /><div style={{ flex: 1 }}><div className="skeleton" style={{ width: '45%', height: 15, borderRadius: 7 }} /><div className="skeleton" style={{ width: '30%', height: 11, borderRadius: 6, marginTop: 8 }} /></div></div>)}</div>
      ) : businesses.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <p className="jkos-h" style={{ fontSize: 18 }}>No clients yet</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>Businesses appear here once you create routes for them.</p>
          <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, marginTop: 18, display: 'inline-flex' }}><Plus size={16} /> New assignment</Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {businesses.map((b, i) => <BizCard key={b.key} b={b} open={openKey === b.key} onToggle={() => setOpenKey(o => o === b.key ? '' : b.key)} onCreatePortal={() => createPortal(b.name)} setMsg={setMsg} delay={i} />)}
        </div>
      )}
    </div>
  )
}

function BizCard({ b, open, onToggle, onCreatePortal, setMsg, delay }: { b: Biz; open: boolean; onToggle: () => void; onCreatePortal: () => void; setMsg: (m: string) => void; delay: number }) {
  function copyPortal() { if (b.portal) { navigator.clipboard?.writeText(`${location.origin}/client/${b.portal.token}`); setMsg('Client portal link copied.') } }
  return (
    <div className="os-card os-rise" style={{ overflow: 'hidden', animationDelay: `${Math.min(delay * 40, 200)}ms` }}>
      <button onClick={onToggle} className="os-tap" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)' }}><Building2 size={22} style={{ color: 'var(--red-glow)' }} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{b.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{b.routeCount} routes</span>
            {b.upcoming.length > 0 && <span style={{ color: '#93c5fd' }}>{b.upcoming.length} upcoming</span>}
            {b.outstandingCents > 0 && <span style={{ color: '#fcd34d' }}>{money(b.outstandingCents)} due</span>}
            {b.portal && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#86efac' }}><Check size={11} /> portal</span>}
          </div>
        </div>
        <ChevronDown size={19} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .3s var(--os-ease)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      <div className={`os-expand${open ? ' open' : ''}`}>
        <div><div style={{ padding: '0 15px 16px' }}>
          <div style={{ height: 1, background: 'var(--line)', marginBottom: 14 }} />

          {b.upcoming.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Upcoming routes</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {b.upcoming.slice(0, 6).map(r => (
                  <div key={r.routeNumber} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                    <span style={{ minWidth: 66, color: 'var(--muted)' }}>{fmtDay(r.routeDate)}</span>
                    <span style={{ flex: 1 }}>{r.reportTime}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{r.routeNumber}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {b.invoices.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Invoices</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {b.invoices.slice(0, 6).map(inv => (
                  <div key={inv.token} style={{ display: 'flex', gap: 10, fontSize: 13, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)', minWidth: 80 }}>{inv.invoiceNumber}</span>
                    <span style={{ color: INV_CHIP[inv.status].fg, fontWeight: 700, fontSize: 11.5 }}>{INV_CHIP[inv.status].label}</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{money(inv.subtotalCents)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Portal */}
          <div style={{ marginBottom: 14, padding: 12, borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Client portal</div>
            {b.portal ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>A read-only schedule link is active for this client.</span>
                <button onClick={copyPortal} className="os-tap" style={{ padding: '6px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: '#86efac', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Link2 size={13} /> Copy link</button>
              </div>
            ) : (
              <button onClick={onCreatePortal} className="os-tap" style={{ padding: '7px 13px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Create client portal</button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 10, height: 38, fontSize: 13 }}><Plus size={15} /> New assignment</Link>
            <Link href="/admin/routes/invoices" className="btn-ghost os-tap" style={{ borderRadius: 10, height: 38, fontSize: 13 }}><FileText size={15} /> Invoices</Link>
          </div>
        </div></div>
      </div>
    </div>
  )
}

export default function BusinessesPage() {
  return <OperationsShell><Hub /></OperationsShell>
}
