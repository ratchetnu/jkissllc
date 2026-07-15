'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Zap, Search, Camera, ChevronRight, ChevronDown, RefreshCw, ArrowUpDown, Rows3,
  LayoutGrid, X, Phone, Mail, ExternalLink, SlidersHorizontal,
} from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { fmtTs, money } from '../ui'
import { Drawer } from '../../../components/ui/overlays'
import { EmptyState } from '../../../components/ui/primitives'
import { SERVICE_LABELS, type Booking } from '../../../lib/bookings'
import {
  bookNowStage, bookNowServiceGroup, matchesBookNowFilter, isEstateBooking,
  aiStatus, quoteStatus, paymentStatus, ownerAlertStatus, confirmationStatus,
  isBookedOn,
  BOOK_NOW_STAGE_LABEL, type BookNowFilter, type BookNowStage,
} from '../../../lib/book-now-queue'
import { CLEANOUT_SUBTYPE_LABEL, type CleanoutSubtype } from '../../../lib/ai/confirmation-schema'

const SEEN_KEY = 'jkos-booknow-seen'
const GROUP_LABEL: Record<string, string> = { junk: 'Junk Removal', moving: 'Moving', delivery: 'Delivery', other: 'Service' }

const STAGE_TONE: Record<BookNowStage, string> = {
  new: '#f87171', awaiting_photos: '#fbbf24', awaiting_ai: '#fbbf24',
  ai_queued: '#fbbf24', ai_processing: '#60a5fa', ai_failed: '#f87171',
  final_processing: '#60a5fa', awaiting_owner_approval: '#c084fc', site_visit: '#f59e0b',
  quote_ready: '#60a5fa', manual_review: '#c084fc', quote_sent: '#60a5fa', payment_pending: '#fbbf24',
  paid: '#34d399', booked: '#34d399', failed: '#f87171',
}

// The complete filter set (value → label) — preserved for deep-linking + counts.
const FILTERS: [BookNowFilter, string][] = [
  ['all', 'All'], ['new', 'New'],
  ['junk', 'Junk Removal'], ['estate', 'Estate Cleanout'], ['moving', 'Moving'], ['delivery', 'Delivery'],
  ['awaiting_ai', 'Awaiting AI'],
  ['awaiting_photos', 'Awaiting Photos'], ['ai_queued', 'AI Queued'], ['ai_processing', 'AI Processing'], ['ai_failed', 'AI Failed'],
  ['site_visit', 'Site Visit'], ['manual_review', 'Manual Review'], ['awaiting_approval', 'Awaiting Approval'], ['quote_ready', 'Quote Ready'], ['quote_sent', 'Quote Sent'],
  ['accepted', 'Accepted'], ['payment_pending', 'Payment Pending'], ['paid', 'Paid'], ['booked', 'Booked'], ['failed', 'Failed'],
]
const FILTER_LABEL = Object.fromEntries(FILTERS) as Record<BookNowFilter, string>

// Grouped filter architecture — the same 20 values, organized so the page stops
// being a wall of equal-weight pills. One group expanded at a time.
const FILTER_GROUPS: { id: string; label: string; items: BookNowFilter[] }[] = [
  { id: 'services', label: 'Services', items: ['junk', 'estate', 'moving', 'delivery'] },
  { id: 'ai', label: 'AI Status', items: ['awaiting_photos', 'ai_queued', 'ai_processing', 'ai_failed'] },
  { id: 'pipeline', label: 'Sales Pipeline', items: ['site_visit', 'manual_review', 'awaiting_approval', 'quote_ready', 'quote_sent', 'accepted', 'payment_pending', 'paid', 'booked', 'failed'] },
]

type SortKey = 'created' | 'customer' | 'stage' | 'priority'
type ViewMode = 'table' | 'cards'

