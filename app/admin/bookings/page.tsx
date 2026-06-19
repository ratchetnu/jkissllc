'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import AdminGate from '../AdminGate'
import type { Booking, Payment } from '../../lib/bookings'

// ── Local label maps + helpers (avoid bundling server lib runtime) ───────────
const SERVICE_LABELS: Record<string, string> = {
  'moving': 'Moving Service', 'junk-removal': 'Junk Removal', 'eviction': 'Eviction / Property Cleanout',
  'appliance-delivery': 'Appliance Delivery', 'freight': 'Freight Service', 'estate-cleanout': 'Estate Cleanout',
  'garage-cleanout': 'Garage Cleanout', 'other': 'Service',
}
const SERVICE_TYPES = Object.keys(SERVICE_LABELS)
const STATUS_LABEL: Record<string, string> = {
  quote_received: 'Quote Received', pending_payment: 'Pending Payment', payment_received: 'Payment Received',
  booking_created: 'Booking Created', confirmation_link_sent: 'Link Sent', customer_viewed: 'Viewed',
  time_verification_pending: 'Awaiting Time', time_verified: 'Time Verified', confirmed: 'Confirmed',
  completed: 'Completed', cancelled: 'Cancelled',
}
const usd = (c: number) => ((c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtTs = (ts?: number) => ts ? new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
const balanceDue = (b: Booking) => Math.max(0, b.invoiceAmountCents - b.amountPaidCents)
function paySummary(b: Booking): string {
  const p = b.amountPaidCents
  if (p <= 0) return 'Unpaid'
  if (p >= b.invoiceAmountCents && b.invoiceAmountCents > 0) return 'Paid in Full'
  if (b.depositAmountCents > 0 && p >= b.depositAmountCents) return 'Deposit Paid'
  return 'Partially Paid'
}
function statusColor(s: string): string {
  if (s === 'confirmed' || s === 'completed') return '#34d399'
  if (s === 'cancelled') return '#f87171'
  if (s === 'time_verified' || s === 'payment_received') return '#fbbf24'
  return 'var(--muted)'
}

const iStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.10)', borderRadius: '9px', color: '#f3f4f6', fontSize: '14px', outline: 'none',
}
const lab: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--muted)', marginBottom: '4px' }

