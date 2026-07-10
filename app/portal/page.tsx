'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MapPin, Clock, ArrowRight } from 'lucide-react'
import PortalShell from './PortalShell'
import { money, fmtLongDay, mapsUrl, statusOf } from './ui'

type Route = {
  routeNumber: string; token: string; businessName: string; reportAddress: string
  reportTime: string; routeDate: string; status: string; role: string | null
  payCents: number | null; confirmedAt: number | null; clockInAt: number | null; clockOutAt: number | null
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

function Home() {
  const [me, setMe] = useState<{ name: string } | null>(null)
  const [next, setNext] = useState<Route | null>(null)
  const [upcomingCount, setUpcomingCount] = useState(0)
  const [pay, setPay] = useState<{ visible: boolean; summary?: PaySummary } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const [meRes, routesRes, payRes] = await Promise.all([
          fetch('/api/portal/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
          fetch('/api/portal/routes', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
          fetch('/api/portal/pay', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
        ])
        setMe(meRes.crew ?? null)
        setNext((routesRes.upcoming ?? [])[0] ?? null)
        setUpcomingCount((routesRes.upcoming ?? []).length)
        setPay(payRes.ok ? { visible: payRes.visible, summary: payRes.summary } : null)
      } finally { setLoading(false) }
    })()
  }, [])

  const first = me?.name?.split(' ')[0] ?? 'there'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 26 }}>Hi, {first}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Here's your day at a glance.</p>
      </div>

      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {!loading && (
        <>
          {/* Next route */}
          {next ? (
            <Link href={`/route/${next.token}`} className="os-card os-rise os-tap" style={{ display: 'block', padding: 20, textDecoration: 'none', color: 'inherit' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Your next route</span>
                <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: statusOf(next.status).fg, background: statusOf(next.status).bg }}>{statusOf(next.status).label}</span>
              </div>
              <p className="jkos-h" style={{ fontSize: 20 }}>{next.businessName}</p>
              <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>{fmtLongDay(next.routeDate)}{next.reportTime ? ` · ${next.reportTime}` : ''}{next.role ? ` · ${next.role}` : ''}</p>
              {next.reportAddress && <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13.5, marginTop: 8 }}><MapPin size={14} /> {next.reportAddress}</p>}
              <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--red)', fontWeight: 700, fontSize: 13.5, marginTop: 12 }}>Open route <ArrowRight size={15} /></p>
            </Link>
          ) : (
            <div className="os-card" style={{ padding: 20 }}>
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>No upcoming routes assigned. You'll see them here as soon as you're scheduled.</p>
            </div>
          )}

          {/* Stats */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatTile label="Upcoming" value={String(upcomingCount)} />
            {pay?.visible && pay.summary ? (
              <>
                <StatTile label="This week" value={money(pay.summary.periodEarningsCents)} />
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
  return <PortalShell><Home /></PortalShell>
}
