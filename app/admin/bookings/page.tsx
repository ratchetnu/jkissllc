'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { COMPANY } from '../../lib/company'
import { upload } from '@vercel/blob/client'
import AdminGate from '../AdminGate'
import AiFeedback from '../AiFeedback'
import { SkeletonList } from '../../components/Skeleton'
import { ConversationThread, type ThreadMessage } from '../messaging'
import type { Booking, Payment, InvoicePhoto } from '../../lib/bookings'

// ── Local label maps + helpers (avoid bundling server lib runtime) ───────────
const SERVICE_LABELS: Record<string, string> = {
  'moving': 'Moving Service', 'junk-removal': 'Junk Removal', 'eviction': 'Eviction / Property Cleanout',
  'appliance-delivery': 'Appliance Delivery', 'freight': 'Freight Service', 'estate-cleanout': 'Estate Cleanout',
  'garage-cleanout': 'Garage Cleanout', 'other': 'Service',
}
const SERVICE_TYPES = Object.keys(SERVICE_LABELS)
const STATUS_LABEL: Record<string, string> = {
  quote_received: 'Quote Received', pending_payment: 'Pending Payment', pending_zelle_verification: 'Zelle Review', payment_received: 'Payment Received',
  booking_created: 'Booking Created', confirmation_link_sent: 'Link Sent', customer_viewed: 'Viewed',
  time_verification_pending: 'Awaiting Time', time_verified: 'Time Verified', confirmed: 'Confirmed',
  in_progress: 'In Progress', continued: 'Continued — Return Needed', completed: 'Completed',
  partially_completed: 'Partially Completed', could_not_complete: 'Could Not Complete', cancelled: 'Cancelled', refunded: 'Refunded',
}
// Statuses offered in the detail-panel dropdown (the owner's working set).
const STATUS_OPTIONS: [string, string][] = [
  ['pending_payment', 'Pending'], ['confirmed', 'Confirmed'], ['in_progress', 'In Progress'],
  ['continued', 'Continued / Return Needed'], ['completed', 'Completed'], ['partially_completed', 'Partially Completed'],
  ['could_not_complete', 'Could Not Complete'], ['cancelled', 'Cancelled'], ['refunded', 'Refunded'],
]
const usd = (c: number) => ((c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtTs = (ts?: number) => ts ? new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
// Net invoice = gross minus any discount/promo (mirrors lib/bookings.netInvoiceCents).
const netInvoice = (b: Booking) => Math.max(0, b.invoiceAmountCents - (b.discountCents || 0))
const balanceDue = (b: Booking) => Math.max(0, netInvoice(b) - b.amountPaidCents)

// ISO yyyy-mm-dd → "Jun 27, 2026" (parsed LOCAL so it never slips a day).
function fmtISO(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
// Service date for the detail view: the customer's confirmed pick if they've
// verified, otherwise the date(s) the admin scheduled (awaiting confirmation).
function serviceDateLong(b: Booking): string {
  if (b.selectedDate) return `${fmtISO(b.selectedDate)}${b.selectedWindow ? ` · ${b.selectedWindow}` : ''} (confirmed)`
  const ds = b.availableDates ?? []
  if (ds.length === 1) return `${fmtISO(ds[0])} · ${b.amountPaidCents > 0 ? '(confirmed)' : 'awaiting customer confirmation'}`
  if (ds.length > 1) return `${ds.length} dates offered · awaiting customer pick`
  return 'Not set'
}
// Compact version for the list rows.
function serviceDateShort(b: Booking): string {
  if (b.selectedDate) return `${fmtISO(b.selectedDate)}${b.selectedWindow ? ` ${b.selectedWindow}` : ''}`
  const ds = b.availableDates ?? []
  if (ds.length === 1) return fmtISO(ds[0])
  if (ds.length > 1) return `${ds.length} dates`
  return '—'
}
function paySummary(b: Booking): string {
  const p = b.amountPaidCents
  const net = netInvoice(b)
  if (p <= 0) return 'Unpaid'
  if (p >= net && net > 0) return 'Paid in Full'
  if (b.depositAmountCents > 0 && p >= b.depositAmountCents) return 'Deposit Paid'
  return 'Partially Paid'
}
function statusColor(s: string): string {
  if (s === 'confirmed' || s === 'completed') return '#34d399'
  if (s === 'cancelled' || s === 'could_not_complete' || s === 'refunded') return '#f87171'
  if (s === 'continued' || s === 'partially_completed') return '#fb923c'
  if (s === 'in_progress') return '#60a5fa'
  if (s === 'pending_zelle_verification') return '#c084fc'
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

// Shrink a phone photo before upload so receipts stay light. Best-effort: any
// failure (e.g. HEIC that the browser can't decode to a canvas) returns the
// original file untouched.
async function downscaleImage(file: File, maxDim = 1600, quality = 0.82): Promise<Blob | File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    if (scale >= 1) { bitmap.close?.(); return file }
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close?.(); return file }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const out = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality))
    return out ?? file
  } catch { return file }
}

// Fields a quote email or a "duplicate" can pre-fill into a brand-new booking.
type Prefill = {
  name?: string; email?: string; phone?: string; service?: string
  pickup?: string; dropoff?: string; jobSite?: string; desc?: string
  items?: string; invoiceAmount?: string; deposit?: string; discount?: string
  crewSize?: string; estimatedHours?: string; assignedTo?: string; invoiceNumber?: string; disposalEst?: string
}

// Build a prefill from an existing booking (used by Duplicate).
function prefillFromBooking(b: Booking): Prefill {
  const d = (c?: number) => (c ? (c / 100).toFixed(2) : undefined)
  return {
    name: b.customerName, email: b.customerEmail, phone: b.customerPhone, service: b.serviceType,
    pickup: b.pickupAddress, dropoff: b.dropoffAddress, jobSite: b.jobSiteAddress,
    desc: b.description, items: b.items?.join('\n'),
    invoiceAmount: d(b.invoiceAmountCents), deposit: d(b.depositAmountCents), discount: d(b.discountCents),
    crewSize: b.crewSize ? String(b.crewSize) : undefined,
    estimatedHours: b.estimatedHours ? String(b.estimatedHours) : undefined,
    assignedTo: b.assignedTo,
  }
}

