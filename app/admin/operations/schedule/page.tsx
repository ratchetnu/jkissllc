'use client'

// ── Unified Operations schedule ──────────────────────────────────────────────
// ONE day view for every source of work — Book Now jobs, manual jobs, contract
// routes, recurring routes — so the owner never switches systems to understand the
// day. Reads the projected /api/admin/schedule feed (see lib/schedule/unified +
// conflicts). Industry-neutral: it renders a generic service label + meta chips and
// makes no junk-removal (or any single-industry) assumption.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import {
  Clock, MapPin, User, Truck, Wrench, CalendarDays, ChevronLeft, ChevronRight,
  AlertTriangle, CircleAlert, CalendarClock, DollarSign,
} from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { ymd, fmtDay, fmtLongDay, money } from '../ui'
import type { ScheduleItem, ScheduleSource } from '../../../lib/schedule/unified'
import type { Conflict } from '../../../lib/schedule/conflicts'

type Feed = {
  items: ScheduleItem[]
  counts: { total: number; confirmed: number; pending: number; unscheduled: number; completed: number; cancelled: number; needsAttention: number }
  conflicts: Conflict[]
  conflictSummary: { total: number; errors: number; warnings: number; byType: Record<string, number> }
  canSeeValue: boolean
}

type View = 'today' | 'week' | 'pending' | 'unscheduled'

// ── generic source styling (industry-neutral) ───────────────────────────────
const SOURCE_STYLE: Record<ScheduleSource, { label: string; fg: string; bg: string }> = {
  BOOK_NOW: { label: 'Book Now', fg: '#fca5a5', bg: 'rgba(224,0,42,.14)' },
  MANUAL: { label: 'Manual', fg: '#cbd5e1', bg: 'rgba(255,255,255,.07)' },
  CONTRACT_ROUTE: { label: 'Contract', fg: '#93c5fd', bg: 'rgba(59,130,246,.15)' },
  RECURRING_ROUTE: { label: 'Recurring', fg: '#c4b5fd', bg: 'rgba(139,92,246,.16)' },
  IMPORTED: { label: 'Imported', fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
  OTHER: { label: 'Other', fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
}

const ATTENTION_LABEL: Record<string, string> = {
  needs_review: 'Needs review', zelle_review: 'Zelle review', manual_review: 'Manual review',
  balance_due: 'Balance due', no_crew: 'No crew', needs_driver: 'Needs driver',
  needs_helper: 'Needs helper', no_vehicle: 'No vehicle', no_response: 'No response', no_show: 'No show',
}
const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Unpaid', deposit_paid: 'Deposit paid', partially_paid: 'Part paid', paid_in_full: 'Paid',
}

// local date helpers (UTC-noon anchored, matching lib/schedule + ui.fmtDay)
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d)
}
const weekStart = (iso: string): string => {
  const d = new Date(`${iso}T12:00:00Z`); return addDays(iso, -d.getUTCDay()) // Sunday start
}
const itemDay = (it: ScheduleItem): string => it.date || it.requestedDate || ''

