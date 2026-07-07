'use client'

import { use, useEffect, useState } from 'react'
import { MapPin, Clock, CalendarDays, Building2, Truck, DollarSign, User, Phone, FileText, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'

type PublicRoute = {
  token: string
  routeNumber: string
  status: string
  businessName: string
  contactPerson?: string
  contactPhone?: string
  reportAddress: string
  reportTime: string
  routeDate: string
  description?: string
  payRate?: string
  vehicle?: string
  specialNotes?: string
  assignedStaffName?: string
  confirmedAt?: number
  declinedAt?: number
  expired: boolean
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const mapsUrl = (addr: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`

export default function RouteConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [route, setRoute] = useState<PublicRoute | null>(null)
  const [disclaimer, setDisclaimer] = useState('')
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState<'' | 'confirm' | 'decline'>('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    fetch(`/api/route/${token}`, { cache: 'no-store' })
      .then(async r => { if (r.status === 404) { setNotFound(true); return null } return r.json() })
      .then(d => { if (alive && d) { setRoute(d.route); setDisclaimer(d.disclaimer || '') } })
      .catch(() => { if (alive) setNotFound(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [token])

  async function act(action: 'confirm' | 'decline') {
    if (action === 'confirm' && !agreed) { setErr('Please check the box to agree before confirming.'); return }
    setBusy(action); setErr('')
    try {
      const res = await fetch(`/api/route/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'confirm' ? { action, disclaimerAccepted: true } : { action }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok && !d.route) { setErr(d.error === 'expired' ? 'This route link has expired.' : d.error === 'cancelled' ? 'This route was cancelled.' : (d.error || 'Something went wrong. Please try again.')) }
      if (d.route) setRoute(d.route)
    } catch { setErr('Network error — please try again.') }
    finally { setBusy('') }
  }

  const wrap = (children: React.ReactNode) => (
    <main style={{ minHeight: '100svh', background: 'var(--bg)', color: 'var(--text)', padding: '28px 18px 48px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        <p style={{ fontWeight: 900, letterSpacing: '-0.03em', fontSize: 22, marginBottom: 18 }}>
          J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
        </p>
        {children}
      </div>
    </main>
  )
  const card = (bg: string, border: string): React.CSSProperties => ({ background: bg, border: `1px solid ${border}`, borderRadius: 18, padding: 22 })

  if (loading) return wrap(<div className="glass-card" style={{ borderRadius: 18, padding: 22, textAlign: 'center', color: 'var(--muted)' }}>Loading your route…</div>)
  if (notFound || !route) return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <AlertTriangle size={26} color="#f59e0b" />
      <h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Link not found</h1>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>This confirmation link isn’t valid. It may have been mistyped. Contact dispatch at (817) 909-4312.</p>
    </div>
  )

  const Details = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
      {([
        { Icon: CalendarDays, label: 'Date', val: fmtDate(route.routeDate) },
        { Icon: Clock, label: 'Report time', val: route.reportTime },
        { Icon: Building2, label: 'Client', val: route.businessName },
        { Icon: Truck, label: 'Vehicle / equipment', val: route.vehicle },
        { Icon: DollarSign, label: 'Pay / rate', val: route.payRate },
        { Icon: User, label: 'On-site contact', val: route.contactPerson },
        { Icon: Phone, label: 'Contact phone', val: route.contactPhone },
      ] as { Icon: typeof CalendarDays; label: string; val?: string }[])
        .filter(r => r.val).map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <r.Icon size={17} style={{ color: 'var(--red-glow, #ff6680)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--muted)' }}>{r.label}</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{r.val}</div>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
        <MapPin size={17} style={{ color: 'var(--red-glow, #ff6680)', flexShrink: 0, marginTop: 2 }} />
        <div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--muted)' }}>Report location</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{route.reportAddress}</div>
          <a href={mapsUrl(route.reportAddress)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Open in Maps →</a>
        </div>
      </div>
      {(route.description || route.specialNotes) && (
        <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <FileText size={17} style={{ color: 'var(--red-glow, #ff6680)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--muted)' }}>Instructions</div>
            {route.description && <div style={{ fontSize: 14, marginTop: 2 }}>{route.description}</div>}
            {route.specialNotes && <div style={{ fontSize: 14, marginTop: 6, color: 'var(--muted)' }}>{route.specialNotes}</div>}
          </div>
        </div>
      )}
    </div>
  )

  // ── Terminal states ──
  if (route.expired) return wrap(<div style={card('rgba(245,158,11,.08)', 'rgba(245,158,11,.3)')}><AlertTriangle size={26} color="#f59e0b" /><h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>This route link has expired</h1><p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>The route date has passed. If you have questions, contact dispatch at (817) 909-4312.</p></div>)
  if (route.status === 'cancelled') return wrap(<div style={card('rgba(255,255,255,.04)', 'var(--line)')}><XCircle size={26} color="var(--muted)" /><h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Route cancelled</h1><p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>This route has been cancelled by dispatch. No action is needed.</p></div>)
  if (route.status === 'confirmed') return wrap(
    <div style={card('rgba(34,197,94,.08)', 'rgba(34,197,94,.3)')}>
      <CheckCircle2 size={28} color="#22c55e" />
      <h1 style={{ fontSize: 20, fontWeight: 800, marginTop: 10 }}>You’re confirmed ✓</h1>
      <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 14 }}>Thanks{route.assignedStaffName ? `, ${route.assignedStaffName.split(' ')[0]}` : ''} — you’re set for this route. Please report on time.</p>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}><Details /></div>
    </div>
  )
  if (route.status === 'declined') return wrap(<div style={card('rgba(255,255,255,.04)', 'var(--line)')}><XCircle size={26} color="#f87171" /><h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>You declined this route</h1><p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>Dispatch has been notified and will reassign it. Thanks for letting us know.</p></div>)

  // ── Actionable ──
  return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--red)' }}>Route Assignment · {route.routeNumber}</div>
      <h1 style={{ fontSize: 21, fontWeight: 800, marginTop: 6, letterSpacing: '-0.02em' }}>Can you take this route?</h1>
      <div style={{ marginTop: 16 }}><Details /></div>

      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 20, padding: 14, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', cursor: 'pointer' }}>
        <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0, accentColor: 'var(--red)' }} />
        <span style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)' }}>{disclaimer}</span>
      </label>

      {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 12 }}>{err}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
        <button onClick={() => act('confirm')} disabled={busy !== '' || !agreed}
          style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 15, color: '#fff', cursor: agreed ? 'pointer' : 'not-allowed', background: agreed ? 'var(--red)' : 'rgba(255,255,255,.1)', opacity: busy === 'confirm' ? .7 : 1 }}>
          {busy === 'confirm' ? 'Confirming…' : 'I Confirm I Will Be There'}
        </button>
        <button onClick={() => act('decline')} disabled={busy !== ''}
          style={{ width: '100%', padding: '15px', borderRadius: 12, border: '1px solid var(--line)', fontWeight: 700, fontSize: 15, color: 'var(--muted)', background: 'transparent', cursor: 'pointer', opacity: busy === 'decline' ? .7 : 1 }}>
          {busy === 'decline' ? 'Sending…' : 'I Cannot Take This Route'}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, textAlign: 'center' }}>Questions? Text or call dispatch at (817) 909-4312.</p>
    </div>
  )
}