function locationLabel(b: Booking): string {
  return b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || '—'
}
function requestedDate(b: Booking): string | undefined {
  return b.bookNow?.requestedDate || b.availableDates?.[0]
}
// UI-derived operator priority (no schema change) — how urgently this needs a human.
function priorityOf(stage: BookNowStage): { label: string; tone: string; rank: number } {
  if (['ai_failed', 'manual_review', 'awaiting_owner_approval', 'site_visit'].includes(stage)) return { label: 'High', tone: '#f87171', rank: 3 }
  if (['new', 'quote_ready', 'payment_pending', 'awaiting_photos'].includes(stage)) return { label: 'Med', tone: '#fbbf24', rank: 2 }
  return { label: 'Low', tone: 'var(--muted)', rank: 1 }
}
// Estimated pending revenue for an open (unpaid) request — best available number.
function pendingRevenueCents(b: Booking): number {
  if (paymentStatus(b) === 'paid') return 0
  if (b.invoiceAmountCents) return b.invoiceAmountCents
  if (b.bookNow?.shownEstimateHighCents) return b.bookNow.shownEstimateHighCents
  const rec = b.aiEstimate?.pricing?.recommendedUsd
  return rec ? Math.round(rec * 100) : 0
}
// ── Rich AI status indicator ─────────────────────────────────────────────────
function AiBadge({ b }: { b: Booking }) {
  const s = aiStatus(b)
  const map: Record<string, { label: string; tone: string; pulse?: boolean }> = {
    none: { label: 'Awaiting photos', tone: '#fbbf24' },
    queued: { label: 'AI queued', tone: '#fbbf24' },
    processing: { label: 'AI processing', tone: '#60a5fa', pulse: true },
    review: { label: 'Manual review', tone: '#c084fc' },
    failed: { label: 'AI failed', tone: '#f87171' },
    priced: { label: 'AI complete', tone: '#34d399' },
  }
  const m = map[s] ?? { label: s, tone: 'var(--muted)' }
  const conf = b.aiEstimate?.analysis?.confidence?.overall
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: m.tone, whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: m.tone, boxShadow: `0 0 0 3px color-mix(in srgb, ${m.tone} 20%, transparent)` }} className={m.pulse ? 'bn-pulse' : undefined} />
      {m.label}
      {s === 'priced' && typeof conf === 'number' && <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{Math.round(conf * 100)}%</span>}
    </span>
  )
}

function MiniStatus({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
      {label} <span style={{ fontWeight: 700, color: tone ?? 'var(--text)' }}>{value}</span>
    </span>
  )
}

function StageTag({ stage }: { stage: BookNowStage }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color: STAGE_TONE[stage], background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>{BOOK_NOW_STAGE_LABEL[stage]}</span>
}

