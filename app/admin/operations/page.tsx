'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { MapPin, Clock, User, ChevronDown, Plus, CalendarDays, AlertTriangle, CheckCircle2, Wallet, Zap } from 'lucide-react'
import OperationsShell from './OperationsShell'
import { useOps } from './useOps'
import ClaimsCard from './claims/ClaimsCard'
import { BOOK_NOW_STAGE_LABEL, type BookNowStage } from '../../lib/book-now-queue'
import { OpsPilotMark, OpsPilotWordmark } from '../../components/opspilot/OpsPilotMark'
import { STATUS as CHIP, scoreColor, ymd, fmtDay, mapsUrl, type RouteStatus } from './ui'

type Op = {
  token: string; routeNumber: string; status: RouteStatus
  businessName: string; reportAddress: string; reportTime: string; routeDate: string
  assignedStaffId?: string; assignedStaffName?: string; assignees?: { staffId: string }[]
  description?: string; specialNotes?: string; contactPerson?: string; contactPhone?: string
  declineReason?: string; confirmedAt?: number; declinedAt?: number
}

function Dashboard() {
  const { routes: ops, stats, loading, error } = useOps<Op>()

  const now = new Date()
  const hour = now.getHours()
  const today = ymd(now)
  const tomorrow = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const eveningFocus = hour >= 17

  const live = ops.filter(o => o.status !== 'cancelled' && o.status !== 'draft')
  const todays = live.filter(o => o.routeDate === today)
  const tomorrows = live.filter(o => o.routeDate === tomorrow)
  const needsConfirm = live.filter(o => (o.status === 'assigned' || o.status === 'text_sent') && o.routeDate >= today)
  const needsReassign = live.filter(o => (o.status === 'declined' || o.status === 'no_response') && o.routeDate >= today)

  const focus = eveningFocus ? tomorrows : todays
  const focusLabel = eveningFocus ? 'Tomorrow’s operations' : hour < 12 ? 'Today’s operations' : 'Still on today'
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div>
      {/* Greeting */}
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          {/* The platform names itself once, at the top of its own home screen. */}
          <p style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)', marginBottom: 7 }}>
            <OpsPilotMark size={15} />
            <OpsPilotWordmark tm style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Operations</span>
          </p>
          <p style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.02em', color: 'var(--muted)' }}>{dateLabel}</p>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(30px,6vw,44px)', marginTop: 2 }}>{greeting}.</h1>
        </div>
        <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, height: 46, paddingLeft: 20, paddingRight: 22 }}><Plus size={18} /> New assignment</Link>
      </div>

      {loading ? <SkeletonHome />
        : error ? <div className="os-card" style={{ padding: 22, color: '#f87171' }}>{error}</div>
        : (
        <>
          {/* Attention strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 26 }}>
            <StatCard label="Needs confirmation" value={needsConfirm.length} tone={needsConfirm.length ? 'warn' : 'calm'} Icon={Clock} href="/admin/operations/list?filter=upcoming" />
            <StatCard label="Needs reassignment" value={needsReassign.length} tone={needsReassign.length ? 'alert' : 'calm'} Icon={AlertTriangle} href="/admin/operations/list?filter=attention" />
            <StatCard label="Tomorrow" value={tomorrows.length} tone="calm" Icon={CalendarDays} href="/admin/operations/list?filter=upcoming" />
          </div>

          {/* Money — the ledger lives one tap away, never on a crew-facing screen. */}
          <Link href="/admin/operations/finance" className="os-card os-tap os-rise" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 16, marginBottom: 12, textDecoration: 'none', color: 'var(--text)' }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)' }}>
              <Wallet size={18} style={{ color: 'var(--red-glow)' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Money</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Revenue in, payouts out, profit between.</div>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Open →</span>
          </Link>

          <ClaimsCard />

          <BookNowOverview />

          {/* Focus */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <h2 className="jkos-h" style={{ fontSize: 20 }}>{focusLabel}</h2>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>{focus.length}</span>
          </div>

          {focus.length === 0
            ? <EmptyFocus evening={eveningFocus} />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {focus.sort((a, b) => a.reportTime.localeCompare(b.reportTime)).map((o, i) => (
                  <OpCard key={o.token} op={o} score={o.assignedStaffId ? stats[o.assignedStaffId]?.score : undefined} delay={i} />
                ))}
              </div>}

          {/* Needs-attention operations, when not already the focus */}
          {needsReassign.length > 0 && (
            <div style={{ marginTop: 30 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <h2 className="jkos-h" style={{ fontSize: 20, color: '#fca5a5' }}>Needs your attention</h2>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {needsReassign.map((o, i) => <OpCard key={o.token} op={o} score={o.assignedStaffId ? stats[o.assignedStaffId]?.score : undefined} delay={i} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, tone, Icon, href }: { label: string; value: number; tone: 'calm' | 'warn' | 'alert'; Icon: typeof Clock; href: string }) {
  const color = tone === 'alert' ? '#fca5a5' : tone === 'warn' ? '#fcd34d' : 'var(--muted)'
  return (
    <Link href={href} className="os-card os-tap os-rise" style={{ padding: 16, textDecoration: 'none', display: 'block' }}>
      <Icon size={18} style={{ color }} />
      <div className="jkos-h tabular-nums" style={{ fontSize: 30, marginTop: 8, color: value ? 'var(--text)' : 'var(--muted)' }}>{value}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', marginTop: 1 }}>{label}</div>
    </Link>
  )
}

function OpCard({ op, score, delay }: { op: Op; score?: number | null; delay: number }) {
  const [open, setOpen] = useState(false)
  const chip = CHIP[op.status]
  return (
    <div className="os-card os-rise" style={{ overflow: 'hidden', animationDelay: `${Math.min(delay * 40, 240)}ms` }}>
      <button onClick={() => setOpen(o => !o)} className="os-tap" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 10px', borderRadius: 99, background: chip.bg, color: chip.fg }}>{chip.label}</span>
              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{op.routeNumber}</span>
            </div>
            <div className="jkos-h" style={{ fontSize: 19, marginTop: 8 }}>{op.businessName}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, fontSize: 13.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Clock size={14} /> {op.reportTime}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><CalendarDays size={14} /> {fmtDay(op.routeDate)}</span>
            </div>
          </div>
          <ChevronDown size={20} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .3s var(--os-ease)', transform: open ? 'rotate(180deg)' : 'none' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <User size={15} style={{ color: 'var(--muted)' }} />
          {op.assignedStaffName
            ? <><span style={{ fontSize: 14, fontWeight: 600 }}>{op.assignedStaffName}</span>
                {(op.assignees?.length ?? 0) > 1 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>+{op.assignees!.length - 1}</span>}
                {score != null && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '1px 7px', borderRadius: 99, background: 'rgba(255,255,255,.07)', color: scoreColor(score) }}>{score}</span>}</>
            : <span style={{ fontSize: 14, fontWeight: 600, color: '#fcd34d' }}>Unassigned</span>}
        </div>
      </button>

      <div className={`os-expand${open ? ' open' : ''}`}>
        <div>
          <div style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ height: 1, background: 'var(--line)' }} />
            {op.status === 'declined' && op.declineReason && <Row Icon={AlertTriangle} label="Not available" val={op.declineReason} />}
            <Row Icon={MapPin} label="Report to" val={op.reportAddress} href={mapsUrl(op.reportAddress)} />
            {op.contactPerson && <Row Icon={User} label="On-site contact" val={`${op.contactPerson}${op.contactPhone ? ` · ${op.contactPhone}` : ''}`} />}
            {(op.description || op.specialNotes) && <Row Icon={CheckCircle2} label="Instructions" val={[op.description, op.specialNotes].filter(Boolean).join(' · ')} />}
            <Link href={`/admin/operations/${op.token}`} className="btn-ghost os-tap" style={{ borderRadius: 10, justifyContent: 'center', marginTop: 4 }}>Open operation →</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ Icon, label, val, href }: { Icon: typeof MapPin; label: string; val: string; href?: string }) {
  return (
    <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
      <Icon size={16} style={{ color: 'var(--red-glow)', flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--muted)' }}>{label}</div>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{val}</div>
        {href && <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Open in Maps →</a>}
      </div>
    </div>
  )
}

function EmptyFocus({ evening }: { evening: boolean }) {
  return (
    <div className="os-card os-rise" style={{ padding: '34px 22px', textAlign: 'center' }}>
      <CheckCircle2 size={30} style={{ color: '#86efac' }} />
      <p className="jkos-h" style={{ fontSize: 18, marginTop: 12 }}>{evening ? 'Nothing scheduled for tomorrow yet' : 'You’re all clear'}</p>
      <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 6 }}>{evening ? 'Assign tomorrow’s work whenever you’re ready.' : 'No operations on the board for right now.'}</p>
      <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, marginTop: 18, display: 'inline-flex' }}><Plus size={17} /> New assignment</Link>
    </div>
  )
}

