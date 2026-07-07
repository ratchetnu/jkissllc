'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Building2, ChevronDown, Link2, FileText, Plus, Check, Repeat, Pencil } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { money, ymd, fmtDay, weekdaysLabel, onActivate } from '../ui'

type RouteLite = { routeNumber: string; businessName: string; status: string; routeDate: string; reportTime: string }
type Portal = { token: string; businessName: string; label?: string }
type Invoice = { token: string; invoiceNumber: string; businessName: string; status: 'draft' | 'sent' | 'paid' | 'void'; subtotalCents: number; amountPaidCents: number }
type Template = { id: string; label: string; businessName: string; reportTime: string; weekdays: number[]; defaultStaffId?: string; autoNotify: boolean; active: boolean }
type BusinessRec = { key: string; name: string; contactName?: string; contactPhone?: string; contactEmail?: string; address?: string; notes?: string; requiresHelper?: boolean }

type Biz = {
  key: string; name: string
  routeCount: number; upcoming: RouteLite[]; lastDate?: string
  portal?: Portal; invoices: Invoice[]; outstandingCents: number; templates: Template[]; record?: BusinessRec
}

const norm = (s: string) => s.trim().toLowerCase()

const INV_CHIP: Record<Invoice['status'], { fg: string; label: string }> = {
  draft: { fg: '#cbd5e1', label: 'Draft' }, sent: { fg: '#93c5fd', label: 'Sent' }, paid: { fg: '#86efac', label: 'Paid' }, void: { fg: '#94a3b8', label: 'Void' },
}