// ── KPI card ─────────────────────────────────────────────────────────────────
function Kpi({ label, value, tone, active, onClick }: { label: string; value: string; tone: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="os-card os-tap"
      style={{ minWidth: 148, flex: '1 0 148px', textAlign: 'left', padding: '13px 15px', cursor: 'pointer', borderColor: active ? tone : undefined, borderLeftWidth: 3, borderLeftColor: tone }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', lineHeight: 1 }} className="tabular-nums">{value}</div>
    </button>
  )
}

function DrawerRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '7px 0', borderTop: '1px solid var(--line)', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right', fontWeight: 600, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}
function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

// ── Slide-over request drawer (view + quick actions; full editor via link) ────
function RequestDrawer({ b, unread, onToggleSeen, onClose }: { b: Booking; unread: boolean; onToggleSeen: () => void; onClose: () => void }) {
  const stage = bookNowStage(b)
  const ai = b.aiEstimate
  const conf = ai?.analysis?.confidence?.overall
  const p = ai?.pricing
  const photos = b.invoicePhotos ?? []
  return (
    <div style={{ padding: '4px 2px 40px' }}>
      {/* header badges */}
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 6 }}>
        <StageTag stage={stage} />
        {isEstateBooking(b) && <span style={{ background: '#7c3aed', color: '#fff', borderRadius: 6, fontSize: 9.5, fontWeight: 800, padding: '2px 6px' }}>🏠 ESTATE</span>}
        {(b.finalAiEstimate?.sensitiveItems?.length ?? 0) > 0 && <span style={{ fontSize: 10, fontWeight: 800, color: '#f87171', border: '1px solid #f87171', borderRadius: 999, padding: '1px 7px' }}>⚠ SENSITIVE</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {GROUP_LABEL[bookNowServiceGroup(b.serviceType)]} · {SERVICE_LABELS[b.serviceType] ?? b.serviceType} · <span className="font-mono">{b.bookingNumber}</span>
      </div>
      {b.confirmation?.estate?.subtype && (
        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#a78bfa', marginTop: 4 }}>
          {CLEANOUT_SUBTYPE_LABEL[b.confirmation.estate.subtype as CleanoutSubtype]}
          {b.confirmation.estate.deadlineType && b.confirmation.estate.deadlineType !== 'none' ? ` · ${b.confirmation.estate.deadlineType} deadline${b.confirmation.estate.deadlineDate ? ` ${b.confirmation.estate.deadlineDate}` : ''}` : ''}
        </div>
      )}

      {/* quick actions */}
      <div className="flex flex-wrap gap-2" style={{ marginTop: 14 }}>
        <Link href={`/admin/operations/book-now/${b.token}`} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, background: 'var(--red)', color: '#fff', borderRadius: 10, padding: '9px 14px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Open full detail & actions <ExternalLink size={13} />
        </Link>
        {b.customerPhone && <a href={`tel:${b.customerPhone}`} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 10, padding: '9px 12px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Phone size={13} /> Call</a>}
        {b.customerEmail && <a href={`mailto:${b.customerEmail}`} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 10, padding: '9px 12px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Mail size={13} /> Email</a>}
        <button onClick={onToggleSeen} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--muted)', borderRadius: 10, padding: '9px 12px', cursor: 'pointer' }}>{unread ? 'Mark read' : 'Mark unread'}</button>
      </div>

      <DrawerSection title="Customer">
        <DrawerRow k="Name" v={b.customerName} />
        {b.customerPhone && <DrawerRow k="Phone" v={b.customerPhone} />}
        {b.customerEmail && <DrawerRow k="Email" v={b.customerEmail} />}
        {b.bookNow?.contactMethod && <DrawerRow k="Prefers" v={b.bookNow.contactMethod} />}
        <DrawerRow k="Location" v={locationLabel(b)} />
        {requestedDate(b) && <DrawerRow k="Requested date" v={requestedDate(b)!} />}
        {!!b.createdAt && <DrawerRow k="Submitted" v={fmtTs(b.createdAt)} />}
      </DrawerSection>

      {photos.length > 0 && (
        <DrawerSection title={`Photos (${photos.length})`}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 6 }}>
            {photos.map((ph, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={i} href={ph.url} target="_blank" rel="noreferrer"><img src={ph.url} alt={ph.name || `Photo ${i + 1}`} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} /></a>
            ))}
          </div>
        </DrawerSection>
      )}

      <DrawerSection title="AI Analysis">
        <div style={{ marginBottom: 4 }}><AiBadge b={b} /></div>
        {p && (
          <>
            <DrawerRow k="Recommended" v={typeof p.recommendedUsd === 'number' ? `$${p.recommendedUsd.toLocaleString()}` : '—'} />
            <DrawerRow k="Range" v={typeof p.lowUsd === 'number' && typeof p.highUsd === 'number' ? `$${p.lowUsd.toLocaleString()}–$${p.highUsd.toLocaleString()}` : '—'} />
            {typeof conf === 'number' && <DrawerRow k="Confidence" v={`${Math.round(conf * 100)}%`} />}
            {p.breakdown && <DrawerRow k="Labor / Disposal" v={`${money(p.breakdown.laborCents ?? 0)} / ${money(p.breakdown.disposalCents ?? 0)}${p.breakdown.disposalTrips ? ` · ${p.breakdown.disposalTrips} trip(s)` : ''}`} />}
          </>
        )}
        {ai?.decision && <DrawerRow k="Decision" v={ai.decision} />}
        {confirmationStatus(b) !== 'none' && <DrawerRow k="Confirmation" v={confirmationStatus(b)} />}
        {(b.finalAiEstimate?.truckLoadMax ?? 0) > 0 && <DrawerRow k="Est. truck loads" v={String(b.finalAiEstimate!.truckLoadMax)} />}
      </DrawerSection>

      <DrawerSection title="Quote & Payment">
        <DrawerRow k="Quote" v={quoteStatus(b)} />
        <DrawerRow k="Payment" v={paymentStatus(b)} />
        {typeof b.invoiceAmountCents === 'number' && <DrawerRow k="Invoice" v={money(b.invoiceAmountCents)} />}
        {typeof b.amountPaidCents === 'number' && b.amountPaidCents > 0 && <DrawerRow k="Paid" v={money(b.amountPaidCents)} />}
        <DrawerRow k="Owner alert" v={ownerAlertStatus(b)} />
      </DrawerSection>

      {(b.customerNotes || b.specialInstructions) && (
        <DrawerSection title="Notes">
          <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{b.customerNotes || b.specialInstructions}</p>
        </DrawerSection>
      )}

      <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={18} /></button>
    </div>
  )
}

