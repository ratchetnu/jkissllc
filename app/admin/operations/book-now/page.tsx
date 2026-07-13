'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Zap, Search, Camera, ChevronRight } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { fmtTs } from '../ui'
import { SERVICE_LABELS, type Booking } from '../../../lib/bookings'
import {
  bookNowStage, bookNowServiceGroup, matchesBookNowFilter,
  aiStatus, quoteStatus, paymentStatus, ownerAlertStatus,
  BOOK_NOW_STAGE_LABEL, type BookNowFilter, type BookNowStage,
} from '../../../lib/book-now-queue'

const SEEN_KEY = 'jkos-booknow-seen'

const GROUP_LABEL: Record<string, string> = { junk: 'Junk Removal', moving: 'Moving', delivery: 'Delivery', other: 'Service' }

const STAGE_TONE: Record<BookNowStage, string> = {
  new: '#f87171', awaiting_photos: '#fbbf24', awaiting_ai: '#fbbf24',
  ai_queued: '#fbbf24', ai_processing: '#60a5fa', ai_failed: '#f87171',
  quote_ready: '#60a5fa', manual_review: '#c084fc', quote_sent: '#60a5fa', payment_pending: '#fbbf24',
  paid: '#34d399', booked: '#34d399', failed: '#f87171',
}

// The filter chips, in the owner's mental order. Value → visible label.
const FILTERS: [BookNowFilter, string][] = [
  ['all', 'All'], ['new', 'New'],
  ['junk', 'Junk Removal'], ['moving', 'Moving'], ['delivery', 'Delivery'],
  ['awaiting_photos', 'Awaiting Photos'], ['ai_queued', 'AI Queued'], ['ai_processing', 'AI Processing'], ['ai_failed', 'AI Failed'],
  ['manual_review', 'Manual Review'], ['awaiting_approval', 'Awaiting Approval'], ['quote_ready', 'Quote Ready'], ['quote_sent', 'Quote Sent'],
  ['accepted', 'Accepted'], ['payment_pending', 'Payment Pending'], ['paid', 'Paid'], ['booked', 'Booked'], ['failed', 'Failed'],
]

function locationLabel(b: Booking): string {
  return b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || '—'
}
function requestedDate(b: Booking): string | undefined {
  return b.bookNow?.requestedDate || b.availableDates?.[0]
}

function Sub({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
      {label} <span style={{ fontWeight: 700, color: tone ?? 'var(--text)' }}>{value}</span>
    </span>
  )
}

