'use client'

import { useEffect, useState } from 'react'
import PortalShell from '../PortalShell'
import { money, fmtDay } from '../ui'

type CompLine = { routeNumber: string; businessName: string; date: string; payCents: number }
type Summary = {
  lifetimeEarningsCents: number; ytdEarningsCents: number; periodEarningsCents: number
  completedRoutes: number; upcomingRoutes: number; businesses: string[]; recent: CompLine[]
}

function Tile({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="os-card" style={{ padding: '16px 18px', flex: 1, minWidth: big ? 200 : 140 }}>
      <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</p>
      <p className="jkos-h" style={{ fontSize: big ? 30 : 22, marginTop: 6 }}>{value}</p>
    </div>
  )
}

function MyPay() {
  const [visible, setVisible] = useState<boolean | null>(null)
  const [s, setS] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/portal/pay', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { setVisible(!!d.visible); setS(d.summary ?? null) })
      .catch(() => setVisible(false))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>My Pay</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Earnings from your completed routes.</p>
      </div>

      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {!loading && !visible && (
        <div className="os-card" style={{ padding: 20 }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Pay details are managed by your administrator and aren't shown here. Reach out to your manager with any pay questions.</p>
        </div>
      )}

      {!loading && visible && s && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Tile label="This week" value={money(s.periodEarningsCents)} big />
            <Tile label="Year to date" value={money(s.ytdEarningsCents)} />
            <Tile label="Lifetime" value={money(s.lifetimeEarningsCents)} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Tile label="Completed routes" value={String(s.completedRoutes)} />
            <Tile label="Upcoming" value={String(s.upcomingRoutes)} />
          </div>

          <div className="os-card os-rise" style={{ padding: 20 }}>
            <h2 className="jkos-h" style={{ fontSize: 17, marginBottom: 4 }}>Recent earnings</h2>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, marginBottom: 12 }}>What you earned on completed work. This reflects earnings, not payments made.</p>
            {s.recent.length ? (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {s.recent.map((l, i) => (
                  <div key={`${l.routeNumber}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                    <div>
                      <p style={{ fontWeight: 600, fontSize: 14 }}>{l.businessName}</p>
                      <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>{fmtDay(l.date)} · {l.routeNumber}</p>
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{money(l.payCents)}</span>
                  </div>
                ))}
              </div>
            ) : <p style={{ color: 'var(--muted)', fontSize: 14 }}>No completed routes yet.</p>}
          </div>

          {s.businesses.length > 0 && (
            <div className="os-card" style={{ padding: 18 }}>
              <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>Clients you've worked</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {s.businesses.map(b => <span key={b} style={{ fontSize: 12.5, padding: '5px 11px', borderRadius: 999, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)' }}>{b}</span>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function MyPayPage() {
  return <PortalShell><MyPay /></PortalShell>
}