// Which status bucket a booking falls in, for the filter chips.
function matchesStatusFilter(b: Booking, f: string): boolean {
  if (f === 'all') return true
  if (f === 'zelle') return b.status === 'pending_zelle_verification'
  if (f === 'cancelled') return b.status === 'cancelled'
  if (f === 'completed') return b.status === 'completed'
  if (f === 'unpaid') return b.status !== 'cancelled' && balanceDue(b) > 0 && b.amountPaidCents === 0
  if (f === 'unscheduled') return b.status !== 'cancelled' && b.status !== 'completed' && !b.selectedDate
  if (f === 'active') return b.status !== 'cancelled' && b.status !== 'completed'
  return true
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard() {
  const [items, setItems] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<'bookings' | 'calendar' | 'customers'>('bookings')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState(false)
  const [prefill, setPrefill] = useState<Prefill | null>(null)
  const [statusFilter, setStatusFilter] = useState<'active' | 'zelle' | 'all' | 'unpaid' | 'unscheduled' | 'completed' | 'cancelled'>('active')
  const [showArchived, setShowArchived] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [visibleCount, setVisibleCount] = useState(25)
  const [bulkBusy, setBulkBusy] = useState(false)

  function startDuplicate(b: Booking) {
    setSelected(null); setEditing(false)
    setPrefill(prefillFromBooking(b)); setShowNew(true)
  }

  // Deep-link from the quote-request email: ?new=1 (+ customer fields) opens a
  // prefilled new-booking form. Strip the query after so a refresh won't reopen.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (sp.get('new') !== '1') return
    const g = (k: string) => sp.get(k) || undefined
    setPrefill({ name: g('name'), email: g('email'), phone: g('phone'), service: g('service'), pickup: g('pickup'), dropoff: g('dropoff'), jobSite: g('jobSite'), desc: g('desc'), disposalEst: g('disposalEst') })
    setShowNew(true)
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

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

  // Deep-link from an owner notification SMS/email: ?b=<bookingNumber> opens that
  // booking's detail once the list has loaded (then strips the query).
  const bParamDone = useRef(false)
  useEffect(() => {
    if (bParamDone.current || items.length === 0) return
    const bn = new URLSearchParams(window.location.search).get('b')
    if (!bn) { bParamDone.current = true; return }
    const match = items.find(x => (x.bookingNumber || '').toUpperCase() === bn.toUpperCase())
    if (match) { setSelected(match.token); window.history.replaceState({}, '', window.location.pathname) }
    bParamDone.current = true
  }, [items])

  const current = items.find(b => b.token === selected) ?? null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(b => {
      if (!showArchived && b.archived) return false
      if (showArchived && !b.archived) return false
      if (!matchesStatusFilter(b, statusFilter)) return false
      if (!q) return true
      return [b.customerName, b.customerPhone, b.customerEmail, b.bookingNumber, b.invoiceNumber, b.assignedTo]
        .filter(Boolean).some(v => v!.toLowerCase().includes(q))
    })
  }, [items, search, statusFilter, showArchived])

  // Reset pagination + selection whenever the visible set changes.
  useEffect(() => { setVisibleCount(25); setChecked(new Set()) }, [search, statusFilter, showArchived, view])

  function exportCsv(filter: string) {
    window.open(`/api/admin/bookings/export?filter=${filter}`, '_blank')
  }

  async function bulkArchive(archive: boolean) {
    const tokens = [...checked]
    if (!tokens.length) return
    setBulkBusy(true)
    try {
      await Promise.all(tokens.map(t => patch(t, { action: archive ? 'archive' : 'unarchive' }).catch(() => {})))
      setChecked(new Set()); await load()
    } finally { setBulkBusy(false) }
  }

  function toggleCheck(token: string) {
    setChecked(prev => { const n = new Set(prev); n.has(token) ? n.delete(token) : n.add(token); return n })
  }

  const STATUS_FILTERS = ['active', 'zelle', 'unpaid', 'unscheduled', 'completed', 'cancelled', 'all'] as const

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,.1)' }}>
          {(['bookings', 'calendar', 'customers'] as const).map((t, i, arr) => (
            <button key={t} onClick={() => { setView(t); setSelected(null) }} className="px-4 py-2 text-sm font-semibold capitalize"
              style={{ background: view === t ? 'var(--red)' : 'rgba(255,255,255,.03)', color: view === t ? '#fff' : 'var(--muted)', borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,.1)' : 'none' }}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowNew(true); setSelected(null) }} className="btn" style={{ padding: '8px 14px', fontSize: '13px' }}>+ New Booking</button>
          <button onClick={load} aria-label="Refresh bookings" className="px-3 py-2 text-sm rounded-xl" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>↻</button>
        </div>
      </div>

      <input value={search} onChange={e => setSearch(e.target.value)} aria-label="Search bookings" placeholder="Search customer, phone, email, booking #…" style={{ ...iStyle, marginBottom: '16px' }} />

      {error && <p className="text-sm mb-4" style={{ color: '#f87171' }} role="alert">{error}</p>}
      {loading && <SkeletonList rows={6} />}

      {showNew && <BookingForm prefill={prefill ?? undefined} onClose={() => { setShowNew(false); setPrefill(null) }} onSaved={async () => { setShowNew(false); setPrefill(null); await load() }} />}

      {!loading && view === 'bookings' && !showNew && (
        current ? (
          editing ? (
            <BookingForm booking={current} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await load() }} />
          ) : (
            <BookingDetail b={current} onBack={() => setSelected(null)} onEdit={() => setEditing(true)} onChanged={load} onDuplicate={() => startDuplicate(current)} />
          )
        ) : (
          <div className="space-y-2.5">
            {/* Status filter chips + archived toggle */}
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              {STATUS_FILTERS.map(f => (
                <button key={f} onClick={() => setStatusFilter(f)} className="text-xs font-semibold px-3 py-1.5 rounded-lg capitalize"
                  style={{ background: statusFilter === f && !showArchived ? 'var(--red)' : 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: statusFilter === f && !showArchived ? '#fff' : 'var(--muted)' }}>{f}</button>
              ))}
              <button onClick={() => setShowArchived(v => !v)} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                style={{ background: showArchived ? 'var(--red)' : 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: showArchived ? '#fff' : 'var(--muted)' }}>Archived</button>
            </div>

            {/* Bulk action bar */}
            {checked.size > 0 && (
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl" style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.25)' }}>
                <span className="text-sm font-semibold text-white">{checked.size} selected</span>
                <div className="flex gap-2">
                  <button onClick={() => bulkArchive(!showArchived)} disabled={bulkBusy} className="text-xs font-bold px-3 py-1.5 rounded-lg" style={{ background: 'var(--red)', color: '#fff' }}>{bulkBusy ? '…' : showArchived ? 'Unarchive' : 'Archive'}</button>
                  <button onClick={() => setChecked(new Set())} className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Clear</button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 mb-1">
              {(['all', 'paid', 'unpaid', 'completed'] as const).map(f => (
                <button key={f} onClick={() => exportCsv(f)} className="text-xs font-semibold px-3 py-1.5 rounded-lg capitalize"
                  style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>
                  Export {f} CSV
                </button>
              ))}
            </div>

            {filtered.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>{showArchived ? 'No archived bookings.' : 'No bookings match this filter.'}</p>}
            {filtered.slice(0, visibleCount).map(b => (
              <BookingCard key={b.token} b={b} onClick={() => setSelected(b.token)} checked={checked.has(b.token)} onCheck={() => toggleCheck(b.token)} />
            ))}
            {filtered.length > visibleCount && (
              <button onClick={() => setVisibleCount(c => c + 25)} className="btn-ghost w-full" style={{ padding: '11px', fontSize: 13, justifyContent: 'center' }}>
                Load more ({filtered.length - visibleCount} more)
              </button>
            )}
          </div>
        )
      )}

      {!loading && view === 'calendar' && !showNew && (
        current ? (
          <BookingDetail b={current} onBack={() => setSelected(null)} onEdit={() => setEditing(true)} onChanged={load} onDuplicate={() => startDuplicate(current)} />
        ) : (
          <CalendarView items={items.filter(b => !b.archived)} onSelect={setSelected} />
        )
      )}

      {!loading && view === 'customers' && <CustomersView items={items} search={search} />}
    </div>
  )
}

function StatusBadge({ s }: { s: string }) {
  return <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,.06)', color: statusColor(s) }}>{STATUS_LABEL[s] ?? s}</span>
}

function BookingCard({ b, onClick, checked, onCheck }: { b: Booking; onClick: () => void; checked?: boolean; onCheck?: () => void }) {
  return (
    <div className="glass-card flex items-stretch transition" style={{ borderRadius: '14px', opacity: b.archived ? 0.6 : 1 }}>
      {onCheck && (
        <label className="flex items-center pl-3.5 pr-1 cursor-pointer" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={!!checked} onChange={onCheck} style={{ width: 17, height: 17, accentColor: '#E0002A' }} />
        </label>
      )}
      <button onClick={onClick} className="flex-1 text-left p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="font-black text-white">{b.customerName}{b.archived && <span className="text-xs font-normal" style={{ color: 'rgba(255,255,255,.4)' }}> · archived</span>}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              <span className="font-mono">{b.bookingNumber}</span> · {SERVICE_LABELS[b.serviceType] ?? b.serviceType}{b.assignedTo ? ` · 👷 ${b.assignedTo}` : ''}
            </p>
          </div>
          <StatusBadge s={b.status} />
        </div>
        <div className="flex items-center justify-between text-xs" style={{ color: 'var(--muted)' }}>
          <span>{paySummary(b)} · Bal {usd(balanceDue(b))}</span>
          <span>{serviceDateShort(b)}</span>
        </div>
      </button>
    </div>
  )
}

// ── Calendar view ────────────────────────────────────────────────────────────
function CalendarView({ items, onSelect }: { items: Booking[]; onSelect: (token: string) => void }) {
  const today = new Date()
  const [month, setMonth] = useState({ y: today.getFullYear(), m: today.getMonth() })

  // Index bookings by their effective service date (selected, else single offered).
  const byDate = useMemo(() => {
    const map = new Map<string, Booking[]>()
    for (const b of items) {
      const d = (b.status === 'continued' && b.continuation?.returnDate) ? b.continuation.returnDate : (b.selectedDate || (b.availableDates?.length === 1 ? b.availableDates[0] : ''))
      if (!d) continue
      const arr = map.get(d) ?? []; arr.push(b); map.set(d, arr)
    }
    return map
  }, [items])

  const first = new Date(month.y, month.m, 1)
  const startPad = first.getDay()
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate()
  const cells: (number | null)[] = [...Array(startPad).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const iso = (d: number) => `${month.y}-${String(month.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const shift = (n: number) => setMonth(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() } })

  return (
    <div className="glass-card p-4 sm:p-5" style={{ borderRadius: '16px' }}>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => shift(-1)} aria-label="Previous month" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>←</button>
        <p className="text-base font-black text-white">{monthLabel}</p>
        <button onClick={() => shift(1)} aria-label="Next month" className="px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>→</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center mb-1">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="text-xs font-bold py-1" style={{ color: 'rgba(255,255,255,.35)' }}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />
          const dayBookings = byDate.get(iso(d)) ?? []
          const isToday = iso(d) === todayIso
          return (
            <div key={i} className="rounded-lg p-1" style={{ minHeight: 64, background: 'rgba(255,255,255,.025)', border: `1px solid ${isToday ? 'rgba(224,0,42,.5)' : 'rgba(255,255,255,.06)'}` }}>
              <div className="text-xs font-bold mb-0.5" style={{ color: isToday ? 'var(--red)' : 'rgba(255,255,255,.5)' }}>{d}</div>
              <div className="flex flex-col gap-0.5">
                {dayBookings.slice(0, 3).map(b => (
                  <button key={b.token} onClick={() => onSelect(b.token)} className="text-left truncate rounded px-1 py-0.5" style={{ fontSize: 10, lineHeight: 1.3, background: b.status === 'cancelled' ? 'rgba(248,113,113,.15)' : 'rgba(224,0,42,.18)', color: '#fff' }}
                    title={`${b.customerName}${b.selectedWindow ? ` · ${b.selectedWindow}` : ''}${b.assignedTo ? ` · ${b.assignedTo}` : ''}`}>
                    {b.customerName.split(' ')[0]}{b.selectedWindow ? ` ${b.selectedWindow.split('–')[0]}` : ''}
                  </button>
                ))}
                {dayBookings.length > 3 && <span style={{ fontSize: 9, color: 'rgba(255,255,255,.4)' }}>+{dayBookings.length - 3} more</span>}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-xs mt-3 text-center" style={{ color: 'rgba(255,255,255,.3)' }}>Jobs appear on their confirmed (or single scheduled) date. Tap one to open it.</p>
    </div>
  )
}

// ── Customer timeline ────────────────────────────────────────────────────────
function Timeline({ b }: { b: Booking }) {
  const events: { at: number; label: string }[] = []
  const push = (at: number | undefined, label: string) => { if (at) events.push({ at, label }) }
  push(b.createdAt, 'Booking created')
  push(b.confirmationLinkSentAt, `Confirmation link sent${b.confirmationLinkSentBy ? ` (${b.confirmationLinkSentBy})` : ''}`)
  push(b.customerViewedAt, 'Customer opened booking')
  push(b.customerTimeVerifiedAt, `Time verified${b.selectedDate ? ` — ${fmtISO(b.selectedDate)}${b.selectedWindow ? `, ${b.selectedWindow}` : ''}` : ''}`)
  for (const p of b.payments) {
    if (p.status === 'confirmed') push(p.confirmedAt ?? p.createdAt, `Payment ${usd(p.amountCents)} · ${p.method}`)
    else if (p.status === 'sent_by_customer') push(p.createdAt, `Customer reported ${usd(p.amountCents)} · ${p.method} (needs confirm)`)
  }
  push(b.rescheduleRequest?.at, 'Reschedule requested')
  push(b.reminders?.recoverySentAt, 'Recovery reminder sent')
  push(b.reminders?.paymentSentAt, 'Payment reminder sent')
  push(b.reminders?.dayBeforeSentAt, 'Day-before reminder sent')
  push(b.reminders?.reviewRequestSentAt, 'Review request sent')
  push(b.completedAt, 'Job completed')
  push(b.cancelledAt, 'Cancelled')
  push(b.archivedAt, 'Archived')
  events.sort((a, c) => a.at - c.at)
  if (events.length === 0) return null
  return (
    <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
      <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Timeline</p>
      <div className="space-y-2.5">
        {events.map((e, i) => (
          <div key={i} className="flex gap-3">
            <div className="shrink-0 mt-1.5" style={{ width: 8, height: 8, borderRadius: 999, background: i === events.length - 1 ? 'var(--red)' : 'rgba(255,255,255,.25)' }} />
            <div className="min-w-0">
              <p className="text-sm text-white">{e.label}</p>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{fmtTs(e.at)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Client mirror of lib/booking-emails.continuationMessage — keep wording in sync.
function bookingLinkFor(token: string): string {
  return typeof window !== 'undefined' ? `${window.location.origin}/booking/${token}` : `/booking/${token}`
}
function continuationMsg(b: Booking): string {
  const c = b.continuation
  if (!c) return ''
  const svc = (SERVICE_LABELS[b.serviceType] ?? 'job').toLowerCase()
  const because = c.reason ? ` because ${c.reason}` : ' in one trip'
  const when = c.returnDate ? ` on ${fmtISO(c.returnDate)}${c.returnWindow ? ` (${c.returnWindow})` : ''}` : ' soon'
  const remaining = c.remainingWork ? ` to finish ${c.remainingWork}` : ' to finish the remaining work'
  return `Hi ${b.customerName}, we started your ${svc} but couldn't complete everything${because}. We'd like to return${when}${remaining}. Please confirm this works (or pick another date) here: ${bookingLinkFor(b.token)} — ${COMPANY.legalName}`
}

// ── Multi-day / job continuation ─────────────────────────────────────────────
function ContinuationCard({ b, run, busy }: { b: Booking; run: (action: string, body?: Record<string, unknown>, confirmMsg?: string) => void; busy: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const c = b.continuation
  const active = b.status !== 'completed' && b.status !== 'cancelled'
  const ti: React.CSSProperties = { width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 15, outline: 'none' }
  const lb: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, unknown>
    f.customerNotified = 'customerNotified' in f ? 'true' : 'false'
    run('continue', f)
    setOpen(false)
  }

  return (
    <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px', border: b.status === 'continued' ? '1px solid rgba(251,146,60,.4)' : undefined }}>
      <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Multi-Day / Continuation</p>

      {c ? (
        <>
          <KV k="Originally started" v={c.originalServiceDate ? fmtISO(c.originalServiceDate) : '—'} />
          <KV k="Return scheduled" v={c.returnDate ? `${fmtISO(c.returnDate)}${c.returnWindow ? ` · ${c.returnWindow}` : ''}` : 'TBD'} />
          <KV k="Reason" v={c.reason} />
          <KV k="Completed so far" v={c.completedToday} />
          <KV k="Remaining work" v={c.remainingWork} />
          <KV k="Customer notified" v={c.customerNotified ? 'Yes' : 'No'} />
          <KV k="Return confirmed by customer" v={c.customerConfirmedReturn ? `✓ Yes${c.customerConfirmedReturnAt ? ` · ${new Date(c.customerConfirmedReturnAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}` : ''}` : 'Awaiting confirmation'} />
          {c.returnChangeRequest && !c.customerConfirmedReturn && (
            <div className="mt-2 rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(251,146,60,.10)', border: '1px solid rgba(251,146,60,.3)', color: '#fdba74' }}>
              Customer requested a different date{c.returnChangeRequest.requestedDate ? `: ${fmtISO(c.returnChangeRequest.requestedDate)}` : ''}{c.returnChangeRequest.note ? ` — “${c.returnChangeRequest.note}”` : ''}. Update the return date and re-save to send a fresh confirmation.
            </div>
          )}
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
            <p className="text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Customer confirmation link</p>
            <p className="text-xs font-mono break-all mb-2" style={{ color: 'var(--text)' }}>{bookingLinkFor(b.token)}</p>
            <p className="text-xs font-semibold mb-1 mt-3" style={{ color: 'var(--muted)' }}>Customer message</p>
            <p className="text-sm" style={{ color: 'var(--text)', lineHeight: 1.5 }}>{continuationMsg(b)}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <button onClick={() => { navigator.clipboard?.writeText(bookingLinkFor(b.token)); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1600) }} className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>{linkCopied ? '✓ Link copied' : 'Copy link'}</button>
              <button onClick={() => { navigator.clipboard?.writeText(continuationMsg(b)); setCopied(true); setTimeout(() => setCopied(false), 1600) }} className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>{copied ? '✓ Copied' : 'Copy message'}</button>
              {(b.customerEmail || b.customerPhone) && <button onClick={() => run('send-continuation')} disabled={busy === 'send-continuation'} className="text-xs font-bold px-3 py-1.5 rounded-lg" style={{ background: 'var(--red)', color: '#fff' }}>{busy === 'send-continuation' ? '…' : 'Send confirmation link'}</button>}
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Started the job but couldn&apos;t finish in one trip? Schedule a return without cancelling — the same booking, balance, and payments carry over.</p>
      )}

      {active && (
        <div className="flex flex-wrap gap-2 mt-3">
          {b.status !== 'in_progress' && b.status !== 'continued' && <ActBtn label="Mark In Progress" busy={busy === 'mark-in-progress'} onClick={() => run('mark-in-progress')} />}
          <ActBtn label={c ? 'Edit Continuation' : 'Mark as Continued / Return Needed'} onClick={() => setOpen(o => !o)} />
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="mt-3 space-y-2.5">
          <div><label style={lb}>Reason for continuation</label><input name="reason" defaultValue={c?.reason} placeholder="truck filled with brush and the dump was closed" style={ti} /></div>
          <div className="grid sm:grid-cols-2 gap-2.5">
            <div><label style={lb}>Return date</label><input type="date" name="returnDate" defaultValue={c?.returnDate} style={{ ...ti, colorScheme: 'dark' }} /></div>
            <div><label style={lb}>Return window (optional)</label><input name="returnWindow" defaultValue={c?.returnWindow} placeholder="8am–10am" style={ti} /></div>
          </div>
          <div><label style={lb}>What was completed today</label><textarea name="completedToday" rows={2} defaultValue={c?.completedToday} style={{ ...ti, resize: 'vertical' }} /></div>
          <div><label style={lb}>What remains to be done</label><textarea name="remainingWork" rows={2} defaultValue={c?.remainingWork} style={{ ...ti, resize: 'vertical' }} /></div>
          <div><label style={lb}>Internal notes (ops only)</label><textarea name="notes" rows={2} defaultValue={c?.notes} style={{ ...ti, resize: 'vertical' }} /></div>
          <label className="flex items-center gap-2.5 text-sm py-1" style={{ color: 'var(--text)' }}>
            <input type="checkbox" name="customerNotified" defaultChecked={!!c?.customerNotified} style={{ width: 18, height: 18, accentColor: '#E0002A' }} />
            Customer already notified
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy === 'continue'} className="btn" style={{ padding: '10px 18px', fontSize: 14 }}>{busy === 'continue' ? 'Saving…' : 'Save — Return Needed'}</button>
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost" style={{ padding: '10px 18px', fontSize: 14 }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}

// ── Customer messages panel (texts/emails, both directions) ──────────────────
function BookingMessages({ token, customerName, reloadKey, communications }: { token: string; customerName: string; reloadKey?: number; communications?: { at: number; channel: string; body: string; ok?: boolean; sid?: string }[] }) {
  const [msgs, setMsgs] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/messages?tab=all&booking=${encodeURIComponent(token)}`, { credentials: 'same-origin' })
      if (res.ok) { const j = await res.json(); setMsgs(((j.items ?? []) as ThreadMessage[]).slice().reverse()) }
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [token])
  useEffect(() => { load() }, [load, reloadKey])

  // Merge the message-store thread with the booking's own communications log so
  // older admin sends (logged before reply-tracking existed, or that didn't make
  // it into the thread) still show. Dedup by normalized body text.
  const merged = useMemo(() => {
    const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim()
    const seen = new Set(msgs.map(m => norm(m.body)))
    const extra: ThreadMessage[] = (communications ?? [])
      .filter(c => c.body && !seen.has(norm(c.body)))
      .map((c, i) => ({
        id: `comm-${c.at}-${i}`, direction: 'outbound' as const,
        channel: c.channel === 'email' ? 'email' : 'sms',
        body: c.body, createdAt: c.at, status: c.ok === false ? 'failed' : 'sent', unread: false,
      }))
    return [...msgs, ...extra].sort((a, b) => a.createdAt - b.createdAt)
  }, [msgs, communications])
  async function markRead(id: string) {
    try {
      await fetch('/api/admin/messages', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'read' }) })
    } catch { /* ignore */ }
    await load()
  }
  const unread = merged.filter(m => m.unread).length
  return (
    <div>
      {unread > 0 && <p className="text-xs font-bold mb-2" style={{ color: 'var(--red)' }}>{unread} unread</p>}
      {loading
        ? <p className="text-xs" style={{ color: 'var(--muted)' }}>Loading…</p>
        : <ConversationThread messages={merged} customerName={customerName} onMarkRead={markRead} emptyHint={`No texts or emails with ${customerName} yet.`} />}
    </div>
  )
}

