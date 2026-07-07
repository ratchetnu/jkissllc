'use client'

import { use, useEffect, useState } from 'react'
import { CalendarDays, Clock, MapPin, User, AlertTriangle } from 'lucide-react'

type ClientRoute = {
  routeNumber: string
  routeDate: string
  reportTime: string
  reportAddress: string
  status: 'scheduled' | 'confirmed' | 'completed'
  crewFirstName?: string
}

const STATUS: Record<ClientRoute['status'], { label: string; fg: string; bg: string }> = {
  scheduled: { label: 'Scheduled', fg: '#fcd34d', bg: 'rgba(245,158,11,.14)' },
  confirmed: { label: 'Crew confirmed', fg: '#86efac', bg: 'rgba(34,197,94,.16)' },
  completed: { label: 'Completed', fg: '#86efac', bg: 'rgba(34,197,94,.12)' },
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

export default function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [businessName, setBusinessName] = useState('')
  const [routes, setRoutes] = useState<ClientRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/client/${token}`, { cache: 'no-store' })
      .then(async r => { if (r.status === 404) { setNotFound(true); return null } return r.json() })
      .then(d => { if (alive && d) { setBusinessName(d.businessName || ''); setRoutes(d.routes || []) } })
      .catch(() => { if (alive) setNotFound(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [token])

  const wrap = (children: React.ReactNode) => (
    <main style={{ minHeight: '100svh', background: 'var(--bg)', color: 'var(--text)', padding: '28px 18px 48px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 520 }}>
        <p style={{ fontWeight: 900, letterSpacing: '-0.03em', fontSize: 22, marginBottom: 18 }}>
          J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
        </p>
        {children}
      </div>
    </main>
  )
  const card = (bg: string, border: string): React.CSSProperties => ({ background: bg, border: `1px solid ${border}`, borderRadius: 18, padding: 22 })

  if (loading) return wrap(<div className="glass-card" style={{ borderRadius: 18, padding: 22, textAlign: 'center', color: 'var(--muted)' }}>Loading your schedule…</div>)
  if (notFound) return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <AlertTriangle size={26} color="#f59e0b" />
      <h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Link not found</h1>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>This schedule link isn’t valid. Contact J Kiss LLC at (817) 909-4312 for a new one.</p>
    </div>
  )

  const upcoming = routes.filter(r => r.status !== 'completed')
  const done = routes.filter(r => r.status === 'completed')

  return wrap(
    <div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--red)' }}>Route Schedule</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, marginTop: 4, letterSpacing: '-0.02em' }}>{businessName}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 4 }}>Your upcoming routes and crew confirmations with J Kiss LLC.</p>
      </div>

      {routes.length === 0 && (
        <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>No routes are scheduled right now. New routes will appear here as they’re booked.</p>
        </div>
      )}

      {upcoming.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {upcoming.map(r => <RouteCard key={r.routeNumber} r={r} card={card} />)}
        </div>
      )}

      {done.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '26px 0 12px' }}>Recently completed</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {done.map(r => <RouteCard key={r.routeNumber} r={r} card={card} />)}
          </div>
        </>
      )}

      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 26, textAlign: 'center' }}>Questions about your schedule? Call J Kiss LLC at (817) 909-4312.</p>
    </div>
  )
}

function RouteCard({ r, card }: { r: ClientRoute; card: (bg: string, border: string) => React.CSSProperties }) {
  const s = STATUS[r.status]
  const rows: { Icon: typeof CalendarDays; val?: string }[] = [
    { Icon: CalendarDays, val: fmtDate(r.routeDate) },
    { Icon: Clock, val: r.reportTime },
    { Icon: MapPin, val: r.reportAddress },
    { Icon: User, val: r.crewFirstName ? `Crew: ${r.crewFirstName}` : undefined },
  ]
  return (
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{r.routeNumber}</span>
        <span style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 10px', borderRadius: 99, background: s.bg, color: s.fg }}>{s.label}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 12 }}>
        {rows.filter(x => x.val).map((x, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <x.Icon size={16} style={{ color: 'var(--red-glow, #ff6680)', flexShrink: 0 }} />
            <span style={{ fontSize: 14.5, fontWeight: 600 }}>{x.val}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
