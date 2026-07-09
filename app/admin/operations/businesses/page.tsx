'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Building2, ChevronDown, Link2, FileText, Plus, Check, Repeat, Pencil, Wallet, History, CalendarClock } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { money, ymd, fmtDay, fmtTs, weekdaysLabel, onActivate, MoneyInput, Toggle, centsToInput, looksLikeMoney, osLabel, DOW, Avatar } from '../ui'
import ApplyScope from '../ApplyScope'
import ClaimsHistory from '../claims/ClaimsHistory'

type RouteLite = { routeNumber: string; businessName: string; status: string; routeDate: string; reportTime: string }
type Portal = { token: string; businessName: string; label?: string }
type Invoice = { token: string; invoiceNumber: string; businessName: string; status: 'draft' | 'sent' | 'paid' | 'void'; subtotalCents: number; amountPaidCents: number }
type Staff = { id: string; name: string; role?: string; active: boolean; photoUrl?: string }
// crewByWeekday keys are weekday numbers as strings ("1"=Mon), matching the server.
type Template = {
  id: string; label: string; businessName: string; reportAddress?: string; reportTime: string
  weekdays: number[]; crewByWeekday?: Record<string, string[]>; defaultStaffId?: string; active: boolean
}
type RateHistoryEntry = { at: number; contractRateCents?: number; effectiveDate?: string; active: boolean; notes?: string }
type BusinessRec = {
  key: string; name: string; contactName?: string; contactPhone?: string; contactEmail?: string; address?: string; notes?: string; requiresHelper?: boolean
  contractRateCents?: number; billingNotes?: string; rateEffectiveDate?: string; pricingActive?: boolean; rateHistory?: RateHistoryEntry[]
}

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
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [openKey, setOpenKey] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, p, i, t, b, s] = await Promise.all([
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/client-portals', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/route-invoices', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/route-templates', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/businesses', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      setRoutes(r.items || []); setPortals(p.items || []); setInvoices(i.items || []); setTemplates(t.items || []); setRecords(b.items || []); setStaff((s.items || []).filter((x: Staff) => x.active))
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
          {businesses.map((b, i) => <BizCard key={b.key} b={b} staff={staff} open={openKey === b.key} onToggle={() => setOpenKey(o => o === b.key ? '' : b.key)} onOpen={() => setOpenKey(b.key)} onCreatePortal={() => createPortal(b.name)} onReload={load} setMsg={setMsg} delay={i} />)}
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

// ── Route Pricing ────────────────────────────────────────────────────────────
// What this business pays J KISS per route. Snapshotted onto each route when it's
// created, so editing here never rewrites routes that already ran.
function RoutePricing({ b, onReload, setMsg }: { b: Biz; onReload: () => void; setMsg: (m: string) => void }) {
  const rec = b.record
  const [editing, setEditing] = useState(false)
  const [rate, setRate] = useState(centsToInput(rec?.contractRateCents))
  const [active, setActive] = useState(rec?.pricingActive ?? true)
  const [effective, setEffective] = useState(rec?.rateEffectiveDate || '')
  const [notes, setNotes] = useState(rec?.billingNotes || '')
  const [scope, setScope] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  const original = centsToInput(rec?.contractRateCents)
  const rateInvalid = rate.trim() !== '' && !looksLikeMoney(rate)
  const rateChanged = rate.trim() !== original.trim() || active !== (rec?.pricingActive ?? true)

  function reset() {
    setRate(centsToInput(rec?.contractRateCents)); setActive(rec?.pricingActive ?? true)
    setEffective(rec?.rateEffectiveDate || ''); setNotes(rec?.billingNotes || '')
    setEditing(false); setScope(false); setErr('')
  }

  async function save(applyTo: 'none' | 'future' | 'selected' = 'none', routeTokens: string[] = []) {
    if (rateInvalid) { setErr('Enter a positive dollar amount, e.g. 350 or 350.00.'); return }
    if (active && !rate.trim()) { setErr('Set a route price, or switch this pricing off.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/admin/businesses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({
          name: b.name,
          // Carry the other fields through — this endpoint upserts the whole record.
          contactName: rec?.contactName, contactPhone: rec?.contactPhone, contactEmail: rec?.contactEmail,
          address: rec?.address, notes: rec?.notes, requiresHelper: rec?.requiresHelper,
          contractRate: rate.trim(), pricingActive: active, rateEffectiveDate: effective || undefined, billingNotes: notes,
          applyTo, routeTokens,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save the price.'); return }
      const n = d.reprice?.updated?.length ?? 0
      setMsg(n > 0 ? `Price saved — ${n} upcoming route${n === 1 ? '' : 's'} re-priced.` : 'Route price saved.')
      setEditing(false); setScope(false); onReload()
    } catch { setErr('Network error.') } finally { setBusy(false) }
  }

  // A rate change forces the "what does this apply to?" question. A notes-only or
  // effective-date-only edit saves straight through.
  function onSave() {
    if (rateInvalid) { setErr('Enter a positive dollar amount, e.g. 350 or 350.00.'); return }
    if (rateChanged && (b.upcoming.length > 0)) setScope(true)
    else save('none')
  }

  const history = [...(rec?.rateHistory ?? [])].reverse()

  return (
    <div style={{ marginBottom: 14, padding: 13, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: editing ? 12 : 8 }}>
        <Wallet size={14} style={{ color: 'var(--red-glow)' }} />
        <div style={{ ...osLabel, flex: 1 }}>Route pricing</div>
        {!editing && <button onClick={() => setEditing(true)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>}
      </div>

      {!editing ? (
        <>
          {rec?.contractRateCents == null ? (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>No contract rate set. Routes for this client won&rsquo;t show revenue or profit.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
              <span className="tabular-nums" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', color: rec.pricingActive === false ? 'var(--muted)' : 'var(--text)' }}>{money(rec.contractRateCents)}</span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>per route</span>
              {rec.pricingActive === false && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Inactive</span>}
            </div>
          )}
          {rec?.rateEffectiveDate && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Effective {fmtDay(rec.rateEffectiveDate)}</div>}
          {rec?.billingNotes && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>{rec.billingNotes}</div>}

          {history.length > 0 && (
            <>
              <button onClick={() => setShowHistory(h => !h)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <History size={12} /> {showHistory ? 'Hide' : 'Pricing'} history ({history.length})
              </button>
              {showHistory && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                  {history.map((h, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'center' }}>
                      <span style={{ color: 'var(--muted)', minWidth: 100 }}>{fmtTs(h.at)}</span>
                      <span className="tabular-nums" style={{ fontWeight: 700 }}>{h.contractRateCents == null ? 'cleared' : money(h.contractRateCents)}</span>
                      {!h.active && <span style={{ color: 'var(--muted)' }}>· inactive</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Charge per route</div>
              <MoneyInput value={rate} onChange={setRate} invalid={rateInvalid} aria-label="Charge per route" disabled={busy} />
            </div>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Effective date</div>
              <input type="date" value={effective} onChange={e => setEffective(e.target.value)} style={bf} />
            </div>
          </div>
          <textarea placeholder="Billing notes (e.g. net-30, invoiced monthly)" value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...bf, marginTop: 10, resize: 'vertical' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 10, padding: '10px 12px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
            <Toggle on={active} onChange={setActive} label="Pricing active" />
            <div><div style={{ fontSize: 13.5, fontWeight: 700 }}>Pricing active</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Off = rate kept on file but not applied to new routes.</div></div>
          </label>
          {rateInvalid && <p style={{ color: '#f87171', fontSize: 12.5, marginTop: 8 }}>Enter a positive dollar amount, e.g. 350 or 350.00.</p>}
          {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{err}</p>}

          {scope ? (
            <ApplyScope
              candidatesUrl={`/api/admin/businesses?candidates=${encodeURIComponent(b.name)}`}
              mode="price" busy={busy}
              onCancel={() => setScope(false)}
              onConfirm={({ applyTo, routeTokens }) => save(applyTo, routeTokens)}
            />
          ) : (
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button onClick={onSave} disabled={busy || rateInvalid} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center', opacity: busy || rateInvalid ? .55 : 1 }}>{busy ? 'Saving…' : 'Save price'}</button>
              <button onClick={reset} disabled={busy} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Mon-first business week. 0=Sun sits last so a normal work week reads naturally.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

// Edit (or create) one recurring contract: which weekdays it runs, and the standing
// crew for EACH day. Saves through the existing route-templates API — create = POST,
// edit = PATCH {action:'update'} (which drops a day's crew when the day is removed).
// Saving a schedule never texts anyone; routes are generated separately.
function ScheduleEditor({ mode, biz, tmpl, staff, onDone, onCancel, setMsg }: {
  mode: 'create' | 'edit'; biz: Biz; tmpl?: Template; staff: Staff[]
  onDone: () => void; onCancel: () => void; setMsg: (m: string) => void
}) {
  const [days, setDays] = useState<Set<number>>(() => new Set(tmpl?.weekdays ?? []))
  const [crew, setCrew] = useState<Record<string, string[]>>(() => ({ ...(tmpl?.crewByWeekday ?? {}) }))
  const [reportTime, setReportTime] = useState(tmpl?.reportTime ?? '')
  const [reportAddress, setReportAddress] = useState(tmpl?.reportAddress ?? biz.record?.address ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function toggleDay(d: number) {
    setDays(prev => {
      const next = new Set(prev)
      if (next.has(d)) { next.delete(d); setCrew(c => Object.fromEntries(Object.entries(c).filter(([k]) => k !== String(d)))) }
      else next.add(d)
      return next
    })
  }
  function toggleCrew(d: number, staffId: string) {
    setCrew(prev => {
      const cur = prev[String(d)] ?? []
      const next = cur.includes(staffId) ? cur.filter(x => x !== staffId) : [...cur, staffId]
      return { ...prev, [String(d)]: next }
    })
  }

  async function save() {
    setErr('')
    if (days.size === 0) { setErr('Pick at least one day of the week.'); return }
    if (!reportTime.trim()) { setErr('Report time is required (e.g. 8:00 AM).'); return }
    if (mode === 'create' && !reportAddress.trim()) { setErr('Report address is required.'); return }
    // Only send crew for days that still run, and only non-empty crews.
    const weekdays = [...days].sort((a, b) => a - b)
    const crewByWeekday: Record<string, string[]> = {}
    for (const d of weekdays) { const ids = (crew[String(d)] ?? []).filter(Boolean); if (ids.length) crewByWeekday[String(d)] = ids }

    setSaving(true)
    try {
      if (mode === 'create') {
        const res = await fetch('/api/admin/route-templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ businessName: biz.name, reportAddress: reportAddress.trim(), reportTime: reportTime.trim(), weekdays, crewByWeekday }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setErr(d.error || 'Could not create schedule.'); setSaving(false); return }
        setMsg('Recurring schedule created.')
      } else {
        const res = await fetch(`/api/admin/route-templates/${tmpl!.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ action: 'update', weekdays, crewByWeekday, reportTime: reportTime.trim(), reportAddress: reportAddress.trim() || undefined }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setErr(d.error || 'Could not save schedule.'); setSaving(false); return }
        setMsg('Schedule saved.')
      }
      onDone()
    } catch { setErr('Network error — please try again.'); setSaving(false) }
  }

  return (
    <div style={{ padding: 13, borderRadius: 10, background: 'rgba(196,181,253,.06)', border: '1px solid rgba(196,181,253,.28)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        <CalendarClock size={15} style={{ color: '#c4b5fd' }} />
        <span style={{ fontWeight: 800, fontSize: 13.5 }}>{mode === 'create' ? 'New recurring schedule' : 'Edit recurring schedule'}</span>
      </div>

      {/* Which weekdays this business runs */}
      <div style={osLabel as React.CSSProperties}>Runs on</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '7px 0 14px' }}>
        {WEEK_ORDER.map(d => {
          const on = days.has(d)
          return (
            <button key={d} type="button" onClick={() => toggleDay(d)} className="os-tap"
              style={{ minWidth: 46, padding: '9px 0', borderRadius: 10, fontSize: 12.5, fontWeight: 800, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
              {DOW[d]}
            </button>
          )
        })}
      </div>

      {/* Report time + address (shared by every generated route) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8, marginBottom: 14 }}>
        <div>
          <div style={osLabel as React.CSSProperties}>Report time</div>
          <input value={reportTime} onChange={e => setReportTime(e.target.value)} placeholder="8:00 AM" style={{ ...bf, marginTop: 5 }} />
        </div>
        <div>
          <div style={osLabel as React.CSSProperties}>Report address</div>
          <input value={reportAddress} onChange={e => setReportAddress(e.target.value)} placeholder="Where crew reports" style={{ ...bf, marginTop: 5 }} />
        </div>
      </div>

      {/* Crew for each running day */}
      {days.size > 0 && staff.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={osLabel as React.CSSProperties}>Crew for each day</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 7 }}>
            {WEEK_ORDER.filter(d => days.has(d)).map(d => (
              <div key={d}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 5 }}>{DOW[d]}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {staff.map(s => {
                    const on = (crew[String(d)] ?? []).includes(s.id)
                    return (
                      <button key={s.id} type="button" onClick={() => toggleCrew(d, s.id)} className="os-tap"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px 5px 5px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'rgba(224,0,42,.14)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
                        <Avatar name={s.name} photoUrl={s.photoUrl} size={22} />
                        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{s.name}</span>
                        {on && <Check size={12} />}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {days.size > 0 && staff.length === 0 && (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>No active crew yet — add crew under Employees, then assign them here.</p>
      )}

      {err && <p style={{ color: '#f87171', fontSize: 12.5, marginBottom: 10 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={saving} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center', opacity: saving ? .6 : 1 }}>{saving ? 'Saving…' : mode === 'create' ? 'Create schedule' : 'Save schedule'}</button>
        <button onClick={onCancel} disabled={saving} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
      </div>
    </div>
  )
}

function BizCard({ b, staff, open, onToggle, onOpen, onCreatePortal, onReload, setMsg, delay }: { b: Biz; staff: Staff[]; open: boolean; onToggle: () => void; onOpen: () => void; onCreatePortal: () => void; onReload: () => void; setMsg: (m: string) => void; delay: number }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  // Which recurring contract's schedule is being edited ('' = none, 'new' = create).
  const [schedFor, setSchedFor] = useState('')
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
            {b.record?.contractRateCents != null && b.record.pricingActive !== false && <span className="tabular-nums" style={{ color: '#86efac', fontWeight: 700 }}>{money(b.record.contractRateCents)}/route</span>}
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

          <RoutePricing b={b} onReload={onReload} setMsg={setMsg} />

          {rec && (rec.contactName || rec.contactPhone || rec.contactEmail || rec.address || rec.notes) && (
            <div style={{ marginBottom: 14, fontSize: 13.5 }}>
              {rec.contactName && <div style={{ fontWeight: 600 }}>{rec.contactName}{rec.contactPhone ? ` · ${rec.contactPhone}` : ''}</div>}
              {rec.contactEmail && <div style={{ color: 'var(--muted)' }}>{rec.contactEmail}</div>}
              {rec.address && <div style={{ color: 'var(--muted)' }}>{rec.address}</div>}
              {rec.notes && <div style={{ color: 'var(--muted)', marginTop: 4 }}>{rec.notes}</div>}
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>Recurring schedule</div>
              {schedFor !== 'new' && (
                <button onClick={() => setSchedFor('new')} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><Plus size={13} /> Add schedule</button>
              )}
            </div>

            {schedFor === 'new' && (
              <ScheduleEditor mode="create" biz={b} staff={staff} onDone={() => { setSchedFor(''); onReload() }} onCancel={() => setSchedFor('')} setMsg={setMsg} />
            )}

            {b.templates.length === 0 && schedFor !== 'new' && (
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>No recurring schedule yet. Add one to set which weekdays this business runs and the crew for each day — routes then generate automatically.</p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {b.templates.map(t => schedFor === t.id ? (
                <ScheduleEditor key={t.id} mode="edit" biz={b} tmpl={t} staff={staff} onDone={() => { setSchedFor(''); onReload() }} onCancel={() => setSchedFor('')} setMsg={setMsg} />
              ) : (
                <div key={t.id} style={{ padding: 11, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', opacity: busy === t.id ? .6 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Repeat size={13} style={{ color: '#c4b5fd' }} />
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>{weekdaysLabel(t.weekdays)}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>· {t.reportTime}</span>
                    {!t.active && <span style={{ fontSize: 11, color: '#fca5a5', fontWeight: 700 }}>paused</span>}
                  </div>
                  {/* Per-day crew, so the owner sees who runs each day at a glance. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 }}>
                    {[...t.weekdays].sort((a, c) => a - c).map(d => {
                      const ids = t.crewByWeekday?.[String(d)] ?? []
                      const names = ids.map(id => staff.find(s => s.id === id)?.name).filter(Boolean)
                      return (
                        <div key={d} style={{ display: 'flex', gap: 8, fontSize: 12.5 }}>
                          <span style={{ minWidth: 34, fontWeight: 700, color: 'var(--muted)' }}>{DOW[d]}</span>
                          <span style={{ color: names.length ? 'var(--text)' : 'var(--muted)' }}>{names.length ? names.join(', ') : 'no crew set'}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    <button onClick={() => setSchedFor(t.id)} disabled={busy === t.id} style={{ ...miniBtn, color: '#c4b5fd' }}><Pencil size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />Edit schedule</button>
                    <button onClick={() => tmpl(t.id, { action: 'generate', horizonDays: 14 })} disabled={busy === t.id} style={{ ...miniBtn, color: '#86efac' }}>Generate now</button>
                    <button onClick={() => tmpl(t.id, { action: 'toggle' })} disabled={busy === t.id} style={miniBtn}>{t.active ? 'Pause' : 'Resume'}</button>
                    <button onClick={() => { if (confirm('Delete this recurring contract? Routes already generated stay.')) tmpl(t.id, null) }} disabled={busy === t.id} style={{ ...miniBtn, color: '#f87171' }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

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

          <ClaimsHistory businessKey={b.key} businessName={b.name} />

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