// ── Detail + actions ─────────────────────────────────────────────────────────
function BookingDetail({ b, onBack, onEdit, onChanged, onDuplicate }: { b: Booking; onBack: () => void; onEdit: () => void; onChanged: () => Promise<void>; onDuplicate: () => void }) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [aiBusy, setAiBusy] = useState('')
  // Message Customer composer
  const [msgText, setMsgText] = useState('')
  const [msgCallId, setMsgCallId] = useState<string | undefined>()
  const [msgTpl, setMsgTpl] = useState('')
  const [msgBusy, setMsgBusy] = useState<'sms' | 'email' | 'both' | ''>('')
  const [msgInfo, setMsgInfo] = useState('')
  const [msgErr, setMsgErr] = useState('')
  const [tabKey, setTabKey] = useState<'overview' | 'messages' | 'timeline' | 'actions'>('overview')
  const [msgReload, setMsgReload] = useState(0)
  const [staffNames, setStaffNames] = useState<string[]>([])
  useEffect(() => {
    fetch('/api/admin/staff', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.items) setStaffNames(j.items.filter((s: { active: boolean }) => s.active).map((s: { name: string }) => s.name)) })
      .catch(() => {})
  }, [])
  const link = typeof window !== 'undefined' ? `${window.location.origin}/booking/${b.token}` : ''

  // Personalized message templates (client-side so they work even without AI).
  const firstName = (b.customerName || '').trim().split(/\s+/)[0] || 'there'
  const svcLabel = SERVICE_LABELS[b.serviceType] ?? 'service'
  const MSG_TEMPLATES: [string, string, string][] = [
    ['could_not_complete', 'Could Not Complete — won’t return this week',
      `Hi ${firstName}, this is ${COMPANY.legalNameUpper}. I apologize, but due to unforeseen scheduling issues, we will not be able to return this week to complete the remaining work. Because the job will not be completed, there will be no remaining balance due. The deposit has been applied toward the work already completed and disposal costs. I apologize for the inconvenience and appreciate your understanding.`],
    ['cancel_driver', 'Cancellation — driver unavailable',
      `Hi ${firstName}, this is ${COMPANY.legalNameUpper}. I'm very sorry, but due to unforeseen scheduling issues our driver won't be able to make it as scheduled, so we have to cancel for now. I sincerely apologize for the inconvenience and would love to reschedule as soon as we're able. If you need any further help, please email us at info@jkissllc.com. Thank you for your understanding.`],
    ['running_late', 'Running late',
      `Hi ${firstName}, this is ${COMPANY.legalNameUpper}. We're running a little behind schedule today and wanted to keep you posted — we'll be there as soon as we can. Thank you for your patience.`],
    ['on_the_way', 'On the way',
      `Hi ${firstName}, this is ${COMPANY.legalNameUpper} — our crew is on the way for your ${svcLabel}. See you soon!`],
    ['followup', 'Follow-up',
      `Hi ${firstName}, this is ${COMPANY.legalNameUpper} following up on your ${svcLabel} (${b.bookingNumber}). Do you have any questions, or anything we can help with?`],
    ['thanks', 'Thank you',
      `Hi ${firstName}, thank you for choosing ${COMPANY.legalNameUpper} — we appreciate your business! If you have a moment, we'd love a quick review.`],
  ]

  function applyTemplate(key: string) {
    setMsgTpl(key); setMsgErr(''); setMsgInfo('')
    const t = MSG_TEMPLATES.find(([k]) => k === key)
    if (t) setMsgText(t[2])
  }

  // Best-effort AI polish of whatever's in the box (no-ops gracefully if AI is off).
  async function improveWithAI() {
    if (!msgText.trim()) { setMsgErr('Write or pick a message first.'); return }
    setAiBusy('improve'); setMsgErr(''); setMsgInfo('')
    try {
      const res = await fetch('/api/admin/ai/message', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: b.token, intent: 'custom', note: `Clean up and professionally reword this message, keeping the meaning: ${msgText}` }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'AI is unavailable — edit the text manually.')
      setMsgText(j.message); setMsgCallId(j.callId)
    } catch (e) { setMsgErr(e instanceof Error ? e.message : 'Failed') }
    finally { setAiBusy('') }
  }

  async function sendMessage(channel: 'sms' | 'email' | 'both') {
    if (!msgText.trim()) { setMsgErr('Write a message first.'); return }
    setMsgBusy(channel); setMsgInfo(''); setMsgErr('')
    try {
      const j = await patch(b.token, { action: 'send-message', text: msgText, channel })
      const ch = [j.channels?.sms && 'text', j.channels?.email && 'email'].filter(Boolean)
      setMsgInfo(ch.length ? `Sent via ${ch.join(' + ')}.` : 'Sent.')
      setMsgText(''); setMsgTpl('')
      await onChanged()
      setMsgReload(n => n + 1)
    } catch (e) { setMsgErr(e instanceof Error ? e.message : 'Failed to send.') }
    finally { setMsgBusy('') }
  }

  async function run(action: string, body: Record<string, unknown> = {}, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return
    setBusy(action); setMsg(''); setErr('')
    try {
      const j = await patch(b.token, { action, ...body })
      if (action === 'send-link' && j.channels) {
        const ch = [j.channels.email && 'email', j.channels.sms && 'text'].filter(Boolean)
        setMsg(ch.length ? `Confirmation link sent via ${ch.join(' + ')}.` : 'No email/phone on file — add contact info and retry.')
      } else if (action === 'send-receipt' && j.channels) {
        const ch = [j.channels.email && 'email', j.channels.sms && 'text'].filter(Boolean)
        setMsg(ch.length ? `Receipt sent via ${ch.join(' + ')}.` : 'No email on file — use Copy Receipt Link to send it manually.')
      } else if (action === 'send-continuation' && j.channels) {
        const ch = [j.channels.email && 'email', j.channels.sms && 'text'].filter(Boolean)
        setMsg(ch.length ? `Continuation message sent via ${ch.join(' + ')}.` : 'No email/phone on file — copy the message and send it manually.')
      } else if (action === 'update' && body.status) {
        setMsg(`Status updated to "${STATUS_LABEL[String(body.status)] ?? String(body.status)}".`)
      } else setMsg('Done.')
      await onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy('') }
  }

  function copyLink() {
    navigator.clipboard?.writeText(link).then(() => setMsg('Link copied.'), () => setMsg(link))
  }

  const receiptUrl = link ? `${link}/receipt` : ''
  const paidInFull = netInvoice(b) > 0 && b.amountPaidCents >= netInvoice(b)
  // Refundable = positive confirmed Stripe charges − already-refunded amounts.
  const stripePaidCents = b.payments.filter(p => p.method === 'stripe' && p.status === 'confirmed' && p.amountCents > 0).reduce((s, p) => s + p.amountCents, 0)
  const refundedCents = b.payments.filter(p => p.amountCents < 0).reduce((s, p) => s - p.amountCents, 0)
  const refundable = stripePaidCents - refundedCents
  function approveRefund() {
    const input = prompt(`Refund amount ($). Up to $${(refundable / 100).toFixed(2)} on the Stripe charge — enter the policy-eligible amount:`, (refundable / 100).toFixed(2))
    if (input && parseFloat(input) > 0) run('refund', { amount: input }, `Issue a $${input} Stripe refund to the customer? This sends money back to their card.`)
  }
  function copyReceipt() {
    navigator.clipboard?.writeText(receiptUrl).then(() => setMsg('Receipt link copied — paste it to the customer.'), () => setMsg(receiptUrl))
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
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm font-semibold" style={{ color: 'var(--muted)', minWidth: 90 }}>Status</span>
          <select value={STATUS_OPTIONS.some(([v]) => v === b.status) ? b.status : ''} disabled={busy === 'update'}
            onChange={e => { if (e.target.value) run('update', { status: e.target.value }) }}
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 14, padding: '8px 12px', cursor: 'pointer', minWidth: 210 }}>
            {!STATUS_OPTIONS.some(([v]) => v === b.status) && <option value="">{STATUS_LABEL[b.status] ?? b.status}</option>}
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {busy === 'update' && <span className="text-xs" style={{ color: 'var(--muted)' }}>Saving…</span>}
        </div>
        <KV k="Phone" v={b.customerPhone} /><KV k="Email" v={b.customerEmail} />
        <KV k="Pickup" v={b.pickupAddress} /><KV k="Drop-off" v={b.dropoffAddress} /><KV k="Job Site" v={b.jobSiteAddress} />
        <KV k="Service Date" v={serviceDateLong(b)} />
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-sm font-semibold" style={{ color: 'var(--muted)', minWidth: 90 }}>Lead</span>
          <select value={b.assignedTo ?? ''} disabled={busy === 'assign'} onChange={e => run('assign', { assignedTo: e.target.value })}
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 14, padding: '8px 12px', cursor: 'pointer', minWidth: 150 }}>
            <option value="">Unassigned</option>
            {staffNames.map(n => <option key={n} value={n}>{n}</option>)}
            {b.assignedTo && !staffNames.includes(b.assignedTo) && <option value={b.assignedTo}>{b.assignedTo}</option>}
          </select>
          {staffNames.length === 0 && <a href="/admin/staff" className="text-xs font-semibold" style={{ color: 'var(--red)' }}>+ Add crew</a>}
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-sm font-semibold" style={{ color: 'var(--muted)', minWidth: 90 }}>Helper</span>
          <select value={b.assignedHelper ?? ''} disabled={busy === 'assign'} onChange={e => run('assign', { assignedHelper: e.target.value })}
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 14, padding: '8px 12px', cursor: 'pointer', minWidth: 150 }}>
            <option value="">None</option>
            {staffNames.map(n => <option key={n} value={n}>{n}</option>)}
            {b.assignedHelper && !staffNames.includes(b.assignedHelper) && <option value={b.assignedHelper}>{b.assignedHelper}</option>}
          </select>
        </div>
        {b.description && <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>{b.description}</p>}
        {b.items.length > 0 && <ul className="text-sm mt-2 space-y-0.5" style={{ color: 'var(--muted)' }}>{b.items.map((i, n) => <li key={n}>• {i}</li>)}</ul>}
        {b.invoicePhotos && b.invoicePhotos.length > 0 && (
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 mt-3">
            {b.invoicePhotos.map((p, n) => (
              <a key={n} href={p.url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.1)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.name ?? `Photo ${n + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {(([['overview', 'Overview'], ['messages', 'Messages'], ['timeline', 'Timeline'], ['actions', 'Actions']]) as [typeof tabKey, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTabKey(k)} style={{
            fontSize: 13, fontWeight: 800, padding: '8px 16px', borderRadius: 10, whiteSpace: 'nowrap', cursor: 'pointer', border: '1px solid',
            background: tabKey === k ? 'var(--red)' : 'rgba(255,255,255,.05)',
            borderColor: tabKey === k ? 'var(--red)' : 'rgba(255,255,255,.1)',
            color: tabKey === k ? '#fff' : 'var(--muted)',
          }}>{label}</button>
        ))}
      </div>

      {tabKey === 'overview' && (
      <>
      {/* Money */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Payment — {paySummary(b)}</p>
        <KV k="Invoice Total" v={usd(b.invoiceAmountCents)} />
        {!!b.discountCents && b.discountCents > 0 && <KV k={`Discount${b.promoCode ? ` (${b.promoCode})` : ''}`} v={`– ${usd(b.discountCents)}`} />}
        {b.depositAmountCents > 0 && <KV k="Deposit" v={usd(b.depositAmountCents)} />}
        <KV k="Amount Paid" v={usd(b.amountPaidCents)} />
        <KV k="Balance Due" v={usd(balanceDue(b))} />
        <div className="flex flex-wrap gap-2 mt-3">
          {b.depositAmountCents > b.amountPaidCents && <ActBtn label="Mark Deposit Paid" busy={busy === 'mark-deposit-paid'} onClick={() => run('mark-deposit-paid')} />}
          {balanceDue(b) > 0 && <ActBtn label="Mark Paid in Full" busy={busy === 'mark-paid-full'} onClick={() => run('mark-paid-full')} />}
          {refundable > 0 && <ActBtn label={`Approve Refund (≤ ${usd(refundable)})`} danger busy={busy === 'refund'} onClick={approveRefund} />}
        </div>
        {paidInFull && (
          <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
            <p className="text-xs font-semibold mb-2" style={{ color: '#34d399' }}>✓ Paid in full — final receipt is ready to share.</p>
            <div className="flex flex-wrap gap-2">
              <ActBtn label="Copy Receipt Link" onClick={copyReceipt} />
              {b.customerEmail && <ActBtn label="Email Receipt" primary busy={busy === 'send-receipt'} onClick={() => run('send-receipt')} />}
            </div>
            <a href={receiptUrl} target="_blank" rel="noreferrer" className="block text-xs mt-2 font-mono break-all" style={{ color: 'var(--red)' }}>{receiptUrl}</a>
          </div>
        )}
        {b.payments.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {b.payments.map(p => <PaymentRow key={p.id} p={p} onConfirm={() => run('confirm-payment', { paymentId: p.id })} onVoid={() => run('void-payment', { paymentId: p.id }, `Remove this ${usd(p.amountCents)} payment record? It will be subtracted from Amount Paid. Do this only if it was entered by mistake or duplicates a payment already recorded.`)} busy={busy === 'confirm-payment' || busy === 'void-payment'} />)}
          </div>
        )}
        {pendingPayments.length > 0 && <p className="text-xs mt-2" style={{ color: '#fbbf24' }}>⚠ {pendingPayments.length} customer-reported payment(s) need confirmation.</p>}
      </div>

      {/* Zelle payment review — screenshot + verify/reject */}
      {b.payments.some(p => p.method === 'zelle' && !!p.proofPath) && (
        <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px', border: '1px solid rgba(192,132,252,.35)' }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#c084fc' }}>🏦 Zelle Payment Review</p>
          {b.payments.filter(p => p.method === 'zelle' && !!p.proofPath).map(p => <ZelleReview key={p.id} p={p} />)}
        </div>
      )}

      {/* Multi-day / continuation */}
      <ContinuationCard b={b} run={run} busy={busy} />

      {/* Disposal & profit */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Disposal &amp; Profit</p>
        {!!b.disposalEstimateCents && <KV k="Estimated Disposal" v={usd(b.disposalEstimateCents)} />}
        <form key={b.token} onSubmit={e => { e.preventDefault(); const v = new FormData(e.currentTarget).get('disposalActual'); run('set-disposal', { disposalActual: v }) }} className="flex items-end gap-2 mt-1">
          <div className="flex-1">
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>Actual disposal cost ($)</label>
            <input name="disposalActual" inputMode="decimal" defaultValue={b.disposalActualCents ? (b.disposalActualCents / 100).toFixed(2) : ''} placeholder="0.00"
              style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 15, outline: 'none' }} />
          </div>
          <button type="submit" disabled={busy === 'set-disposal'} className="btn-ghost" style={{ padding: '9px 16px', fontSize: 13 }}>{busy === 'set-disposal' ? '…' : 'Save'}</button>
        </form>
        {(() => {
          const disposal = b.disposalActualCents ?? b.disposalEstimateCents ?? 0
          const net = b.amountPaidCents - disposal
          return (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
              <KV k="Collected" v={usd(b.amountPaidCents)} />
              <KV k={`Net after disposal${b.disposalActualCents ? '' : ' (est.)'}`} v={usd(net)} />
            </div>
          )
        })()}
        <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>Enter the real dump cost after the job — it feeds your profit reporting on the dashboard.</p>
      </div>
      </>
      )}

      {tabKey === 'actions' && (
      <>
      {/* Actions */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Actions</p>
        <div className="flex flex-wrap gap-2">
          <ActBtn label="Copy Link" onClick={copyLink} />
          <ActBtn label={b.confirmationLinkSentAt ? 'Resend Confirmation Link' : 'Send Confirmation Link'} primary busy={busy === 'send-link'} onClick={() => run('send-link')} />
          <ActBtn label="Add Note" onClick={() => { const n = prompt('Internal note:'); if (n) run('add-note', { note: n }) }} />
          <ActBtn label="Edit" onClick={onEdit} />
          <ActBtn label="Duplicate" onClick={onDuplicate} />
          {b.status !== 'completed' && <ActBtn label="Mark Completed" busy={busy === 'mark-completed'} onClick={() => run('mark-completed', {}, 'Mark this job completed?')} />}
          {b.status !== 'cancelled' && <ActBtn label="Cancel Booking" danger onClick={() => { const r = prompt('Cancellation reason (optional):') ?? ''; run('cancel', { reason: r }, 'Cancel this booking?') }} />}
          {b.archived
            ? <ActBtn label="Unarchive" busy={busy === 'unarchive'} onClick={() => run('unarchive')} />
            : <ActBtn label="Archive" busy={busy === 'archive'} onClick={() => run('archive', {}, 'Archive this booking? It will be hidden from the default list but kept for your records.')} />}
          <ActBtn label="Delete" danger busy={busy === 'delete'} onClick={del} />
        </div>
        <a href={link} target="_blank" rel="noreferrer" className="block text-xs mt-3 font-mono break-all" style={{ color: 'var(--red)' }}>{link}</a>
        {msg && <p className="text-sm mt-2" style={{ color: '#34d399' }}>{msg}</p>}
        {err && <p className="text-sm mt-2" style={{ color: '#f87171' }}>{err}</p>}
      </div>
      </>
      )}

      {tabKey === 'messages' && (
      <>
      {/* Message Customer */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px', border: '1px solid rgba(224,0,42,.22)' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: 'var(--muted)' }}>💬 Message Customer</p>
        <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
          {b.customerPhone ? `Text → ${b.customerPhone}` : 'No phone on file'} · {b.customerEmail ? `Email → ${b.customerEmail}` : 'No email on file'}
        </p>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>Template</label>
        <select value={msgTpl} onChange={e => applyTemplate(e.target.value)}
          style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 14, padding: '9px 12px', cursor: 'pointer', marginBottom: 10 }}>
          <option value="">Choose a template…</option>
          {MSG_TEMPLATES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>

        <textarea value={msgText} onChange={e => { setMsgText(e.target.value); setMsgInfo(''); setMsgErr('') }} rows={6}
          placeholder="Write a message to the customer, or pick a template above…"
          style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 14, padding: '10px 12px', outline: 'none', resize: 'vertical', lineHeight: 1.5 }} />
        <div className="flex items-center justify-between mt-1 gap-2 flex-wrap">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{msgText.length} chars</span>
          <button onClick={improveWithAI} disabled={aiBusy === 'improve' || !msgText.trim()} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>{aiBusy === 'improve' ? 'Improving…' : '✨ Improve with AI'}</button>
        </div>
        <AiFeedback callId={msgCallId} />

        <div className="flex flex-wrap gap-2 mt-3">
          <button onClick={() => sendMessage('sms')} disabled={!b.customerPhone || !!msgBusy} className="text-xs font-bold px-4 py-2 rounded-lg"
            style={{ background: 'var(--red)', border: '1px solid var(--red)', color: '#fff', opacity: !b.customerPhone || !!msgBusy ? 0.5 : 1 }}>{msgBusy === 'sms' ? 'Sending…' : 'Send SMS'}</button>
          <button onClick={() => sendMessage('email')} disabled={!b.customerEmail || !!msgBusy} className="text-xs font-bold px-4 py-2 rounded-lg"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', color: 'var(--text)', opacity: !b.customerEmail || !!msgBusy ? 0.5 : 1 }}>{msgBusy === 'email' ? 'Sending…' : 'Send Email'}</button>
          <button onClick={() => sendMessage('both')} disabled={(!b.customerPhone && !b.customerEmail) || !!msgBusy} className="text-xs font-bold px-4 py-2 rounded-lg"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', color: 'var(--text)', opacity: (!b.customerPhone && !b.customerEmail) || !!msgBusy ? 0.5 : 1 }}>{msgBusy === 'both' ? 'Sending…' : 'Send Both'}</button>
        </div>
        {msgInfo && <p className="text-sm mt-2" style={{ color: '#34d399' }}>{msgInfo}</p>}
        {msgErr && <p className="text-sm mt-2" role="alert" style={{ color: '#f87171' }}>{msgErr}</p>}

        {/* Unified conversation — the full text/email thread, both directions */}
        <div className="mt-5 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Conversation</p>
          <BookingMessages token={b.token} customerName={b.customerName} reloadKey={msgReload} communications={b.communications} />
        </div>
      </div>
      </>
      )}

      {tabKey === 'timeline' && (
      <>
      {/* Customer timeline */}
      <Timeline b={b} />

      {/* Structured, attributed audit trail + owner-notification delivery ledger */}
      {(!!b.events?.length || !!b.notifications?.length) && (
        <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Audit &amp; Notifications</p>
          {!!b.notifications?.length && (
            <div className="mb-3">
              <p className="text-xs font-semibold mb-1" style={{ color: '#c084fc' }}>Owner notifications</p>
              {[...b.notifications].reverse().map(n => (
                <div key={n.id} className="text-xs flex justify-between gap-2 py-0.5" style={{ color: 'var(--muted)' }}>
                  <span>{n.kind.replace(/_/g, ' ')} · {n.channel}{n.retryCount ? ` · retry ${n.retryCount}` : ''}{n.error ? ` · ${n.error}` : ''}</span>
                  <span className="shrink-0" style={{ color: n.status === 'sent' ? '#34d399' : '#f87171' }}>{n.status} · {fmtTs(n.at)}</span>
                </div>
              ))}
            </div>
          )}
          {!!b.events?.length && (
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--muted)' }}>Event history</p>
              {[...b.events].reverse().map((e, i) => (
                <div key={i} className="text-xs flex justify-between gap-2 py-0.5" style={{ color: 'var(--muted)' }}>
                  <span>{e.action.replace(/[._]/g, ' ')}{e.result ? ` · ${e.result}` : ''}</span>
                  <span className="shrink-0">{e.actor} · {fmtTs(e.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
      </>
      )}
    </div>
  )

  function PaymentRow({ p, onConfirm, onVoid, busy }: { p: Payment; onConfirm: () => void; onVoid: () => void; busy: boolean }) {
    // A customer-reported payment that matches the amount of a payment already
    // confirmed is almost certainly the same money reported twice — confirming
    // it would double-count. Flag it so the admin voids instead of confirms.
    const likelyDuplicate = p.status === 'sent_by_customer' &&
      b.payments.some(q => q.id !== p.id && q.status === 'confirmed' && q.amountCents === p.amountCents)
    const confirmDup = () => {
      if (confirm(`Heads up: a confirmed ${usd(p.amountCents)} payment is already on this booking. If this is the SAME payment the customer is re-reporting, press Cancel and use "Void" instead — confirming will double-count it.\n\nConfirm anyway as a separate payment?`)) onConfirm()
    }
    return (
      <div className="flex items-center justify-between gap-2 text-xs p-2 rounded-lg" style={{ background: 'rgba(255,255,255,.03)' }}>
        <span style={{ color: 'var(--muted)' }}>
          {usd(p.amountCents)} · {p.method} · {p.type} · <span style={{ color: p.status === 'confirmed' ? '#34d399' : '#fbbf24' }}>{p.status.replace(/_/g, ' ')}</span>
          {p.feeCents > 0 && <> · fee {usd(p.feeCents)}</>}
          {likelyDuplicate && <span style={{ color: '#fbbf24' }}> · ⚠ possible duplicate</span>}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {p.status === 'sent_by_customer' && <button onClick={likelyDuplicate ? confirmDup : onConfirm} disabled={busy} className="font-bold px-2 py-1 rounded" style={{ background: 'var(--red)', color: '#fff' }}>Confirm</button>}
          <button onClick={onVoid} disabled={busy} className="font-semibold px-2 py-1 rounded" style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.3)', color: '#ff6680' }}>Void</button>
        </span>
      </div>
    )
  }

  // A Zelle payment awaiting review: its sealed screenshot (served decrypted, admin-
  // only) + Approve / Reject / Resend-owner-alert. The blob path is never in the DOM.
  function ZelleReview({ p }: { p: Payment }) {
    const pending = p.status === 'sent_by_customer'
    const src = `/api/admin/bookings/${b.token}/proof?p=${p.id}`
    return (
      <div className="mb-3 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
          {usd(p.amountCents)} · {p.type} · <span style={{ color: p.status === 'confirmed' ? '#34d399' : p.status === 'failed' ? '#f87171' : '#c084fc' }}>{p.status.replace(/_/g, ' ')}</span>
          {p.reference && <> · ref {p.reference}</>}
          {p.reviewedAt && <> · reviewed {fmtTs(p.reviewedAt)}</>}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="Zelle payment confirmation" style={{ maxWidth: '100%', maxHeight: 340, borderRadius: 12, border: '1px solid rgba(255,255,255,.1)', display: 'block' }} /></a>
        {p.rejectionReason && <p className="text-xs mt-1.5" style={{ color: '#f87171' }}>Rejected: {p.rejectionReason}</p>}
        {!!p.proofHistory?.length && <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{p.proofHistory.length} earlier screenshot(s) kept for audit.</p>}
        {pending && (
          <div className="flex flex-wrap gap-2 mt-2.5">
            <ActBtn label="✓ Approve Zelle Payment" primary busy={busy === 'approve-zelle'} onClick={() => run('approve-zelle', { paymentId: p.id })} />
            <ActBtn label="Reject" danger busy={busy === 'reject-zelle'} onClick={() => { const r = prompt('Reason for rejecting (shown to the customer):'); if (r !== null) run('reject-zelle', { paymentId: p.id, reason: r }) }} />
            <ActBtn label="Resend Owner Alert" busy={busy === 'resend-notification'} onClick={() => run('resend-notification', { kind: 'zelle_review' })} />
          </div>
        )}
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
function BookingForm({ booking, prefill, onClose, onSaved }: { booking?: Booking; prefill?: Prefill; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const edit = !!booking
  const np = (booking?.customerName ?? prefill?.name ?? '').trim().split(/\s+/).filter(Boolean)
  const firstName = np[0] ?? ''
  const lastName = np.slice(1).join(' ')

  // Invoice date defaults to today (long form, matching the stored display style).
  const todayLong = useMemo(() => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), [])
  // Today as yyyy-mm-dd in LOCAL time (for the calendar default — never UTC, which can roll to yesterday).
  const todayISO = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  // Service date(s) the customer can pick from — each is its own editable calendar
  // field. New bookings default to today; add more rows only to offer options.
  const [dates, setDates] = useState<string[]>(booking?.availableDates?.length ? booking.availableDates : [todayISO])

  // Auto-send the customer their confirmation link on create (new bookings only).
  const [sendLinkNow, setSendLinkNow] = useState(true)

  // Crew roster names → datalist for the Assigned To field.
  const [staffNames, setStaffNames] = useState<string[]>([])
  useEffect(() => {
    fetch('/api/admin/staff', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.items) setStaffNames(j.items.filter((s: { active: boolean }) => s.active).map((s: { name: string }) => s.name)) })
      .catch(() => {})
  }, [])

  // Invoice photos — uploaded straight to Vercel Blob, stored as URLs.
  const [photos, setPhotos] = useState<InvoicePhoto[]>(booking?.invoicePhotos ?? [])
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) return
    setUploadErr(''); setUploading(true)
    try {
      for (const file of files) {
        const body = await downscaleImage(file)
        const blob = await upload(file.name, body, { access: 'public', handleUploadUrl: '/api/admin/blob-upload' })
        setPhotos(prev => [...prev, { url: blob.url, name: file.name }])
      }
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed — make sure Blob storage is connected.')
    } finally { setUploading(false) }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true); setErr('')
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, unknown>
    // Combine first/last into the stored customerName; normalize the checkbox.
    const fn = String(f.customerFirstName ?? '').trim(); const ln = String(f.customerLastName ?? '').trim()
    f.customerName = `${fn} ${ln}`.trim()
    delete f.customerFirstName; delete f.customerLastName
    f.collectInPerson = 'collectInPerson' in f ? 'true' : 'false'
    f.availableDates = dates.filter(Boolean).join('\n')
    f.invoicePhotos = photos
    f.sendLinkNow = sendLinkNow
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
  // Bigger touch targets + 16px font (stops iOS from zooming on focus) = easy on mobile.
  const fStyle: React.CSSProperties = { ...iStyle, fontSize: '16px', padding: '12px 14px' }
  const dateStyle: React.CSSProperties = { ...fStyle, width: 'auto', cursor: 'pointer', colorScheme: 'dark' }

  return (
    <form onSubmit={submit} className="glass-card p-5 space-y-4" style={{ borderRadius: '16px', borderColor: 'rgba(224,0,42,.3)' }}>
      <p className="text-sm font-bold text-white">{edit ? `Edit ${booking!.bookingNumber}` : 'New Booking'}</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label style={lab}>First Name *</label><input name="customerFirstName" required autoCapitalize="words" defaultValue={firstName} style={fStyle} /></div>
        <div><label style={lab}>Last Name</label><input name="customerLastName" autoCapitalize="words" defaultValue={lastName} style={fStyle} /></div>
        <div><label style={lab}>Phone</label><input name="customerPhone" type="tel" inputMode="tel" autoComplete="tel" defaultValue={booking?.customerPhone ?? prefill?.phone} style={fStyle} /></div>
        <div><label style={lab}>Email</label><input name="customerEmail" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" defaultValue={booking?.customerEmail ?? prefill?.email} style={fStyle} /></div>
        <div><label style={lab}>Service Type</label><select name="serviceType" defaultValue={booking?.serviceType ?? prefill?.service ?? 'moving'} style={{ ...fStyle, cursor: 'pointer' }}>{SERVICE_TYPES.map(s => <option key={s} value={s}>{SERVICE_LABELS[s]}</option>)}</select></div>
        <div><label style={lab}>Invoice #</label><input name="invoiceNumber" defaultValue={booking?.invoiceNumber} placeholder="Auto-generated if blank" style={fStyle} /></div>
        <div><label style={lab}>Invoice Date</label><input name="invoiceDate" defaultValue={booking?.invoiceDate ?? todayLong} placeholder="June 16, 2026" style={fStyle} /></div>
        <div><label style={lab}>Invoice Amount ($)</label><input name="invoiceAmount" inputMode="decimal" defaultValue={dollars(booking?.invoiceAmountCents) || prefill?.invoiceAmount} placeholder="550.00" style={fStyle} /></div>
        <div><label style={lab}>Deposit ($)</label><input name="depositAmount" inputMode="decimal" defaultValue={dollars(booking?.depositAmountCents) || prefill?.deposit} placeholder="150.00" style={fStyle} /></div>
        <div><label style={lab}>Discount ($)</label><input name="discountAmount" inputMode="decimal" defaultValue={dollars(booking?.discountCents) || prefill?.discount} placeholder="0.00" style={fStyle} /></div>
        <div><label style={lab}>Disposal Est. ($)</label><input name="disposalEstimate" inputMode="decimal" defaultValue={dollars(booking?.disposalEstimateCents) || prefill?.disposalEst} placeholder="0.00" style={fStyle} /></div>
        <div><label style={lab}>Crew Size</label><input name="crewSize" inputMode="numeric" defaultValue={booking?.crewSize ?? prefill?.crewSize ?? ''} placeholder="2" style={fStyle} /></div>
        <div><label style={lab}>Estimated Hours</label><input name="estimatedHours" inputMode="numeric" defaultValue={booking?.estimatedHours ?? prefill?.estimatedHours ?? ''} placeholder="5" style={fStyle} /></div>
        <div><label style={lab}>Assigned To (lead)</label><input name="assignedTo" list="staff-roster" defaultValue={booking?.assignedTo ?? prefill?.assignedTo} placeholder="Crew member" style={fStyle} /><datalist id="staff-roster">{staffNames.map(n => <option key={n} value={n} />)}</datalist></div>
        <div><label style={lab}>Helper (crew)</label><input name="assignedHelper" list="staff-roster" defaultValue={booking?.assignedHelper} placeholder="Second crew member" style={fStyle} /></div>
      </div>
      <div><label style={lab}>Pickup Address</label><input name="pickupAddress" defaultValue={booking?.pickupAddress ?? prefill?.pickup} style={fStyle} /></div>
      <div><label style={lab}>Drop-off Address</label><input name="dropoffAddress" defaultValue={booking?.dropoffAddress ?? prefill?.dropoff} style={fStyle} /></div>
      <div><label style={lab}>Job Site Address (if single-site)</label><input name="jobSiteAddress" defaultValue={booking?.jobSiteAddress ?? prefill?.jobSite} style={fStyle} /></div>
      <div><label style={lab}>Description</label><textarea name="description" rows={2} defaultValue={booking?.description ?? prefill?.desc} style={{ ...fStyle, resize: 'vertical' }} /></div>
      <div><label style={lab}>Items (one per line)</label><textarea name="items" rows={3} defaultValue={booking?.items?.join('\n') ?? prefill?.items} placeholder={'40 boxes\nRefrigerator\nDresser\nCouch\nGrill'} style={{ ...fStyle, resize: 'vertical' }} /></div>

      {/* ── Invoice photos ─────────────────────────────────────────── */}
      <div>
        <label style={lab}>Invoice Photos</label>
        <label className="btn-ghost" style={{ padding: '12px 18px', fontSize: 14, cursor: uploading ? 'wait' : 'pointer', display: 'inline-flex' }}>
          {uploading ? 'Uploading…' : photos.length ? '+ Add More Photos' : '+ Add Photos'}
          <input type="file" accept="image/*" multiple onChange={onPickFiles} disabled={uploading} style={{ display: 'none' }} />
        </label>
        {uploadErr && <p className="text-sm mt-2" style={{ color: '#f87171' }}>{uploadErr}</p>}
        {photos.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-3">
            {photos.map(p => (
              <div key={p.url} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,.1)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.name ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button type="button" onClick={() => setPhotos(prev => prev.filter(x => x.url !== p.url))} aria-label="Remove photo"
                  style={{ position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.65)', color: '#fff', cursor: 'pointer', fontSize: 16, lineHeight: '26px' }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Service date(s) via calendar ───────────────────────────── */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label style={lab}>Service Date(s) — pick from calendar</label>
          <div className="space-y-2">
            {dates.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="date" value={d} onChange={e => setDates(prev => prev.map((x, idx) => idx === i ? e.target.value : x))} style={dateStyle} />
                {dates.length > 1 && (
                  <button type="button" onClick={() => setDates(prev => prev.filter((_, idx) => idx !== i))} aria-label="Remove date"
                    style={{ border: '1px solid rgba(255,255,255,.15)', background: 'rgba(255,255,255,.05)', color: 'var(--muted)', borderRadius: 8, padding: '10px 14px', cursor: 'pointer', fontSize: 13 }}>Remove</button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setDates(prev => [...prev, ''])} className="btn-ghost" style={{ padding: '10px 16px', fontSize: 13, marginTop: 8, display: 'inline-flex' }}>+ Add another date option</button>
          <p style={{ ...lab, marginTop: 8, marginBottom: 0 }}>Defaults to today — change it to any date. Add more only if you want to offer the customer options.</p>
        </div>
        <div><label style={lab}>Arrival Windows (one per line)</label><textarea name="availableWindows" rows={4} defaultValue={booking?.availableWindows?.join('\n')} placeholder={'8am–9am\n9am–10am\n10am–11am\n11am–12pm\n12pm–1pm\n1pm–2pm'} style={{ ...fStyle, resize: 'vertical' }} /></div>
      </div>

      <label className="flex items-center gap-2.5 text-sm py-1" style={{ color: 'var(--text)' }}>
        <input type="checkbox" name="collectInPerson" defaultChecked={!!booking?.collectInPerson} style={{ width: 18, height: 18, accentColor: '#E0002A', flexShrink: 0 }} />
        Collect balance in person — show remaining balance as optional on the link (due at end of service), don&apos;t require online payment
      </label>
      <div><label style={lab}>Internal Notes (ops only)</label><textarea name="internalNotes" rows={2} defaultValue={booking?.internalNotes} style={{ ...fStyle, resize: 'vertical' }} /></div>
      {!edit && (
        <label className="flex items-center gap-2.5 text-sm py-1" style={{ color: 'var(--text)' }}>
          <input type="checkbox" checked={sendLinkNow} onChange={e => setSendLinkNow(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#E0002A', flexShrink: 0 }} />
          Text/email the customer their confirmation link as soon as I create this booking
        </label>
      )}
      {err && <p className="text-sm" style={{ color: '#f87171' }}>{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving || uploading} className="btn" style={{ padding: '14px 22px', fontSize: '15px', flex: 1 }}>{saving ? 'Saving…' : edit ? 'Save Changes' : 'Create Booking'}</button>
        <button type="button" onClick={onClose} className="btn-ghost" style={{ padding: '14px 22px', fontSize: '15px' }}>Cancel</button>
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