function SkeletonHome() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 26 }}>
        {[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 16 }}><div className="skeleton" style={{ width: 34, height: 34, borderRadius: 10 }} /><div className="skeleton" style={{ width: 48, height: 26, borderRadius: 8, marginTop: 10 }} /><div className="skeleton" style={{ width: '80%', height: 12, borderRadius: 6, marginTop: 8 }} /></div>)}
      </div>
      <div className="skeleton" style={{ width: 180, height: 20, borderRadius: 8, marginBottom: 14 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[0, 1].map(i => <div key={i} className="os-card" style={{ padding: 18 }}><div className="skeleton" style={{ width: 120, height: 14, borderRadius: 7 }} /><div className="skeleton" style={{ width: '60%', height: 20, borderRadius: 8, marginTop: 12 }} /><div className="skeleton" style={{ width: '40%', height: 12, borderRadius: 6, marginTop: 10 }} /></div>)}
      </div>
    </div>
  )
}

// ── Book Now overview: clickable counters into the Operations Book Now queue ──
// The pre-job pipeline of online customer submissions — visible the moment a
// customer submits, before any quote/payment/booking. Each counter deep-links to
// the filtered queue. Fail-soft: a load error just hides the card, never blocks Home.
const BOOK_NOW_TILES: { stage: BookNowStage; label: string }[] = [
  { stage: 'new', label: 'New' },
  { stage: 'awaiting_photos', label: 'Awaiting Photos' },
  { stage: 'ai_queued', label: 'AI Queued' },
  { stage: 'ai_processing', label: 'AI Processing' },
  { stage: 'ai_failed', label: 'AI Failed' },
  { stage: 'manual_review', label: 'Manual Review' },
  { stage: 'quote_ready', label: 'Quote Ready' },
  { stage: 'quote_sent', label: 'Quote Sent' },
  { stage: 'payment_pending', label: 'Payment Pending' },
  { stage: 'paid', label: 'Paid' },
  { stage: 'booked', label: BOOK_NOW_STAGE_LABEL.booked },
  { stage: 'failed', label: 'Failed' },
]