async function patch(token: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/admin/bookings/${token}`, {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error ?? 'Action failed')
  return j
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard() {
  const [items, setItems] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<'bookings' | 'customers'>('bookings')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/bookings', { credentials: 'same-origin' })
      if (res.status === 401) { setError('Session expired — reload.'); return }
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setItems(j.items ?? [])
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const current = items.find(b => b.token === selected) ?? null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(b =>
      [b.customerName, b.customerPhone, b.customerEmail, b.bookingNumber, b.invoiceNumber]
        .filter(Boolean).some(v => v!.toLowerCase().includes(q)))
  }, [items, search])

  function exportCsv(filter: string) {
    window.open(`/api/admin/bookings/export?filter=${filter}`, '_blank')
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,.1)' }}>
          {(['bookings', 'customers'] as const).map((t, i) => (
            <button key={t} onClick={() => { setView(t); setSelected(null) }} className="px-4 py-2 text-sm font-semibold capitalize"
              style={{ background: view === t ? 'var(--red)' : 'rgba(255,255,255,.03)', color: view === t ? '#fff' : 'var(--muted)', borderRight: i === 0 ? '1px solid rgba(255,255,255,.1)' : 'none' }}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowNew(true); setSelected(null) }} className="btn" style={{ padding: '8px 14px', fontSize: '13px' }}>+ New Booking</button>
          <button onClick={load} className="px-3 py-2 text-sm rounded-xl" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>↻</button>
        </div>
      </div>

      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, phone, email, booking #…" style={{ ...iStyle, marginBottom: '16px' }} />

      {error && <p className="text-sm mb-4" style={{ color: '#f87171' }}>{error}</p>}
      {loading && <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p>}

      {showNew && <BookingForm onClose={() => setShowNew(false)} onSaved={async () => { setShowNew(false); await load() }} />}

      {!loading && view === 'bookings' && !showNew && (
        current ? (
          editing ? (
            <BookingForm booking={current} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await load() }} />
          ) : (
            <BookingDetail b={current} onBack={() => setSelected(null)} onEdit={() => setEditing(true)} onChanged={load} />
          )
        ) : (
          <div className="space-y-2.5">
            {filtered.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>No bookings yet. Click <strong className="text-white">+ New Booking</strong>.</p>}
            <div className="flex flex-wrap gap-2 mb-2">
              {(['all', 'paid', 'unpaid', 'completed'] as const).map(f => (
                <button key={f} onClick={() => exportCsv(f)} className="text-xs font-semibold px-3 py-1.5 rounded-lg capitalize"
                  style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
                  Export {f} CSV
                </button>
              ))}
            </div>
            {filtered.map(b => <BookingCard key={b.token} b={b} onClick={() => setSelected(b.token)} />)}
          </div>
        )
      )}

      {!loading && view === 'customers' && <CustomersView items={items} search={search} />}
    </div>
  )
}

function StatusBadge({ s }: { s: string }) {
  return <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,.06)', color: statusColor(s) }}>{STATUS_LABEL[s] ?? s}</span>
}

function BookingCard({ b, onClick }: { b: Booking; onClick: () => void }) {
  return (
    <button onClick={onClick} className="glass-card w-full text-left p-4 transition" style={{ borderRadius: '14px' }}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="font-black text-white">{b.customerName}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            <span className="font-mono">{b.bookingNumber}</span> · {SERVICE_LABELS[b.serviceType] ?? b.serviceType}
          </p>
        </div>
        <StatusBadge s={b.status} />
      </div>
      <div className="flex items-center justify-between text-xs" style={{ color: 'var(--muted)' }}>
        <span>{paySummary(b)} · Bal {usd(balanceDue(b))}</span>
        <span>{b.selectedDate || '—'} {b.selectedWindow || ''}</span>
      </div>
    </button>
  )
}

// ── Detail + actions ─────────────────────────────────────────────────────────
function BookingDetail({ b, onBack, onEdit, onChanged }: { b: Booking; onBack: () => void; onEdit: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const link = typeof window !== 'undefined' ? `${window.location.origin}/booking/${b.token}` : ''

  async function run(action: string, body: Record<string, unknown> = {}, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return
    setBusy(action); setMsg(''); setErr('')
    try {
      const j = await patch(b.token, { action, ...body })
      if (action === 'send-link' && j.channels) {
        const ch = [j.channels.email && 'email', j.channels.sms && 'text'].filter(Boolean)
        setMsg(ch.length ? `Confirmation link sent via ${ch.join(' + ')}.` : 'No email/phone on file — add contact info and retry.')
      } else setMsg('Done.')
      await onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy('') }
  }

  function copyLink() {
    navigator.clipboard?.writeText(link).then(() => setMsg('Link copied.'), () => setMsg(link))
  }

  async function del() {
    if (!confirm('Permanently delete this booking? This cannot be undone.')) return
    setBusy('delete'); setErr('')
    try {
      const res = await fetch(`/api/admin/bookings/${b.token}`, { method: 'DELETE', credentials: 'same-origin' })
      if (!res.ok) throw new Error('Delete failed')
      onBack(); await onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); setBusy('') }
  }

  const pendingPayments = b.payments.filter(p => p.status === 'sent_by_customer')

  return (
    <div>
      <button onClick={onBack} className="text-sm mb-4" style={{ color: 'var(--muted)' }}>← All bookings</button>

      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-xl font-black text-white">{b.customerName}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
              <span className="font-mono">{b.bookingNumber}</span>{b.invoiceNumber && <> · Inv <span className="font-mono">{b.invoiceNumber}</span></>} · {SERVICE_LABELS[b.serviceType] ?? b.serviceType}
            </p>
          </div>
          <StatusBadge s={b.status} />
        </div>
        <KV k="Phone" v={b.customerPhone} /><KV k="Email" v={b.customerEmail} />
        <KV k="Pickup" v={b.pickupAddress} /><KV k="Drop-off" v={b.dropoffAddress} /><KV k="Job Site" v={b.jobSiteAddress} />
        <KV k="Service Date" v={b.selectedDate ? `${b.selectedDate} · ${b.selectedWindow ?? ''}` : 'Not verified'} />
        {b.description && <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>{b.description}</p>}
        {b.items.length > 0 && <ul className="text-sm mt-2 space-y-0.5" style={{ color: 'var(--muted)' }}>{b.items.map((i, n) => <li key={n}>• {i}</li>)}</ul>}
      </div>

      {/* Money */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Payment — {paySummary(b)}</p>
        <KV k="Invoice Total" v={usd(b.invoiceAmountCents)} />
        {b.depositAmountCents > 0 && <KV k="Deposit" v={usd(b.depositAmountCents)} />}
        <KV k="Amount Paid" v={usd(b.amountPaidCents)} />
        <KV k="Balance Due" v={usd(balanceDue(b))} />
        <div className="flex flex-wrap gap-2 mt-3">
          {b.depositAmountCents > b.amountPaidCents && <ActBtn label="Mark Deposit Paid" busy={busy === 'mark-deposit-paid'} onClick={() => run('mark-deposit-paid')} />}
          {balanceDue(b) > 0 && <ActBtn label="Mark Paid in Full" busy={busy === 'mark-paid-full'} onClick={() => run('mark-paid-full')} />}
        </div>
        {b.payments.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {b.payments.map(p => <PaymentRow key={p.id} p={p} onConfirm={() => run('confirm-payment', { paymentId: p.id })} busy={busy === 'confirm-payment'} />)}
          </div>
        )}
        {pendingPayments.length > 0 && <p className="text-xs mt-2" style={{ color: '#fbbf24' }}>⚠ {pendingPayments.length} customer-reported payment(s) need confirmation.</p>}
      </div>

      {/* Actions */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Actions</p>
        <div className="flex flex-wrap gap-2">
          <ActBtn label="Copy Link" onClick={copyLink} />
          <ActBtn label={b.confirmationLinkSentAt ? 'Resend Confirmation Link' : 'Send Confirmation Link'} primary busy={busy === 'send-link'} onClick={() => run('send-link')} />
          <ActBtn label="Add Note" onClick={() => { const n = prompt('Internal note:'); if (n) run('add-note', { note: n }) }} />
          <ActBtn label="Edit" onClick={onEdit} />
          {b.status !== 'completed' && <ActBtn label="Mark Completed" busy={busy === 'mark-completed'} onClick={() => run('mark-completed', {}, 'Mark this job completed?')} />}
          {b.status !== 'cancelled' && <ActBtn label="Cancel Booking" danger onClick={() => { const r = prompt('Cancellation reason (optional):') ?? ''; run('cancel', { reason: r }, 'Cancel this booking?') }} />}
          <ActBtn label="Delete" danger busy={busy === 'delete'} onClick={del} />
        </div>
        <a href={link} target="_blank" rel="noreferrer" className="block text-xs mt-3 font-mono break-all" style={{ color: 'var(--red)' }}>{link}</a>
        {msg && <p className="text-sm mt-2" style={{ color: '#34d399' }}>{msg}</p>}
        {err && <p className="text-sm mt-2" style={{ color: '#f87171' }}>{err}</p>}
      </div>

      {/* Chargeback evidence */}
      <details className="glass-card p-5" style={{ borderRadius: '16px' }}>
        <summary className="cursor-pointer text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Chargeback Evidence / Audit Trail</summary>
        <div className="mt-3">
          <KV k="Booking #" v={b.bookingNumber} /><KV k="Invoice #" v={b.invoiceNumber} />
          <KV k="Created" v={fmtTs(b.createdAt)} />
          <KV k="Link Sent" v={b.confirmationLinkSentAt ? `${fmtTs(b.confirmationLinkSentAt)} by ${b.confirmationLinkSentBy ?? 'admin'}` : '—'} />
          <KV k="Customer Viewed" v={fmtTs(b.customerViewedAt)} />
          <KV k="Time Verified" v={fmtTs(b.customerTimeVerifiedAt)} />
          <KV k="Selected Date/Time" v={b.selectedDate ? `${b.selectedDate} · ${b.selectedWindow ?? ''}` : '—'} />
          <KV k="Confirmed" v={fmtTs(b.customerConfirmedAt)} />
          <div className="mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
            <KV k="Policy Accepted" v={b.agreementAccepted ? `v${b.agreementPolicyVersion} on ${fmtTs(b.agreementAcceptedAt)}` : 'Not accepted'} />
            <KV k="Acceptance IP" v={b.agreementIp} />
            <KV k="User Agent" v={b.agreementUserAgent} />
          </div>
          {b.internalNotes && <div className="mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}><p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Internal Notes</p><pre className="text-xs whitespace-pre-wrap" style={{ color: 'var(--text)', fontFamily: 'var(--font-body)' }}>{b.internalNotes}</pre></div>}
          <a href={`/api/booking/${b.token}/confirmation`} target="_blank" rel="noreferrer" className="inline-block text-xs font-semibold mt-3" style={{ color: 'var(--red)' }}>Open Confirmation Record →</a>
        </div>
      </details>
    </div>
  )

  function PaymentRow({ p, onConfirm, busy }: { p: Payment; onConfirm: () => void; busy: boolean }) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs p-2 rounded-lg" style={{ background: 'rgba(255,255,255,.03)' }}>
        <span style={{ color: 'var(--muted)' }}>
          {usd(p.amountCents)} · {p.method} · {p.type} · <span style={{ color: p.status === 'confirmed' ? '#34d399' : '#fbbf24' }}>{p.status.replace(/_/g, ' ')}</span>
          {p.feeCents > 0 && <> · fee {usd(p.feeCents)}</>}
        </span>
        {p.status === 'sent_by_customer' && <button onClick={onConfirm} disabled={busy} className="font-bold px-2 py-1 rounded" style={{ background: 'var(--red)', color: '#fff' }}>Confirm</button>}
      </div>
    )
  }
}

function KV({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null
  return <div className="flex justify-between gap-3 py-1"><span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{k}</span><span className="text-xs font-semibold text-right break-all" style={{ color: 'var(--text)' }}>{v}</span></div>
}

function ActBtn({ label, onClick, busy, primary, danger }: { label: string; onClick: () => void; busy?: boolean; primary?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} disabled={busy} className="text-xs font-semibold px-3 py-2 rounded-lg"
      style={{
        background: primary ? 'var(--red)' : danger ? 'rgba(224,0,42,.08)' : 'rgba(255,255,255,.05)',
        border: `1px solid ${primary ? 'var(--red)' : danger ? 'rgba(224,0,42,.3)' : 'rgba(255,255,255,.1)'}`,
        color: primary ? '#fff' : danger ? '#ff6680' : 'var(--text)',
      }}>
      {busy ? '…' : label}
    </button>
  )
}

// ── New / edit form ──────────────────────────────────────────────────────────
function BookingForm({ booking, onClose, onSaved }: { booking?: Booking; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const edit = !!booking

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true); setErr('')
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      if (edit) {
        await patch(booking!.token, { action: 'update', fields: f })
      } else {
        const res = await fetch('/api/admin/bookings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? 'Failed')
      }
      await onSaved()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); setSaving(false) }
  }

  const dollars = (c?: number) => c ? (c / 100).toFixed(2) : ''

  return (
    <form onSubmit={submit} className="glass-card p-5 space-y-3" style={{ borderRadius: '16px', borderColor: 'rgba(224,0,42,.3)' }}>
      <p className="text-sm font-bold text-white">{edit ? `Edit ${booking!.bookingNumber}` : 'New Booking'}</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label style={lab}>Customer Name *</label><input name="customerName" required defaultValue={booking?.customerName} style={iStyle} /></div>
        <div><label style={lab}>Service Type</label><select name="serviceType" defaultValue={booking?.serviceType ?? 'moving'} style={{ ...iStyle, cursor: 'pointer' }}>{SERVICE_TYPES.map(s => <option key={s} value={s}>{SERVICE_LABELS[s]}</option>)}</select></div>
        <div><label style={lab}>Phone</label><input name="customerPhone" defaultValue={booking?.customerPhone} style={iStyle} /></div>
        <div><label style={lab}>Email</label><input name="customerEmail" defaultValue={booking?.customerEmail} style={iStyle} /></div>
        <div><label style={lab}>Invoice #</label><input name="invoiceNumber" defaultValue={booking?.invoiceNumber} style={iStyle} /></div>
        <div><label style={lab}>Invoice Date</label><input name="invoiceDate" defaultValue={booking?.invoiceDate} placeholder="June 16, 2026" style={iStyle} /></div>
        <div><label style={lab}>Invoice Amount ($)</label><input name="invoiceAmount" inputMode="decimal" defaultValue={dollars(booking?.invoiceAmountCents)} placeholder="550.00" style={iStyle} /></div>
        <div><label style={lab}>Deposit ($)</label><input name="depositAmount" inputMode="decimal" defaultValue={dollars(booking?.depositAmountCents)} placeholder="150.00" style={iStyle} /></div>
        <div><label style={lab}>Crew Size</label><input name="crewSize" inputMode="numeric" defaultValue={booking?.crewSize ?? ''} placeholder="2" style={iStyle} /></div>
        <div><label style={lab}>Estimated Hours</label><input name="estimatedHours" inputMode="numeric" defaultValue={booking?.estimatedHours ?? ''} placeholder="5" style={iStyle} /></div>
      </div>
      <div><label style={lab}>Pickup Address</label><input name="pickupAddress" defaultValue={booking?.pickupAddress} style={iStyle} /></div>
      <div><label style={lab}>Drop-off Address</label><input name="dropoffAddress" defaultValue={booking?.dropoffAddress} style={iStyle} /></div>
      <div><label style={lab}>Job Site Address (if single-site)</label><input name="jobSiteAddress" defaultValue={booking?.jobSiteAddress} style={iStyle} /></div>
      <div><label style={lab}>Description</label><textarea name="description" rows={2} defaultValue={booking?.description} style={{ ...iStyle, resize: 'vertical' }} /></div>
      <div><label style={lab}>Items (one per line)</label><textarea name="items" rows={3} defaultValue={booking?.items?.join('\n')} placeholder={'40 boxes\nRefrigerator\nDresser\nCouch\nGrill'} style={{ ...iStyle, resize: 'vertical' }} /></div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label style={lab}>Available Dates (one per line, YYYY-MM-DD)</label><textarea name="availableDates" rows={3} defaultValue={booking?.availableDates?.join('\n')} placeholder={'2026-06-26'} style={{ ...iStyle, resize: 'vertical' }} /></div>
        <div><label style={lab}>Arrival Windows (one per line)</label><textarea name="availableWindows" rows={3} defaultValue={booking?.availableWindows?.join('\n')} placeholder={'8am–10am\n10am–12pm\n12pm–2pm\n2pm–4pm\n4pm–6pm'} style={{ ...iStyle, resize: 'vertical' }} /></div>
      </div>
      <div><label style={lab}>Internal Notes (ops only)</label><textarea name="internalNotes" rows={2} defaultValue={booking?.internalNotes} style={{ ...iStyle, resize: 'vertical' }} /></div>
      {err && <p className="text-sm" style={{ color: '#f87171' }}>{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn" style={{ padding: '10px 18px', fontSize: '13px' }}>{saving ? 'Saving…' : edit ? 'Save Changes' : 'Create Booking'}</button>
        <button type="button" onClick={onClose} className="btn-ghost" style={{ padding: '10px 18px', fontSize: '13px' }}>Cancel</button>
      </div>
    </form>
  )
}

// ── Customers view ───────────────────────────────────────────────────────────
function CustomersView({ items, search }: { items: Booking[]; search: string }) {
  const customers = useMemo(() => {
    const map = new Map<string, { name: string; phone?: string; email?: string; jobs: number; invoiced: number; paid: number; services: Set<string>; last: string }>()
    for (const b of items) {
      const key = (b.customerEmail || b.customerPhone || b.customerName).toLowerCase()
      const c = map.get(key) ?? { name: b.customerName, phone: b.customerPhone, email: b.customerEmail, jobs: 0, invoiced: 0, paid: 0, services: new Set<string>(), last: '' }
      c.jobs += 1; c.invoiced += b.invoiceAmountCents; c.paid += b.amountPaidCents
      c.services.add(SERVICE_LABELS[b.serviceType] ?? b.serviceType)
      const d = b.selectedDate || new Date(b.createdAt).toISOString().slice(0, 10)
      if (d > c.last) c.last = d
      if (!c.phone && b.customerPhone) c.phone = b.customerPhone
      if (!c.email && b.customerEmail) c.email = b.customerEmail
      map.set(key, c)
    }
    let arr = [...map.values()].sort((a, b) => b.paid - a.paid)
    const q = search.trim().toLowerCase()
    if (q) arr = arr.filter(c => [c.name, c.phone, c.email].filter(Boolean).some(v => v!.toLowerCase().includes(q)))
    return arr
  }, [items, search])

  if (customers.length === 0) return <p className="text-sm" style={{ color: 'var(--muted)' }}>No customers yet.</p>
  return (
    <div className="space-y-2.5">
      {customers.map((c, i) => (
        <div key={i} className="glass-card p-4" style={{ borderRadius: '14px' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-black text-white">{c.name}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{[c.phone, c.email].filter(Boolean).join(' · ')}</p>
              <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.4)' }}>{[...c.services].join(', ')}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-black" style={{ color: 'var(--red)' }}>{usd(c.paid)}</p>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{c.jobs} job{c.jobs > 1 ? 's' : ''} · last {c.last}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function BookingsAdminPage() {
  return <AdminGate title="Bookings"><Dashboard /></AdminGate>
}
