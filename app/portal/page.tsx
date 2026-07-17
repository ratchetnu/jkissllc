'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MapPin, Clock, ArrowRight, Navigation, Truck, Users, FileText, AlertTriangle, CheckCircle2 } from 'lucide-react'
import CrewTasks from './CrewTasks'
import { money, fmtLongDay, mapsUrl, statusOf } from './ui'

type Crewmate = { name: string; role: string | null }
type Route = {
  routeNumber: string; token: string; businessName: string; reportAddress: string
  reportTime: string; routeDate: string; status: string; role: string | null
  description: string | null; specialNotes: string | null; vehicle: string | null
  payCents: number | null; confirmedAt: number | null; clockInAt: number | null; clockOutAt: number | null
  crew: Crewmate[]
}
type PaySummary = { periodEarningsCents: number; ytdEarningsCents: number; completedRoutes: number; upcomingRoutes: number }

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="os-card" style={{ padding: '14px 16px', flex: 1, minWidth: 130 }}>
      <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</p>
      <p className="jkos-h" style={{ fontSize: 24, marginTop: 6 }}>{value}</p>
    </div>
  )
}

// A row of detail with an icon. `href` turns it into a link (used for navigation).
function Detail({ icon, children, href }: { icon: React.ReactNode; children: React.ReactNode; href?: string }) {
  const inner = (
    <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, color: href ? 'var(--red-glow, #ff6680)' : 'var(--muted)', fontWeight: href ? 600 : 400 }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <span>{children}</span>
    </span>
  )
  return href ? <a href={href} target="_blank" rel="noreferrer" className="os-tap" style={{ textDecoration: 'none' }}>{inner}</a> : inner
}

// One of today's jobs, in full: arrival, address + navigation, equipment, dispatch
// instructions, who else is on it, and the next action the crew member owes.
function TodayJob({ r }: { r: Route }) {
  const st = statusOf(r.status)
  const needsConfirm = !r.confirmedAt && r.status !== 'completed' && r.status !== 'cancelled'
  const onClock = !!r.clockInAt && !r.clockOutAt
  const done = !!r.clockOutAt || r.status === 'completed'
  return (
    <div className="os-card os-rise" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p className="jkos-h" style={{ fontSize: 19 }}>{r.businessName}</p>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 2 }}>{r.routeNumber}{r.role ? ` · ${r.role}` : ''}</p>
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, flexShrink: 0, color: st.fg, background: st.bg }}>{st.label}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <Detail icon={<Clock size={14} />}>Report at <b style={{ color: 'var(--text)' }}>{r.reportTime || 'TBD'}</b></Detail>
        {r.reportAddress && <Detail icon={<MapPin size={14} />} href={mapsUrl(r.reportAddress)}>{r.reportAddress} · Navigate <Navigation size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /></Detail>}
        {r.vehicle && <Detail icon={<Truck size={14} />}>{r.vehicle}</Detail>}
        {r.crew.length > 0 && <Detail icon={<Users size={14} />}>With {r.crew.map(c => c.name.split(' ')[0]).join(', ')}</Detail>}
        {(r.description || r.specialNotes) && (
          <Detail icon={<FileText size={14} />}>
            <span style={{ color: 'var(--text)' }}>{[r.description, r.specialNotes].filter(Boolean).join(' — ')}</span>
          </Detail>
        )}
      </div>

      {/* Next action */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 2 }}>
        {needsConfirm && (
          <Link href={`/route/${r.token}`} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', borderRadius: 11, background: 'rgba(245,158,11,.14)', border: '1px solid rgba(245,158,11,.4)', color: '#fcd34d', fontWeight: 800, fontSize: 13.5, textDecoration: 'none' }}>
            <AlertTriangle size={15} /> Confirm this route
          </Link>
        )}
        {!needsConfirm && !done && (
          <Link href="/portal/clock" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', borderRadius: 11, background: onClock ? 'rgba(224,0,42,.1)' : 'rgba(34,197,94,.1)', border: `1px solid ${onClock ? 'rgba(224,0,42,.4)' : 'rgba(34,197,94,.4)'}`, color: onClock ? '#ff6680' : '#22c55e', fontWeight: 800, fontSize: 13.5, textDecoration: 'none' }}>
            <Clock size={15} /> {onClock ? 'Clock out' : 'Clock in'}
          </Link>
        )}
        {done && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: '#86efac', fontSize: 13.5, fontWeight: 700 }}><CheckCircle2 size={15} /> Shift complete</span>}
        <Link href={`/route/${r.token}`} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 15px', borderRadius: 11, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 13.5, textDecoration: 'none' }}>
          Route details <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  )
}