function BookNowOverview() {
  const [counts, setCounts] = useState<Record<BookNowStage, number> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    fetch('/api/admin/book-now', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => setCounts(j.counts ?? null))
      .catch(() => setFailed(true))
  }, [])
  if (failed) return null
  const total = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : 0
  const active = counts ? (counts.new + counts.awaiting_photos + counts.ai_queued + counts.ai_processing + counts.ai_failed + counts.manual_review + counts.quote_ready) : 0

  return (
    <div className="os-card os-rise" style={{ padding: 16, marginBottom: 12 }}>
      <div className="flex items-center justify-between gap-3" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(224,0,42,.12)', border: '1px solid var(--red)' }}>
            <Zap size={18} style={{ color: 'var(--red)' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Book Now Requests</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{total} online submissions · {active} awaiting you</div>
          </div>
        </div>
        <Link href="/admin/operations/book-now" style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)', textDecoration: 'none', whiteSpace: 'nowrap' }}>Open →</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 8 }}>
        {BOOK_NOW_TILES.map(({ stage, label }) => (
          <Link key={stage} href={`/admin/operations/book-now?filter=${stage}`} className="os-tap"
            style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', borderRadius: 11, textDecoration: 'none', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)' }}>
            <span style={{ fontSize: 20, fontWeight: 800, color: (counts?.[stage] ?? 0) > 0 ? 'var(--text)' : 'var(--muted)' }}>{counts ? counts[stage] : '·'}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default function OperationsHome() {
  return <OperationsShell><Dashboard /></OperationsShell>
}