function Schedule() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('today')
  const [anchor, setAnchor] = useState<string>(() => ymd(new Date()))

  useEffect(() => {
    let alive = true
    fetch('/api/admin/schedule', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((j: Feed) => { if (alive) { setFeed(j); setLoading(false) } })
      .catch(() => { if (alive) { setError('Couldn’t load the schedule.'); setLoading(false) } })
    return () => { alive = false }
  }, [])

  const items = feed?.items ?? []
  const conflictsByItem = useMemo(() => {
    const m = new Map<string, Conflict[]>()
    for (const c of feed?.conflicts ?? []) for (const id of c.itemIds) (m.get(id) ?? m.set(id, []).get(id)!).push(c)
    return m
  }, [feed])

  const todayIso = ymd(new Date())

  return (
    <div>
      {/* Header */}
      <div className="os-rise" style={{ marginBottom: 18 }}>
        <p style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.02em', color: 'var(--muted)' }}>Operations</p>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(26px,5vw,38px)', marginTop: 2 }}>Schedule</h1>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 4 }}>Every source of work — Book Now, manual, and contract routes — on one day.</p>
      </div>

      {/* View switcher */}
      <div role="tablist" aria-label="Schedule view" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {([['today', 'Day'], ['week', 'Week'], ['pending', 'Pending'], ['unscheduled', 'Unscheduled']] as [View, string][]).map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className="os-tap"
            style={{ ...tab, ...(view === v ? tabActive : null) }}>
            {label}
            {v === 'pending' && (feed?.counts.pending ?? 0) > 0 ? <span style={badgeDot}>{feed!.counts.pending}</span> : null}
            {v === 'unscheduled' && (feed?.counts.unscheduled ?? 0) > 0 ? <span style={badgeDot}>{feed!.counts.unscheduled}</span> : null}
          </button>
        ))}
      </div>

      {/* Date navigator (day + week only) */}
      {(view === 'today' || view === 'week') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button aria-label={view === 'week' ? 'Previous week' : 'Previous day'} className="os-tap" style={navBtn}
            onClick={() => setAnchor(a => addDays(a, view === 'week' ? -7 : -1))}><ChevronLeft size={18} /></button>
          <button aria-label="Jump to today" className="os-tap" style={{ ...navBtn, width: 'auto', paddingLeft: 14, paddingRight: 14, fontWeight: 700, fontSize: 13 }}
            onClick={() => setAnchor(todayIso)}>Today</button>
          <button aria-label={view === 'week' ? 'Next week' : 'Next day'} className="os-tap" style={navBtn}
            onClick={() => setAnchor(a => addDays(a, view === 'week' ? 7 : 1))}><ChevronRight size={18} /></button>
          <div style={{ fontSize: 15, fontWeight: 700, marginLeft: 4 }}>
            {view === 'week'
              ? `${fmtDay(weekStart(anchor))} – ${fmtDay(addDays(weekStart(anchor), 6))}`
              : fmtLongDay(anchor)}
          </div>
        </div>
      )}

      {loading ? <Skeleton />
        : error ? <div className="os-card" style={{ padding: 22, color: '#f87171' }}>{error}</div>
        : feed && (
        <>
          <CountsRow c={feed.counts} conflicts={feed.conflictSummary} />
          {feed.conflictSummary.total > 0 && <ConflictBanner conflicts={feed.conflicts} />}

          {view === 'today' && <DayView items={items} day={anchor} conflictsByItem={conflictsByItem} canSeeValue={feed.canSeeValue} />}
          {view === 'week' && <WeekView items={items} start={weekStart(anchor)} today={todayIso} onPick={(d) => { setAnchor(d); setView('today') }} />}
          {view === 'pending' && <ListView title="Pending requests" empty="No pending requests — every request has been actioned."
            items={items.filter(it => it.lane === 'pending' && !it.cancelled).sort(byDayThenTime)} conflictsByItem={conflictsByItem} canSeeValue={feed.canSeeValue} />}
          {view === 'unscheduled' && <ListView title="Accepted but unscheduled" empty="Nothing accepted is missing a date."
            items={items.filter(it => it.lane === 'confirmed' && !it.scheduled && !it.cancelled && !it.completed)} conflictsByItem={conflictsByItem} canSeeValue={feed.canSeeValue} />}
        </>
      )}
    </div>
  )
}

const byDayThenTime = (a: ScheduleItem, b: ScheduleItem): number => {
  const da = itemDay(a), db = itemDay(b)
  if (da && db && da !== db) return da.localeCompare(db)
  if (!!da !== !!db) return da ? -1 : 1
  return a.sortMinutes - b.sortMinutes
}