function Queue() {
  const params = useSearchParams()
  const [items, setItems] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)      // FIRST load only — blanks to skeleton
  const [refreshing, setRefreshing] = useState(false) // background poll / manual refresh — keeps data
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<BookNowFilter>('all')
  const [search, setSearch] = useState('')
  const [showTest, setShowTest] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [seen, setSeen] = useState<Set<string>>(new Set())
  // Redesign state
  const [openGroup, setOpenGroup] = useState<string>('pipeline')
  const [showFilters, setShowFilters] = useState(false)
  const [view, setView] = useState<ViewMode>('table')
  const [sortKey, setSortKey] = useState<SortKey>('created')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openToken, setOpenToken] = useState<string | null>(null)

  useEffect(() => {
    const f = params.get('filter') as BookNowFilter | null
    if (f && FILTERS.some(([v]) => v === f)) setFilter(f)
  }, [params])

  useEffect(() => {
    try { setSeen(new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'))) } catch { /* ignore */ }
  }, [])
  const persistSeen = useCallback((next: Set<string>) => {
    setSeen(next)
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
  }, [])

  // background=true keeps the current table/KPIs on screen (poll or manual refresh);
  // only the very first load shows the full "Loading…" state.
  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/book-now', { credentials: 'same-origin' })
      if (res.status === 401) { setError('Session expired — reload.'); return }
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed to load')
      setItems(j.items ?? [])
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { if (background) setRefreshing(false); else setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const hasActive = useMemo(() => items.some(b => { const s = bookNowStage(b); return s === 'ai_queued' || s === 'ai_processing' }), [items])
  useEffect(() => {
    if (!hasActive) return
    const t = setInterval(() => { load(true) }, 15000)   // background poll — no blanking
    return () => clearInterval(t)
  }, [hasActive, load])

  // base = everything respecting the test/archived toggles (drives counts + KPIs)
  const base = useMemo(() => items.filter(b => (showTest || !b.isTest) && (showArchived || !b.archived)), [items, showTest, showArchived])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = base.filter(b => {
      if (!matchesBookNowFilter(b, filter)) return false
      if (!q) return true
      return [b.customerName, b.customerPhone, b.customerEmail, b.bookingNumber, b.invoiceNumber, locationLabel(b), SERVICE_LABELS[b.serviceType]]
        .filter(Boolean).some(v => v!.toLowerCase().includes(q))
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return rows.sort((a, b) => {
      if (sortKey === 'customer') return dir * (a.customerName || '').localeCompare(b.customerName || '')
      if (sortKey === 'stage') return dir * BOOK_NOW_STAGE_LABEL[bookNowStage(a)].localeCompare(BOOK_NOW_STAGE_LABEL[bookNowStage(b)])
      if (sortKey === 'priority') return dir * (priorityOf(bookNowStage(a)).rank - priorityOf(bookNowStage(b)).rank)
      return dir * ((a.createdAt ?? 0) - (b.createdAt ?? 0))
    })
  }, [base, filter, search, sortKey, sortDir])

  const isUnread = useCallback((b: Booking) => !seen.has(b.token) && !b.isTest && !b.archived && bookNowStage(b) !== 'failed', [seen])
  const unreadCount = useMemo(() => items.filter(isUnread).length, [items, isUnread])

  const markSeen = (token: string) => { if (!seen.has(token)) persistSeen(new Set(seen).add(token)) }
  const markUnread = (token: string) => { const n = new Set(seen); n.delete(token); persistSeen(n) }
  const markAllRead = () => persistSeen(new Set(items.map(b => b.token)))

  const count = useCallback((f: BookNowFilter) => base.filter(b => matchesBookNowFilter(b, f)).length, [base])

  // KPIs — every count derives from the SAME predicate its click filters by, so
  // the number always equals the rows shown (see matchesBookNowFilter).
  const kpis = useMemo(() => ([
    { label: 'New Requests', value: String(count('new')), tone: '#f87171', filter: 'new' as BookNowFilter },
    { label: 'Awaiting AI', value: String(count('awaiting_ai')), tone: '#60a5fa', filter: 'awaiting_ai' as BookNowFilter },
    { label: 'Quote Ready', value: String(count('quote_ready')), tone: '#c084fc', filter: 'quote_ready' as BookNowFilter },
    { label: 'Pending Payment', value: String(count('payment_pending')), tone: '#fbbf24', filter: 'payment_pending' as BookNowFilter },
    { label: 'Booked Today', value: String(base.filter(b => isBookedOn(b)).length), tone: '#34d399', filter: 'booked' as BookNowFilter },
    { label: 'Pending Revenue', value: money(base.reduce((s, b) => s + pendingRevenueCents(b), 0)), tone: '#34d399', filter: 'quote_ready' as BookNowFilter },
  ]), [count, base])

  // bulk selection over the current filtered view
  const allSelected = filtered.length > 0 && filtered.every(b => selected.has(b.token))
  const toggleSel = (token: string) => { const n = new Set(selected); if (n.has(token)) n.delete(token); else n.add(token); setSelected(n) }
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(b => b.token)))
  const bulkMark = (read: boolean) => {
    const n = new Set(seen)
    selected.forEach(t => { if (read) n.add(t); else n.delete(t) })
    persistSeen(n); setSelected(new Set())
  }

  const clearFilters = () => { setFilter('all'); setSearch(''); setShowTest(false); setShowArchived(false) }
  const filtersDirty = filter !== 'all' || !!search || showTest || showArchived
  const sortHeader = (key: SortKey, label: string) => (
    <button onClick={() => { setSortKey(key); setSortDir(d => (sortKey === key && d === 'desc' ? 'asc' : 'desc')) }}
      style={{ background: 'none', border: 'none', color: sortKey === key ? 'var(--text)' : 'var(--muted)', fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.04em', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0 }}>
      {label} <ArrowUpDown size={11} style={{ opacity: sortKey === key ? 1 : 0.4 }} />
    </button>
  )

  const openRow = items.find(b => b.token === openToken) || null

  return (
    <div>
      {/* animation for the processing dot */}
      <style>{`@keyframes bnpulse{0%,100%{opacity:1}50%{opacity:.35}} .bn-pulse{animation:bnpulse 1.2s ease-in-out infinite}
        @keyframes bnspin{to{transform:rotate(360deg)}} .bn-spin{animation:bnspin 1s linear infinite}
        .bn-th{position:sticky;top:0;background:var(--bg);z-index:1;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
        .bn-td{padding:12px;border-bottom:1px solid var(--line);vertical-align:middle}
        .bn-tr{cursor:pointer}.bn-tr:hover{background:color-mix(in srgb,var(--card) 60%,transparent)}
        .bn-kpis{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}.bn-kpis::-webkit-scrollbar{display:none}`}</style>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h1 className="os-h" style={{ fontSize: 26, display: 'flex', alignItems: 'center', gap: 9 }}>
          <Zap size={22} style={{ color: 'var(--red)' }} /> Book Now Requests
        </h1>
        <div className="flex items-center gap-2">
          {refreshing && !loading && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Updating…</span>}
          {unreadCount > 0 && <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--red)' }}>{unreadCount} new</span>}
          <button onClick={() => load(true)} disabled={refreshing} className="os-tap" title="Refresh" style={{ color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', cursor: refreshing ? 'default' : 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5, fontWeight: 700 }}><RefreshCw size={14} className={refreshing ? 'bn-spin' : undefined} /> Refresh</button>
        </div>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 14 }}>
        Command center for every online submission — first request through booking.
        {unreadCount > 0 && <> · <button onClick={markAllRead} style={{ background: 'none', border: 'none', color: 'var(--muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13.5, padding: 0 }}>Mark all read</button></>}
      </p>

      {/* KPI row (horizontal scroll on mobile) */}
      <div className="bn-kpis" style={{ marginBottom: 16 }}>
        {kpis.map(k => <Kpi key={k.label} label={k.label} value={k.value} tone={k.tone} active={filter === k.filter} onClick={() => setFilter(k.filter)} />)}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, phone, email, #, address…" aria-label="Search Book Now requests"
            style={{ width: '100%', padding: '10px 12px 10px 34px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }} />
        </div>
        <button onClick={() => setShowFilters(v => !v)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: showFilters || filtersDirty ? 'var(--text)' : 'var(--muted)', background: 'var(--card)', border: '1px solid', borderColor: filtersDirty ? 'var(--red)' : 'var(--line)', borderRadius: 10, padding: '9px 12px', cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center' }}><SlidersHorizontal size={14} /> Filter{filtersDirty ? ` · ${FILTER_LABEL[filter]}` : ''}</button>
        <select value={`${sortKey}:${sortDir}`} onChange={e => { const [k, d] = e.target.value.split(':'); setSortKey(k as SortKey); setSortDir(d as 'asc' | 'desc') }}
          aria-label="Sort" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 10px', cursor: 'pointer' }}>
          <option value="created:desc">Newest first</option>
          <option value="created:asc">Oldest first</option>
          <option value="customer:asc">Customer A–Z</option>
          <option value="priority:desc">Priority</option>
          <option value="stage:asc">Stage</option>
        </select>
        <div className="flex" style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          <button onClick={() => setView('table')} title="Table" style={{ padding: '9px 11px', background: view === 'table' ? 'var(--red)' : 'var(--card)', border: 'none', color: view === 'table' ? '#fff' : 'var(--muted)', cursor: 'pointer' }}><Rows3 size={15} /></button>
          <button onClick={() => setView('cards')} title="Cards" style={{ padding: '9px 11px', background: view === 'cards' ? 'var(--red)' : 'var(--card)', border: 'none', color: view === 'cards' ? '#fff' : 'var(--muted)', cursor: 'pointer' }}><LayoutGrid size={15} /></button>
        </div>
      </div>

      {/* Grouped filters (accordion) — quick chips + expandable groups */}
      {showFilters && (
        <div className="os-card" style={{ padding: 12, marginBottom: 16 }}>
          <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 8 }}>
            {(['all', 'new'] as BookNowFilter[]).map(v => (
              <FilterChip key={v} label={FILTER_LABEL[v]} n={count(v)} active={filter === v} onClick={() => setFilter(v)} />
            ))}
          </div>
          {FILTER_GROUPS.map(g => {
            const open = openGroup === g.id
            const groupN = g.items.reduce((s, f) => s + count(f), 0)
            return (
              <div key={g.id} style={{ borderTop: '1px solid var(--line)' }}>
                <button onClick={() => setOpenGroup(open ? '' : g.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: '10px 2px', fontSize: 13, fontWeight: 700 }}>
                  <span className="flex items-center gap-2">{g.label} <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{groupN}</span></span>
                  <ChevronDown size={16} style={{ color: 'var(--muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                </button>
                {open && (
                  <div className="flex flex-wrap gap-1.5" style={{ paddingBottom: 10 }}>
                    {g.items.map(f => <FilterChip key={f} label={FILTER_LABEL[f]} n={count(f)} active={filter === f} onClick={() => setFilter(f)} />)}
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex flex-wrap gap-1.5" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <button onClick={() => setShowTest(v => !v)} className="os-tap" style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: showTest ? '#a855f7' : 'var(--card)', border: '1px solid var(--line)', color: showTest ? '#fff' : 'var(--muted)' }}>🧪 Include Test</button>
            <button onClick={() => setShowArchived(v => !v)} className="os-tap" style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: showArchived ? 'var(--muted)' : 'var(--card)', border: '1px solid var(--line)', color: showArchived ? '#fff' : 'var(--muted)' }}>🗄 Include Archived</button>
            {filtersDirty && <button onClick={clearFilters} style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: 'none', border: 'none', color: 'var(--red)', textDecoration: 'underline' }}>Clear filters</button>}
          </div>
        </div>
      )}

      {/* bulk action bar */}
      {selected.size > 0 && (
        <div className="os-card flex items-center gap-3 flex-wrap" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--red)' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{selected.size} selected</span>
          <button onClick={() => bulkMark(true)} style={{ fontSize: 12.5, fontWeight: 700, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 8, padding: '6px 11px', cursor: 'pointer' }}>Mark read</button>
          <button onClick={() => bulkMark(false)} style={{ fontSize: 12.5, fontWeight: 700, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 8, padding: '6px 11px', cursor: 'pointer' }}>Mark unread</button>
          <button onClick={() => setSelected(new Set())} style={{ fontSize: 12.5, fontWeight: 700, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', textDecoration: 'underline' }}>Clear</button>
        </div>
      )}

      {error && <p role="alert" style={{ color: '#f87171', fontSize: 14, marginBottom: 12 }}>{error}</p>}
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {!loading && filtered.length === 0 && (
        <EmptyState title="No requests match this view"
          description={filtersDirty ? 'Try widening your filters or clearing the search.' : 'New online submissions will appear here the moment they come in.'}
          action={filtersDirty ? <button onClick={clearFilters} className="os-tap" style={{ fontSize: 13, fontWeight: 700, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 16px', cursor: 'pointer' }}>Clear filters</button> : undefined} />
      )}

      {/* TABLE view (desktop) + CARDS fallback (mobile), or CARDS view everywhere */}
      {!loading && filtered.length > 0 && view === 'table' && (
        <>
          <div className="hidden md:block" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th className="bn-th" style={{ width: 34 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
                  <th className="bn-th">{sortHeader('customer', 'Customer')}</th>
                  <th className="bn-th">Service</th>
                  <th className="bn-th">Location</th>
                  <th className="bn-th">{sortHeader('created', 'Created')}</th>
                  <th className="bn-th">AI Status</th>
                  <th className="bn-th">Quote</th>
                  <th className="bn-th">Payment</th>
                  <th className="bn-th">Crew</th>
                  <th className="bn-th">{sortHeader('priority', 'Priority')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => {
                  const stage = bookNowStage(b); const unread = isUnread(b); const pr = priorityOf(stage)
                  return (
                    <tr key={b.token} className="bn-tr" onClick={() => { setOpenToken(b.token); markSeen(b.token) }}>
                      <td className="bn-td" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected.has(b.token)} onChange={() => toggleSel(b.token)} aria-label={`Select ${b.customerName}`} /></td>
                      <td className="bn-td">
                        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                          {unread && <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--red)', flexShrink: 0 }} />}
                          <span style={{ fontWeight: 700 }}>{b.customerName}</span>
                          {isEstateBooking(b) && <span title="Estate" style={{ fontSize: 10 }}>🏠</span>}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }} className="font-mono">{b.bookingNumber}</div>
                      </td>
                      <td className="bn-td"><span style={{ color: 'var(--muted)' }}>{SERVICE_LABELS[b.serviceType] ?? b.serviceType}</span></td>
                      <td className="bn-td"><span style={{ color: 'var(--muted)', display: 'inline-block', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{locationLabel(b)}</span></td>
                      <td className="bn-td"><span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{b.createdAt ? fmtTs(b.createdAt) : '—'}</span></td>
                      <td className="bn-td"><AiBadge b={b} /></td>
                      <td className="bn-td"><StatusPill v={quoteStatus(b)} /></td>
                      <td className="bn-td"><StatusPill v={paymentStatus(b)} /></td>
                      <td className="bn-td"><span style={{ color: b.assignedTo ? 'var(--text)' : 'var(--muted)' }}>{b.assignedTo || 'Unassigned'}</span></td>
                      <td className="bn-td"><span style={{ fontSize: 11, fontWeight: 800, color: pr.tone }}>{pr.label}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-2.5">
            {filtered.map(b => <RequestCard key={b.token} b={b} unread={isUnread(b)} onOpen={() => { setOpenToken(b.token); markSeen(b.token) }} onToggleSeen={() => (isUnread(b) ? markSeen(b.token) : markUnread(b.token))} />)}
          </div>
        </>
      )}
      {!loading && filtered.length > 0 && view === 'cards' && (
        <div className="space-y-2.5">
          {filtered.map(b => <RequestCard key={b.token} b={b} unread={isUnread(b)} onOpen={() => { setOpenToken(b.token); markSeen(b.token) }} onToggleSeen={() => (isUnread(b) ? markSeen(b.token) : markUnread(b.token))} />)}
        </div>
      )}

      {/* Slide-over drawer */}
      <Drawer open={!!openRow} onClose={() => setOpenToken(null)} title={openRow?.customerName || 'Request'}>
        {openRow && <RequestDrawer b={openRow} unread={isUnread(openRow)} onToggleSeen={() => (isUnread(openRow) ? markSeen(openRow.token) : markUnread(openRow.token))} onClose={() => setOpenToken(null)} />}
      </Drawer>
    </div>
  )
}

// ── small shared pieces ──────────────────────────────────────────────────────
function FilterChip({ label, n, active, onClick }: { label: string; n: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="os-tap" style={{ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 999, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, background: active ? 'var(--red)' : 'var(--card)', border: '1px solid', borderColor: active ? 'var(--red)' : 'var(--line)', color: active ? '#fff' : 'var(--muted)' }}>
      {label}
      {n > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: active ? '#fff' : 'rgba(255,255,255,.08)', color: active ? 'var(--red)' : 'var(--muted)', borderRadius: 999, minWidth: 16, height: 16, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>}
    </button>
  )
}

function StatusPill({ v }: { v: string }) {
  const tones: Record<string, string> = { none: 'var(--muted)', unpaid: 'var(--muted)', ready: '#60a5fa', sent: '#c084fc', partial: '#fbbf24', paid: '#34d399' }
  const tone = tones[v] ?? 'var(--muted)'
  return <span style={{ fontSize: 11, fontWeight: 700, color: tone }}>{v === 'none' ? '—' : v}</span>
}

function RequestCard({ b, unread, onOpen, onToggleSeen }: { b: Booking; unread: boolean; onOpen: () => void; onToggleSeen: () => void }) {
  const stage = bookNowStage(b)
  return (
    <div onClick={onOpen} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen() }}
      className="os-card os-tap" style={{ display: 'block', padding: 14, cursor: 'pointer', borderColor: unread ? 'var(--red)' : undefined }}>
      <div className="flex items-start justify-between gap-3">
        <div style={{ minWidth: 0 }}>
          <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 3 }}>
            {unread && <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--red)', flexShrink: 0 }} />}
            <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--text)' }}>{b.customerName}</span>
            {isEstateBooking(b) && <span style={{ background: '#7c3aed', color: '#fff', borderRadius: 6, fontSize: 9.5, fontWeight: 800, padding: '2px 6px' }}>🏠</span>}
            <StageTag stage={stage} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            {SERVICE_LABELS[b.serviceType] ?? b.serviceType} · <span className="font-mono">{b.bookingNumber}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {!!b.createdAt && <MiniStatus label="Submitted" value={fmtTs(b.createdAt)} />}
            <MiniStatus label="📍" value={locationLabel(b)} />
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Camera size={12} /> {b.invoicePhotos?.length ?? 0}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ marginTop: 5 }}>
            <AiBadge b={b} />
            <MiniStatus label="Quote" value={quoteStatus(b)} />
            <MiniStatus label="Pay" value={paymentStatus(b)} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <ChevronRight size={18} style={{ color: 'var(--muted)' }} />
          <button onClick={e => { e.stopPropagation(); onToggleSeen() }} style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' }}>{unread ? 'Mark read' : 'Mark unread'}</button>
        </div>
      </div>
    </div>
  )
}

export default function BookNowQueuePage() {
  return <OperationsShell><Queue /></OperationsShell>
}