function Queue() {
  const params = useSearchParams()
  const [items, setItems] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<BookNowFilter>('all')
  const [search, setSearch] = useState('')
  const [showTest, setShowTest] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [seen, setSeen] = useState<Set<string>>(new Set())

  // Deep-link from the overview counters: /admin/operations/book-now?filter=quote_ready
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

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/book-now', { credentials: 'same-origin' })
      if (res.status === 401) { setError('Session expired — reload.'); return }
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed to load')
      setItems(j.items ?? [])
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Short-poll while any request is actively moving through AI processing, so the
  // queue advances on its own without the owner refreshing.
  const hasActive = useMemo(() => items.some(b => {
    const s = bookNowStage(b)
    return s === 'ai_queued' || s === 'ai_processing'
  }), [items])
  useEffect(() => {
    if (!hasActive) return
    const t = setInterval(() => { load() }, 15000)
    return () => clearInterval(t)
  }, [hasActive, load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(b => {
      if (!showTest && b.isTest) return false
      if (!showArchived && b.archived) return false
      if (!matchesBookNowFilter(b, filter)) return false
      if (!q) return true
      return [b.customerName, b.customerPhone, b.customerEmail, b.bookingNumber, b.invoiceNumber, locationLabel(b), SERVICE_LABELS[b.serviceType]]
        .filter(Boolean).some(v => v!.toLowerCase().includes(q))
    }).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }, [items, filter, search, showTest, showArchived])

  // Unread = a live request the owner hasn't opened yet.
  const isUnread = useCallback((b: Booking) => !seen.has(b.token) && !b.isTest && !b.archived && bookNowStage(b) !== 'failed', [seen])
  const unreadCount = useMemo(() => items.filter(isUnread).length, [items, isUnread])

  const markSeen = (token: string) => { if (!seen.has(token)) persistSeen(new Set(seen).add(token)) }
  const markUnread = (token: string) => { const n = new Set(seen); n.delete(token); persistSeen(n) }
  const markAllRead = () => persistSeen(new Set(items.map(b => b.token)))

  const count = (f: BookNowFilter) => items.filter(b => (showTest || !b.isTest) && (showArchived || !b.archived) && matchesBookNowFilter(b, f)).length

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h1 className="os-h" style={{ fontSize: 26, display: 'flex', alignItems: 'center', gap: 9 }}>
          <Zap size={22} style={{ color: 'var(--red)' }} /> Book Now Requests
        </h1>
        <button onClick={load} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 999, padding: '7px 13px', cursor: 'pointer' }}>↻ Refresh</button>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 16 }}>
        Every online customer submission — from first request through booking. {unreadCount > 0 && (
          <><strong style={{ color: 'var(--red)' }}>{unreadCount} new</strong> · <button onClick={markAllRead} style={{ background: 'none', border: 'none', color: 'var(--muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13.5, padding: 0 }}>Mark all read</button></>
        )}
      </p>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, phone, email, request #, address, service…"
          aria-label="Search Book Now requests"
          style={{ width: '100%', padding: '12px 14px 12px 36px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none' }} />
      </div>

      {/* Filter chips — wrap, never overflow horizontally */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {FILTERS.map(([v, label]) => {
          const active = filter === v
          const n = count(v)
          return (
            <button key={v} onClick={() => setFilter(v)} className="os-tap"
              style={{ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 999, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
                background: active ? 'var(--red)' : 'var(--card)', border: '1px solid', borderColor: active ? 'var(--red)' : 'var(--line)', color: active ? '#fff' : 'var(--muted)' }}>
              {label}
              {n > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: active ? '#fff' : 'rgba(255,255,255,.08)', color: active ? 'var(--red)' : 'var(--muted)', borderRadius: 999, minWidth: 16, height: 16, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>}
            </button>
          )
        })}
      </div>

      {/* Inclusion toggles */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        <button onClick={() => setShowTest(v => !v)} className="os-tap" style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: showTest ? '#a855f7' : 'var(--card)', border: '1px solid var(--line)', color: showTest ? '#fff' : 'var(--muted)' }}>🧪 Include Test</button>
        <button onClick={() => setShowArchived(v => !v)} className="os-tap" style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: showArchived ? 'var(--muted)' : 'var(--card)', border: '1px solid var(--line)', color: showArchived ? '#fff' : 'var(--muted)' }}>🗄 Include Archived</button>
      </div>

      {error && <p role="alert" style={{ color: '#f87171', fontSize: 14, marginBottom: 12 }}>{error}</p>}
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {!loading && filtered.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 14 }}>No Book Now requests match this view.</p>}

      <div className="space-y-2.5">
        {filtered.map(b => {
          const stage = bookNowStage(b)
          const unread = isUnread(b)
          const alert = ownerAlertStatus(b)
          return (
            <Link key={b.token} href={`/admin/operations/book-now/${b.token}`} onClick={() => markSeen(b.token)}
              className="os-card os-tap" style={{ display: 'block', padding: 15, textDecoration: 'none', position: 'relative', borderColor: unread ? 'var(--red)' : undefined }}>
              <div className="flex items-start justify-between gap-3">
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 3 }}>
                    {unread && <span aria-label="New" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--red)', flexShrink: 0 }} />}
                    <span style={{ fontWeight: 800, fontSize: 15.5, color: 'var(--text)' }}>{b.customerName}</span>
                    <span style={{ background: 'var(--red)', color: '#fff', borderRadius: 6, fontSize: 9.5, fontWeight: 800, padding: '2px 6px', letterSpacing: '.04em' }}>⚡ BOOK NOW</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: STAGE_TONE[stage], background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 9px' }}>{BOOK_NOW_STAGE_LABEL[stage]}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                    {GROUP_LABEL[bookNowServiceGroup(b.serviceType)]} · {SERVICE_LABELS[b.serviceType] ?? b.serviceType} · <span className="font-mono">{b.bookingNumber}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ marginBottom: 6 }}>
                    {!!b.createdAt && <Sub label="Submitted" value={fmtTs(b.createdAt)} />}
                    {requestedDate(b) && <Sub label="Requested" value={requestedDate(b)!} />}
                    <Sub label="📍" value={locationLabel(b)} />
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Camera size={12} /> {b.invoicePhotos?.length ?? 0}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Sub label="AI" value={aiStatus(b)} />
                    <Sub label="Quote" value={quoteStatus(b)} />
                    <Sub label="Pay" value={paymentStatus(b)} />
                    <Sub label="Alert" value={alert} tone={alert === 'sent' ? '#34d399' : alert === 'failed' ? '#f87171' : '#fbbf24'} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                  <ChevronRight size={18} style={{ color: 'var(--muted)' }} />
                  <button onClick={e => { e.preventDefault(); if (unread) markSeen(b.token); else markUnread(b.token) }}
                    style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                    {unread ? 'Mark read' : 'Mark unread'}
                  </button>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

export default function BookNowQueuePage() {
  return <OperationsShell><Queue /></OperationsShell>
}
