'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MapPin, CheckCircle2, ArrowRight } from 'lucide-react'
import { money, fmtDay, statusOf } from '../ui'

type Route = {
  routeNumber: string; token: string; businessName: string; reportAddress: string
  reportTime: string; routeDate: string; status: string; role: string | null
  payCents: number | null; confirmedAt: number | null; clockInAt: number | null; clockOutAt: number | null
}

function RouteCard({ r }: { r: Route }) {
  const st = statusOf(r.status)
  return (
    <Link href={`/route/${r.token}`} className="os-card os-tap" style={{ display: 'block', padding: 16, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontWeight: 700, fontSize: 16 }}>{r.businessName}</p>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 3 }}>{fmtDay(r.routeDate)}{r.reportTime ? ` · ${r.reportTime}` : ''}{r.role ? ` · ${r.role}` : ''}</p>
        </div>
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: st.fg, background: st.bg }}>{st.label}</span>
      </div>
      {r.reportAddress && <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, marginTop: 8 }}><MapPin size={13} /> {r.reportAddress}</p>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {r.clockOutAt ? <><CheckCircle2 size={14} style={{ color: '#86efac' }} /> Clocked out</> : r.clockInAt ? <>Clocked in</> : r.confirmedAt ? <>Confirmed</> : <>Tap to confirm</>}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
          {typeof r.payCents === 'number' && <span style={{ color: 'var(--text)' }}>{money(r.payCents)}</span>}
          <ArrowRight size={15} style={{ color: 'var(--red)' }} />
        </span>
      </div>
    </Link>
  )
}

function MyRoutes() {
  const [upcoming, setUpcoming] = useState<Route[]>([])
  const [past, setPast] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/portal/routes', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { setUpcoming(d.upcoming ?? []); setPast(d.past ?? []) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 className="jkos-h" style={{ fontSize: 24 }}>My Routes</h1>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {!loading && (
        <>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Upcoming</h2>
            {upcoming.length ? upcoming.map(r => <RouteCard key={r.token} r={r} />)
              : <div className="os-card" style={{ padding: 16 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>Nothing scheduled yet.</p></div>}
          </section>

          {past.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Past</h2>
              {past.map(r => <RouteCard key={r.token} r={r} />)}
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default function MyRoutesPage() {
  return <MyRoutes />
}