function Home() {
  const [me, setMe] = useState<{ name: string } | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [today, setToday] = useState('')
  const [pay, setPay] = useState<{ visible: boolean; summary?: PaySummary } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [meRes, routesRes, payRes] = await Promise.all([
          fetch('/api/portal/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
          fetch('/api/portal/routes', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
          fetch('/api/portal/pay', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
        ])
        if (!alive) return
        setMe(meRes.crew ?? null)
        setRoutes(routesRes.upcoming ?? [])
        setToday(routesRes.today ?? '')
        setPay(payRes.ok ? { visible: payRes.visible, summary: payRes.summary } : null)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const first = me?.name?.split(' ')[0] ?? 'there'
  const todayJobs = today ? routes.filter(r => r.routeDate === today) : []
  const nextUp = routes.find(r => r.routeDate !== today) ?? null
  const upcomingCount = routes.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 26 }}>Hi, {first}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Here&apos;s your day at a glance.</p>
      </div>

      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {/* Today's tasks, urgent alerts, reminders, uniform + one-tap acknowledgement */}
      <CrewTasks />

      {!loading && (
        <>
          {/* Today's jobs — the command center */}
          {todayJobs.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                Today · {todayJobs.length} {todayJobs.length === 1 ? 'job' : 'jobs'}
              </h2>
              {todayJobs.map(r => <TodayJob key={r.token} r={r} />)}
            </section>
          )}

          {/* Next up (a later day) */}
          {nextUp ? (
            <Link href={`/route/${nextUp.token}`} className="os-card os-rise os-tap" style={{ display: 'block', padding: 20, textDecoration: 'none', color: 'inherit' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{todayJobs.length > 0 ? 'Next up' : 'Your next route'}</span>
                <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: statusOf(nextUp.status).fg, background: statusOf(nextUp.status).bg }}>{statusOf(nextUp.status).label}</span>
              </div>
              <p className="jkos-h" style={{ fontSize: 20 }}>{nextUp.businessName}</p>
              <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>{fmtLongDay(nextUp.routeDate)}{nextUp.reportTime ? ` · ${nextUp.reportTime}` : ''}{nextUp.role ? ` · ${nextUp.role}` : ''}</p>
              {nextUp.reportAddress && <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13.5, marginTop: 8 }}><MapPin size={14} /> {nextUp.reportAddress}</p>}
              <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--red)', fontWeight: 700, fontSize: 13.5, marginTop: 12 }}>Open route <ArrowRight size={15} /></p>
            </Link>
          ) : todayJobs.length === 0 ? (
            <div className="os-card" style={{ padding: 20 }}>
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>No upcoming routes assigned. You&apos;ll see them here as soon as you&apos;re scheduled.</p>
            </div>
          ) : null}

          {/* Stats — current pay period summary */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatTile label="Upcoming" value={String(upcomingCount)} />
            {pay?.visible && pay.summary ? (
              <>
                <StatTile label="This pay period" value={money(pay.summary.periodEarningsCents)} />
                <StatTile label="Year to date" value={money(pay.summary.ytdEarningsCents)} />
              </>
            ) : (
              <StatTile label="Completed" value={String(pay?.summary?.completedRoutes ?? 0)} />
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link href="/portal/routes" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderRadius: 12, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}><Clock size={16} /> All my routes</Link>
            <Link href="/portal/pay" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderRadius: 12, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>My pay <ArrowRight size={15} /></Link>
          </div>
        </>
      )}
    </div>
  )
}

export default function PortalHomePage() {
  return <Home />
}