// ── Counts ───────────────────────────────────────────────────────────────────
function CountsRow({ c, conflicts }: { c: Feed['counts']; conflicts: Feed['conflictSummary'] }) {
  const tiles: { label: string; value: number; tone?: string }[] = [
    { label: 'Confirmed', value: c.confirmed },
    { label: 'Pending', value: c.pending, tone: c.pending ? '#fcd34d' : undefined },
    { label: 'Unscheduled', value: c.unscheduled, tone: c.unscheduled ? '#fcd34d' : undefined },
    { label: 'Attention', value: c.needsAttention, tone: c.needsAttention ? '#fca5a5' : undefined },
    { label: 'Conflicts', value: conflicts.total, tone: conflicts.errors ? '#fca5a5' : conflicts.total ? '#fcd34d' : undefined },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 10, marginBottom: 18 }}>
      {tiles.map(t => (
        <div key={t.label} className="os-card os-rise" style={{ padding: '13px 15px' }}>
          <div className="jkos-h tabular-nums" style={{ fontSize: 26, color: t.value ? (t.tone || 'var(--text)') : 'var(--muted)' }}>{t.value}</div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>{t.label}</div>
        </div>
      ))}
    </div>
  )
}

function ConflictBanner({ conflicts }: { conflicts: Conflict[] }) {
  const [open, setOpen] = useState(false)
  const errors = conflicts.filter(c => c.severity === 'error')
  const shown = open ? conflicts : conflicts.slice(0, 3)
  return (
    <div className="os-card os-rise" style={{ padding: 14, marginBottom: 18, border: `1px solid ${errors.length ? 'rgba(239,68,68,.4)' : 'var(--line)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <CircleAlert size={18} style={{ color: errors.length ? '#fca5a5' : '#fcd34d' }} />
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} to resolve</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{errors.length} error{errors.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {shown.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, marginTop: 6, flexShrink: 0, background: c.severity === 'error' ? '#ef4444' : '#f59e0b' }} />
            <span style={{ color: 'var(--text)' }}>{c.message}</span>
          </div>
        ))}
      </div>
      {conflicts.length > 3 && (
        <button onClick={() => setOpen(o => !o)} className="os-tap" style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--red)', fontWeight: 700, fontSize: 13, cursor: 'pointer', padding: 0 }}>
          {open ? 'Show less' : `Show all ${conflicts.length}`}
        </button>
      )}
    </div>
  )
}

// ── Day view — confirmed lane (dominant) + pending lane (restrained) ─────────
function DayView({ items, day, conflictsByItem, canSeeValue }: { items: ScheduleItem[]; day: string; conflictsByItem: Map<string, Conflict[]>; canSeeValue: boolean }) {
  const dayItems = items.filter(it => itemDay(it) === day)
  const confirmed = dayItems.filter(it => it.lane === 'confirmed' && !it.cancelled && !it.completed).sort((a, b) => a.sortMinutes - b.sortMinutes)
  const completed = dayItems.filter(it => it.completed && !it.cancelled).sort((a, b) => a.sortMinutes - b.sortMinutes)
  const pending = dayItems.filter(it => it.lane === 'pending' && !it.cancelled).sort((a, b) => a.sortMinutes - b.sortMinutes)

  if (dayItems.length === 0) {
    return (
      <div className="os-card os-rise" style={{ padding: '34px 22px', textAlign: 'center' }}>
        <CalendarDays size={28} style={{ color: 'var(--muted)' }} />
        <p className="jkos-h" style={{ fontSize: 17, marginTop: 10 }}>Nothing scheduled for {fmtDay(day)}</p>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 5 }}>Book Now jobs, manual jobs, and contract routes will appear here together.</p>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <Lane title="Confirmed" count={confirmed.length}>
        {confirmed.map(it => <ItemCard key={it.id} it={it} conflicts={conflictsByItem.get(it.id)} canSeeValue={canSeeValue} />)}
        {confirmed.length === 0 && <Muted>No confirmed work yet for this day.</Muted>}
      </Lane>
      {pending.length > 0 && (
        <Lane title="Pending / tentative" count={pending.length} restrained>
          {pending.map(it => <ItemCard key={it.id} it={it} conflicts={conflictsByItem.get(it.id)} canSeeValue={canSeeValue} restrained />)}
        </Lane>
      )}
      {completed.length > 0 && (
        <Lane title="Completed" count={completed.length}>
          {completed.map(it => <ItemCard key={it.id} it={it} conflicts={conflictsByItem.get(it.id)} canSeeValue={canSeeValue} dim />)}
        </Lane>
      )}
    </div>
  )
}

function Lane({ title, count, restrained, children }: { title: string; count: number; restrained?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
        <h2 className="jkos-h" style={{ fontSize: 16, color: restrained ? 'var(--muted)' : 'var(--text)' }}>{title}</h2>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </section>
  )
}

// ── Week view — overflow-safe auto-fill grid (stacks on mobile) ──────────────
function WeekView({ items, start, today, onPick }: { items: ScheduleItem[]; start: string; today: string; onPick: (d: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
      {days.map(d => {
        const dayItems = items.filter(it => itemDay(it) === d && !it.cancelled).sort((a, b) => a.sortMinutes - b.sortMinutes)
        const isToday = d === today
        return (
          <button key={d} onClick={() => onPick(d)} className="os-card os-tap os-rise"
            aria-label={`Open ${fmtDay(d)} — ${dayItems.length} item${dayItems.length === 1 ? '' : 's'}`}
            style={{ padding: 12, textAlign: 'left', cursor: 'pointer', border: isToday ? '1px solid var(--red)' : '1px solid var(--line)', background: 'var(--card)', minHeight: 96 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: isToday ? 'var(--red)' : 'var(--text)' }}>{fmtDay(d)}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{dayItems.length || ''}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              {dayItems.slice(0, 4).map(it => {
                const s = SOURCE_STYLE[it.source]
                return (
                  <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: s.fg, flexShrink: 0 }} />
                    <span style={{ fontSize: 11.5, color: it.lane === 'pending' ? 'var(--muted)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.timeLabel ? `${it.timeLabel} · ` : ''}{it.title}
                    </span>
                  </div>
                )
              })}
              {dayItems.length > 4 && <span style={{ fontSize: 11, color: 'var(--muted)' }}>+{dayItems.length - 4} more</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function ListView({ title, empty, items, conflictsByItem, canSeeValue }: { title: string; empty: string; items: ScheduleItem[]; conflictsByItem: Map<string, Conflict[]>; canSeeValue: boolean }) {
  return (
    <Lane title={title} count={items.length}>
      {items.length === 0 ? <Muted>{empty}</Muted> : items.map(it => <ItemCard key={it.id} it={it} conflicts={conflictsByItem.get(it.id)} canSeeValue={canSeeValue} showDate />)}
    </Lane>
  )
}

// ── The row every source renders into — the same shape for every edition ─────
function ItemCard({ it, conflicts, canSeeValue, restrained, dim, showDate }: {
  it: ScheduleItem; conflicts?: Conflict[]; canSeeValue: boolean; restrained?: boolean; dim?: boolean; showDate?: boolean
}) {
  const s = SOURCE_STYLE[it.source]
  const hasError = conflicts?.some(c => c.severity === 'error')
  const crewNames = it.crew.map(c => c.name).join(', ')
  return (
    <Link href={it.href} className="os-card os-tap os-rise" style={{
      display: 'block', padding: 15, textDecoration: 'none', color: 'var(--text)',
      opacity: dim ? 0.6 : 1,
      border: hasError ? '1px solid rgba(239,68,68,.45)' : restrained ? '1px dashed var(--line)' : '1px solid var(--line)',
    }}>
      {/* line 1: badges + number + value */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: s.bg, color: s.fg }}>{s.label}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(255,255,255,.06)', color: 'var(--muted)' }}>{it.statusLabel}</span>
        <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{it.number}</span>
        <span style={{ flex: 1 }} />
        {canSeeValue && typeof it.valueCents === 'number' && it.valueCents > 0 && (
          <span style={{ fontSize: 13, fontWeight: 800 }} className="tabular-nums">{money(it.valueCents)}</span>
        )}
      </div>

      {/* line 2: title + service */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 9, flexWrap: 'wrap' }}>
        <span className="jkos-h" style={{ fontSize: 17 }}>{it.title}</span>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{it.serviceLabel}</span>
      </div>

      {/* line 3: time / date / address */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 7, fontSize: 13, color: 'var(--muted)', flexWrap: 'wrap' }}>
        {it.timeLabel && <span style={ico}><Clock size={13} /> {it.timeLabel}</span>}
        {showDate && itemDay(it) && <span style={ico}><CalendarClock size={13} /> {fmtDay(itemDay(it))}</span>}
        {!showDate && it.tentative && <span style={{ ...ico, color: '#fcd34d' }}><CalendarClock size={13} /> Requested {fmtDay(itemDay(it))}</span>}
        {it.address && <span style={ico}><MapPin size={13} /> {it.address}</span>}
      </div>

      {/* line 4: crew / vehicle / equipment / meta chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
        <span style={{ ...ico, color: crewNames ? 'var(--text)' : '#fcd34d' }}><User size={13} /> {crewNames || 'Unassigned'}</span>
        {it.vehicle && <span style={ico}><Truck size={13} /> {it.vehicle}</span>}
        {it.equipment.filter(e => e !== it.vehicle).map((e, i) => <span key={i} style={ico}><Wrench size={13} /> {e}</span>)}
        {it.paymentState && it.paymentState !== 'n/a' && (
          <span style={{ ...ico, color: it.paymentState === 'paid_in_full' ? '#86efac' : it.paymentState === 'unpaid' ? '#fca5a5' : 'var(--muted)' }}>
            <DollarSign size={13} /> {PAYMENT_LABEL[it.paymentState] ?? it.paymentState}
          </span>
        )}
      </div>

      {/* service-specific meta chips (generic — no industry assumption) */}
      {it.meta.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {it.meta.map((m, i) => (
            <span key={i} style={{ fontSize: 11, color: 'var(--muted)', padding: '2px 8px', borderRadius: 7, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)' }}>
              {m.label}: {m.value}
            </span>
          ))}
        </div>
      )}

      {/* attention + conflict flags */}
      {(it.attention.length > 0 || (conflicts?.length ?? 0) > 0) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
          {it.attention.map(a => (
            <span key={a} style={flag('#fcd34d', 'rgba(245,158,11,.14)')}><AlertTriangle size={11} /> {ATTENTION_LABEL[a] ?? a}</span>
          ))}
          {conflicts?.map((c, i) => (
            <span key={`c${i}`} style={flag(c.severity === 'error' ? '#fca5a5' : '#fcd34d', c.severity === 'error' ? 'rgba(239,68,68,.15)' : 'rgba(245,158,11,.14)')}>
              <CircleAlert size={11} /> {c.type.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}
    </Link>
  )
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <div className="os-card" style={{ padding: 16, fontSize: 13.5, color: 'var(--muted)' }}>{children}</div>
)

function Skeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px,1fr))', gap: 10, marginBottom: 18 }}>
        {[0, 1, 2, 3, 4].map(i => <div key={i} className="os-card" style={{ padding: '13px 15px' }}><div className="skeleton" style={{ width: 40, height: 24, borderRadius: 7 }} /><div className="skeleton" style={{ width: '70%', height: 11, borderRadius: 6, marginTop: 8 }} /></div>)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 15 }}><div className="skeleton" style={{ width: 120, height: 14, borderRadius: 7 }} /><div className="skeleton" style={{ width: '55%', height: 18, borderRadius: 8, marginTop: 11 }} /><div className="skeleton" style={{ width: '40%', height: 12, borderRadius: 6, marginTop: 9 }} /></div>)}
      </div>
    </div>
  )
}

// ── shared styles ─────────────────────────────────────────────────────────────
const tab: CSSProperties = { padding: '8px 15px', borderRadius: 999, border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }
const tabActive: CSSProperties = { background: 'var(--text)', color: 'var(--bg, #0b0b0c)', borderColor: 'var(--text)' }
const badgeDot: CSSProperties = { fontSize: 11, fontWeight: 800, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99, background: 'rgba(245,158,11,.2)', color: '#fcd34d', display: 'inline-grid', placeItems: 'center' }
const navBtn: CSSProperties = { width: 38, height: 38, borderRadius: 11, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', display: 'grid', placeItems: 'center', cursor: 'pointer' }
const ico: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }
const flag = (fg: string, bg: string): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: bg, color: fg })

export default function SchedulePage() {
  return <OperationsShell><Schedule /></OperationsShell>
}