function Hub() {
  const [routes, setRoutes] = useState<RouteLite[]>([])
  const [portals, setPortals] = useState<Portal[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [records, setRecords] = useState<BusinessRec[]>([])
  const [loading, setLoading] = useState(true)
  const [openKey, setOpenKey] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, p, i, t, b] = await Promise.all([
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/client-portals', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/route-invoices', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/route-templates', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/businesses', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      setRoutes(r.items || []); setPortals(p.items || []); setInvoices(i.items || []); setTemplates(t.items || []); setRecords(b.items || [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const today = ymd(new Date())
  const businesses = useMemo<Biz[]>(() => {
    const map = new Map<string, Biz>()
    const get = (name: string) => {
      const k = norm(name)
      let b = map.get(k)
      if (!b) { b = { key: k, name: name.trim(), routeCount: 0, upcoming: [], invoices: [], outstandingCents: 0, templates: [] }; map.set(k, b) }
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
    for (const t of templates) if (t.businessName) get(t.businessName).templates.push(t)
    for (const rec of records) if (rec.name) get(rec.name).record = rec
    for (const inv of invoices) {
      if (!inv.businessName) continue
      const b = get(inv.businessName)
      b.invoices.push(inv)
      if (inv.status !== 'paid' && inv.status !== 'void') b.outstandingCents += inv.subtotalCents - inv.amountPaidCents
    }
    for (const b of map.values()) b.upcoming.sort((a, c) => a.routeDate.localeCompare(c.routeDate))
    return [...map.values()].sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || a.name.localeCompare(b.name))
  }, [routes, portals, invoices, templates, records, today])

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
          {businesses.map((b, i) => <BizCard key={b.key} b={b} open={openKey === b.key} onToggle={() => setOpenKey(o => o === b.key ? '' : b.key)} onOpen={() => setOpenKey(b.key)} onCreatePortal={() => createPortal(b.name)} onReload={load} setMsg={setMsg} delay={i} />)}
        </div>
      )}
    </div>
  )
}

const miniBtn: React.CSSProperties = { padding: '5px 11px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }
const bf: React.CSSProperties = { width: '100%', padding: '10px 12px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 11, color: 'var(--text)', fontSize: 14, outline: 'none' }

function BusinessForm({ b, onDone, onCancel }: { b: Biz; onDone: () => void; onCancel: () => void }) {
  const r = b.record
  const [contactName, setContactName] = useState(r?.contactName || '')
  const [contactPhone, setContactPhone] = useState(r?.contactPhone || '')
  const [contactEmail, setContactEmail] = useState(r?.contactEmail || '')
  const [address, setAddress] = useState(r?.address || '')
  const [notes, setNotes] = useState(r?.notes || '')
  const [requiresHelper, setRequiresHelper] = useState(!!r?.requiresHelper)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  async function save() {
    setSaving(true); setErr('')
    try {
      const res = await fetch('/api/admin/businesses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ name: b.name, contactName, contactPhone, contactEmail, address, notes, requiresHelper }) })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save.'); return }
      onDone()
    } catch { setErr('Network error.') } finally { setSaving(false) }
  }
  return (
    <div>
      <p style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>Edit {b.name}</p>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Saved contact details show here and can prefill future work.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <input placeholder="Contact name" value={contactName} onChange={e => setContactName(e.target.value)} style={bf} />
        <input placeholder="Contact phone" value={contactPhone} onChange={e => setContactPhone(e.target.value)} style={bf} />
      </div>
      <input placeholder="Contact email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} style={{ ...bf, marginTop: 10 }} />
      <input placeholder="Address" value={address} onChange={e => setAddress(e.target.value)} style={{ ...bf, marginTop: 10 }} />
      <textarea placeholder="Notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...bf, marginTop: 10, resize: 'vertical' }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 12, padding: '11px 13px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', cursor: 'pointer' }}>
        <button type="button" role="switch" aria-checked={requiresHelper} onClick={() => setRequiresHelper(v => !v)} className="os-tap" style={{ width: 46, height: 28, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 3, background: requiresHelper ? 'var(--red)' : 'rgba(255,255,255,.14)', flexShrink: 0 }}>
          <span style={{ display: 'block', width: 22, height: 22, borderRadius: 999, background: '#fff', transform: requiresHelper ? 'translateX(18px)' : 'translateX(0)', transition: 'transform .2s var(--os-spring)' }} />
        </button>
        <div><div style={{ fontSize: 13.5, fontWeight: 700 }}>Routes need a driver + helper</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Flags this client’s routes until both roles are assigned.</div></div>
      </label>
      {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button onClick={save} disabled={saving} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center' }}>{saving ? 'Saving…' : 'Save changes'}</button>
        <button onClick={onCancel} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
      </div>
    </div>
  )
}

function BizCard({ b, open, onToggle, onOpen, onCreatePortal, onReload, setMsg, delay }: { b: Biz; open: boolean; onToggle: () => void; onOpen: () => void; onCreatePortal: () => void; onReload: () => void; setMsg: (m: string) => void; delay: number }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const rec = b.record
  const activeTmpl = b.templates.find(t => t.active)
  function copyPortal() { if (b.portal) { navigator.clipboard?.writeText(`${location.origin}/client/${b.portal.token}`); setMsg('Client portal link copied.') } }

  async function tmpl(id: string, body: Record<string, unknown> | null) {
    setBusy(id)
    try {
      if (body === null) await fetch(`/api/admin/route-templates/${id}`, { method: 'DELETE', credentials: 'same-origin' })
      else { const d = await fetch(`/api/admin/route-templates/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }).then(r => r.json()); if (body.action === 'generate') setMsg(d.created?.length ? `Generated ${d.created.length} route(s).` : 'Upcoming dates already generated.') }
      onReload()
    } finally { setBusy('') }
  }

  return (
    <div className="os-card os-rise" style={{ overflow: 'hidden', animationDelay: `${Math.min(delay * 40, 200)}ms` }}>
      <div onClick={onToggle} onKeyDown={onActivate(onToggle)} role="button" tabIndex={0} aria-expanded={open} className="os-tap" style={{ cursor: 'pointer', padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)' }}><Building2 size={22} style={{ color: 'var(--red-glow)' }} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{b.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{b.routeCount} routes</span>
            {b.upcoming.length > 0 && <span style={{ color: '#93c5fd' }}>{b.upcoming.length} upcoming</span>}
            {activeTmpl && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#c4b5fd' }}><Repeat size={11} /> {weekdaysLabel(activeTmpl.weekdays)}</span>}
            {b.outstandingCents > 0 && <span style={{ color: '#fcd34d' }}>{money(b.outstandingCents)} due</span>}
            {b.portal && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#86efac' }}><Check size={11} /> portal</span>}
            {b.record?.requiresHelper && <span style={{ color: '#c4b5fd' }}>driver + helper</span>}
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onOpen(); setEditing(true) }} aria-label={`Edit ${b.name}`} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}><Pencil size={15} /></button>
        <ChevronDown size={19} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .3s var(--os-ease)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>

      <div className={`os-expand${open ? ' open' : ''}`}>
        <div><div style={{ padding: '0 15px 16px' }}>
          <div style={{ height: 1, background: 'var(--line)', marginBottom: 14 }} />

          {editing ? <BusinessForm b={b} onDone={() => { setEditing(false); setMsg('Business saved.'); onReload() }} onCancel={() => setEditing(false)} /> : <>

          {rec && (rec.contactName || rec.contactPhone || rec.contactEmail || rec.address || rec.notes) && (
            <div style={{ marginBottom: 14, fontSize: 13.5 }}>
              {rec.contactName && <div style={{ fontWeight: 600 }}>{rec.contactName}{rec.contactPhone ? ` · ${rec.contactPhone}` : ''}</div>}
              {rec.contactEmail && <div style={{ color: 'var(--muted)' }}>{rec.contactEmail}</div>}
              {rec.address && <div style={{ color: 'var(--muted)' }}>{rec.address}</div>}
              {rec.notes && <div style={{ color: 'var(--muted)', marginTop: 4 }}>{rec.notes}</div>}
            </div>
          )}

          {b.templates.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Recurring contracts</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {b.templates.map(t => (
                  <div key={t.id} style={{ padding: 11, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', opacity: busy === t.id ? .6 : 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Repeat size={13} style={{ color: '#c4b5fd' }} />
                      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{weekdaysLabel(t.weekdays)}</span>
                      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>· {t.reportTime}</span>
                      {!t.active && <span style={{ fontSize: 11, color: '#fca5a5', fontWeight: 700 }}>paused</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      <button onClick={() => tmpl(t.id, { action: 'generate', horizonDays: 14 })} disabled={busy === t.id} style={{ ...miniBtn, color: '#86efac' }}>Generate now</button>
                      <button onClick={() => tmpl(t.id, { action: 'toggle' })} disabled={busy === t.id} style={miniBtn}>{t.active ? 'Pause' : 'Resume'}</button>
                      <button onClick={() => { if (confirm('Delete this recurring contract? Routes already generated stay.')) tmpl(t.id, null) }} disabled={busy === t.id} style={{ ...miniBtn, color: '#f87171' }}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
            <button onClick={() => setEditing(true)} className="btn-ghost os-tap" style={{ borderRadius: 10, height: 38, fontSize: 13 }}><Pencil size={14} /> Edit business</button>
            <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 10, height: 38, fontSize: 13 }}><Plus size={15} /> New assignment</Link>
            <Link href="/admin/routes/invoices" className="btn-ghost os-tap" style={{ borderRadius: 10, height: 38, fontSize: 13 }}><FileText size={15} /> Invoices</Link>
          </div>
          </>}
        </div></div>
      </div>
    </div>
  )
}

export default function BusinessesPage() {
  return <OperationsShell><Hub /></OperationsShell>
}
