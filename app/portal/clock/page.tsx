'use client'

import { useCallback, useEffect, useState } from 'react'
import { Clock, MapPin, AlertTriangle, CheckCircle2, Navigation } from 'lucide-react'
import PortalShell from '../PortalShell'
import { mapsUrl, fmtLongDay } from '../ui'

type Phase = 'not_started' | 'clocked_in' | 'clocked_out'
type Clockable = {
  assigneeToken: string
  routeNumber: string
  businessName: string
  reportAddress: string
  reportTime: string
  routeDate: string
  role: string | null
  status: string
  clockInAt: number | null
  clockOutAt: number | null
  phase: Phase
}

const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

// Ask the phone where it is. Best-effort: no geolocation, a denied prompt, or a
// timeout all resolve to null rather than reject — clocking in must never be blocked
// by a location prompt. The server records `locationDenied` and still saves the time.
function getPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  })
}

function Timeclock() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [routes, setRoutes] = useState<Clockable[] | null>(null)
  const [busy, setBusy] = useState('') // assigneeToken currently punching
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await fetch('/api/portal/clock', { credentials: 'same-origin' }).then((r) => r.json())
      setEnabled(!!d.enabled)
      setRoutes(d.routes ?? [])
    } catch {
      setEnabled(true)
      setRoutes([])
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  async function punch(r: Clockable, action: 'clock_in' | 'clock_out') {
    setErr('')
    setNote('')
    setBusy(r.assigneeToken)
    try {
      const pos = await getPosition()
      const res = await fetch('/api/portal/clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action,
          token: r.assigneeToken,
          lat: pos?.lat,
          lng: pos?.lng,
          accuracy: pos?.accuracy,
          locationDenied: pos === null,
        }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) {
        setErr(d.error ?? 'Could not clock — please try again.')
        return
      }
      if (d.denied) setNote('Clocked ' + (action === 'clock_in' ? 'in' : 'out') + ' — location was off, so no pin was recorded.')
      await load()
    } catch {
      setErr('Connection error — try again.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Timeclock</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>
          Punch in when you arrive and out when you finish. Your location is recorded at each punch so dispatch can
          verify you were on-site — if your phone blocks location, the time is still saved.
        </p>
      </div>

      {enabled === false && (
        <div className="os-card" style={{ padding: 18, display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <Clock size={18} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 1 }} />
          <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
            The timeclock is turned off for your account. If you think that&apos;s a mistake, message dispatch.
          </p>
        </div>
      )}

      {err && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '11px 13px', borderRadius: 11, background: 'rgba(248,113,113,.09)', border: '1px solid rgba(248,113,113,.28)' }}>
          <AlertTriangle size={16} style={{ color: '#fca5a5', flexShrink: 0, marginTop: 1 }} />
          <p style={{ fontSize: 13.5, color: '#fca5a5', lineHeight: 1.45 }}>{err}</p>
        </div>
      )}
      {note && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '11px 13px', borderRadius: 11, background: 'rgba(252,211,77,.09)', border: '1px solid rgba(252,211,77,.28)' }}>
          <AlertTriangle size={16} style={{ color: '#fcd34d', flexShrink: 0, marginTop: 1 }} />
          <p style={{ fontSize: 13.5, color: '#fcd34d', lineHeight: 1.45 }}>{note}</p>
        </div>
      )}

      {enabled !== false && routes === null && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {enabled !== false && routes?.length === 0 && (
        <div className="os-card" style={{ padding: 18 }}>
          <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
            You have no confirmed route to clock into today. Once you confirm an assigned route, it shows up here.
          </p>
        </div>
      )}

      {enabled !== false && routes?.map((r) => {
        const punching = busy === r.assigneeToken
        return (
          <div key={r.assigneeToken} className="os-card os-rise" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontWeight: 800, fontSize: 16 }}>{r.businessName}</p>
                <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 2 }}>
                  {r.routeNumber}{r.role ? ` · ${r.role}` : ''} · {fmtLongDay(r.routeDate)}
                </p>
              </div>
              <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, flexShrink: 0,
                color: r.phase === 'clocked_out' ? '#cbd5e1' : r.phase === 'clocked_in' ? '#86efac' : '#fcd34d',
                background: r.phase === 'clocked_out' ? 'rgba(148,163,184,.14)' : r.phase === 'clocked_in' ? 'rgba(134,239,172,.14)' : 'rgba(252,211,77,.14)' }}>
                {r.phase === 'clocked_out' ? 'Done' : r.phase === 'clocked_in' ? 'On the clock' : 'Not started'}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)' }}>
                <Clock size={14} style={{ flexShrink: 0 }} /> Report at <b style={{ color: 'var(--text)' }}>{r.reportTime}</b>
              </div>
              {r.reportAddress && (
                <a href={mapsUrl(r.reportAddress)} target="_blank" rel="noreferrer" className="os-tap"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--red-glow, #ff6680)', textDecoration: 'none', fontWeight: 600 }}>
                  <MapPin size={14} style={{ flexShrink: 0 }} /> {r.reportAddress} <Navigation size={12} />
                </a>
              )}
            </div>

            {(r.clockInAt || r.clockOutAt) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 4 }}>
                {r.clockInAt && <div style={{ fontSize: 14 }}>🟢 Clocked in at <b>{fmtClock(r.clockInAt)}</b></div>}
                {r.clockOutAt && <div style={{ fontSize: 14 }}>🔴 Clocked out at <b>{fmtClock(r.clockOutAt)}</b></div>}
              </div>
            )}

            {r.phase === 'not_started' && (
              <button onClick={() => punch(r, 'clock_in')} disabled={punching} className="os-tap"
                style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(34,197,94,.4)', background: 'rgba(34,197,94,.1)', color: '#22c55e', fontWeight: 800, fontSize: 14.5, cursor: 'pointer', opacity: punching ? 0.7 : 1 }}>
                {punching ? 'Locating…' : 'Clock In'}
              </button>
            )}
            {r.phase === 'clocked_in' && (
              <button onClick={() => punch(r, 'clock_out')} disabled={punching} className="os-tap"
                style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(224,0,42,.4)', background: 'rgba(224,0,42,.1)', color: '#ff6680', fontWeight: 800, fontSize: 14.5, cursor: 'pointer', opacity: punching ? 0.7 : 1 }}>
                {punching ? 'Locating…' : 'Clock Out'}
              </button>
            )}
            {r.phase === 'clocked_out' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#86efac', fontSize: 13.5, fontWeight: 700 }}>
                <CheckCircle2 size={16} /> Shift complete — thanks!
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function ClockPage() {
  return (
    <PortalShell>
      <Timeclock />
    </PortalShell>
  )
}
