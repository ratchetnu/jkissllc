'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MapPin, Clock, User, ChevronDown, Plus, CalendarDays, AlertTriangle, CheckCircle2 } from 'lucide-react'
import OperationsShell from './OperationsShell'
import { useOps } from './useOps'
import { STATUS as CHIP, scoreColor, ymd, fmtDay, mapsUrl, type RouteStatus } from './ui'

type Op = {
  token: string; routeNumber: string; status: RouteStatus
  businessName: string; reportAddress: string; reportTime: string; routeDate: string
  assignedStaffId?: string; assignedStaffName?: string
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
            <StatCard label="Needs confirmation" value={needsConfirm.length} tone={needsConfirm.length ? 'warn' : 'calm'} Icon={Clock} />
            <StatCard label="Needs reassignment" value={needsReassign.length} tone={needsReassign.length ? 'alert' : 'calm'} Icon={AlertTriangle} />
            <StatCard label="Tomorrow" value={tomorrows.length} tone="calm" Icon={CalendarDays} />
          </div>

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

function StatCard({ label, value, tone, Icon }: { label: string; value: number; tone: 'calm' | 'warn' | 'alert'; Icon: typeof Clock }) {
  const color = tone === 'alert' ? '#fca5a5' : tone === 'warn' ? '#fcd34d' : 'var(--muted)'
  return (
    <Link href="/admin/routes" className="os-card os-tap os-rise" style={{ padding: 16, textDecoration: 'none', display: 'block' }}>
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

export default function OperationsHome() {
  return <OperationsShell><Dashboard /></OperationsShell>
}
