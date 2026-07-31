'use client'

import { use, useCallback, useEffect, useState } from 'react'
import { COMPANY } from '../../lib/company';
import { MapPin, Clock, CalendarDays, Building2, Truck, DollarSign, User, Phone, FileText, CheckCircle2, XCircle, AlertTriangle, Camera, WifiOff, RefreshCw } from 'lucide-react'
// The weak-network helpers are shared with the crew portal. They contain nothing
// portal-specific — `fetchWithRetry` is a plain bounded-retry wrapper and
// `useConnectivity` reads navigator.onLine — so this public surface gets exactly the
// same treatment rather than a second implementation that could drift.
import { fetchWithRetry } from '../../portal/network'
import { useConnectivity } from '../../portal/useConnectivity'
import { applyLoadOutcome, loadPublicRoute, CONNECTION_ERROR, INITIAL_VIEW_STATE, type PublicRoute } from './load'

// The four verbs this API implements idempotently: confirm/decline stamp the
// assignee once (`assignee.confirmedAt || assignee.declinedAt` -> `already`), and
// each punch is guarded by its own stamp (`assignee.clockInAt` / `clockOutAt`). A
// dropped response can therefore be replayed without a second write.
//
// `complete` is deliberately ABSENT. It is in fact status-idempotent server-side
// (`route.status === 'completed'` returns `already`), but completion carries photos
// and a note, and the booking lane needed a request-level key before its completion
// could be retried safely. Keeping this surface single-attempt matches that decision
// rather than relying on a second, differently-argued proof.
const RETRY_SAFE_ACTIONS = new Set(['confirm', 'decline', 'clock_in', 'clock_out'])


// Ask the phone where it is. Best-effort: if the browser has no geolocation, or
// the crew member denies it / it times out, we resolve to null coordinates rather
// than reject — clocking in must never be blocked by a location prompt.
function getPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  })
}
const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const mapsUrl = (addr: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
const DECLINE_REASONS = ['Not available that day', 'Time doesn’t work', 'Too far', 'Already committed', 'Other']

export default function RouteConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [view, setView] = useState(INITIAL_VIEW_STATE)
  const { route, notFound, loadError } = view
  const setRoute = (r: PublicRoute | null) =>
    setView(v => ({ ...v, route: r, loadError: r ? '' : v.loadError }))
  const [disclaimer, setDisclaimer] = useState('')
  const [loading, setLoading] = useState(true)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState<'' | 'confirm' | 'decline' | 'complete'>('')
  const [err, setErr] = useState('')
  const [completeMode, setCompleteMode] = useState(false)
  const [declineMode, setDeclineMode] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [declineNote, setDeclineNote] = useState('')
  const [note, setNote] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [clocking, setClocking] = useState<'' | 'clock_in' | 'clock_out'>('')
  const [clockWarn, setClockWarn] = useState('')
  const [networkMsg, setNetworkMsg] = useState('')
  const { offline } = useConnectivity()

  // Completing closes an OPEN punch server-side, so the notice below has to say so —
  // otherwise the contractor is silently clocked out. This reads the RAW stamps the
  // public projection already exposes; the server decides on the EFFECTIVE punch
  // (corrections applied), and deliberately nothing about corrections is exposed here.
  // Those two can disagree — an admin correction may have closed a punch whose raw
  // clock-out is still null — which is exactly why the notice is worded as a
  // condition ("If you're still clocked in…") rather than as an assertion. Hedged
  // copy is correct under both readings; asserting "you are clocked in" would not be.
  const willClockOut = !!route?.clockInAt && !route?.clockOutAt

  const load = useCallback(async () => {
    // `notFound` is set ONLY by a literal 404. Every other failure keeps whatever is
    // already on screen and surfaces a retryable connection/service error, so a
    // dropped signal is never reported as a dead link.
    const outcome = await loadPublicRoute(token, {
      onRetry: () => setNetworkMsg('Connection is shaky — retrying…'),
    })
    setView(v => applyLoadOutcome(v, outcome))
    if (outcome.kind === 'ok') setDisclaimer(outcome.disclaimer)
    setNetworkMsg('')
  }, [token])

  // Reload when the connection returns. Going offline deliberately does NOT clear
  // `route`, so the details stay readable in a basement or a dead zone.
  useEffect(() => {
    if (!offline) void load().finally(() => setLoading(false))
  }, [offline, load])

  async function act(action: 'confirm' | 'decline', reason?: string) {
    if (action === 'confirm' && !agreed) { setErr('Please check the box to agree before confirming.'); return }
    // Offline is refused BEFORE the busy flag is set, so a refusal can never strand
    // the buttons in a permanently-disabled state.
    if (offline) { setErr('You’re offline. Reconnect before saving this.'); return }
    setBusy(action); setErr(''); setNetworkMsg('')
    try {
      const res = await fetchWithRetry(`/api/route/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'confirm' ? { action, disclaimerAccepted: true } : { action, reason: reason || undefined }),
      }, {
        allowMutationRetry: RETRY_SAFE_ACTIONS.has(action),
        onRetry: () => setNetworkMsg('Connection dropped — retrying this safely…'),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok && !d.route) { setErr(d.error === 'expired' ? 'This route link has expired.' : d.error === 'cancelled' ? 'This route was cancelled.' : (d.error || 'Something went wrong. Please try again.')) }
      if (d.route) setRoute(d.route)
    } catch { setErr('Network error — please try again.') }
    finally { setNetworkMsg(''); setBusy('') }
  }

  async function onPickPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setUploading(true); setErr('')
    for (const f of files) {
      if (photos.length >= 6) break
      try {
        const dataUrl = await new Promise<string>((res, rej) => {
          const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(f)
        })
        const up = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
        const j = await up.json().catch(() => ({}))
        if (up.ok && j.url) setPhotos(p => [...p, j.url].slice(0, 6))
        else setErr(j.error || 'A photo failed to upload.')
      } catch { setErr('A photo failed to upload.') }
    }
    setUploading(false)
  }

  async function clock(action: 'clock_in' | 'clock_out') {
    // NO punch is ever stored for later delivery. If there is no connection the punch
    // is refused outright and the crew member is told, because a queued punch would
    // record the moment the network came back as the moment they arrived.
    if (offline) { setErr('You’re offline. A punch can’t be saved until you reconnect — it would record the wrong time.'); return }
    setClocking(action); setErr(''); setClockWarn(''); setNetworkMsg('')
    try {
      const pos = await getPosition()
      // GPS didn't pick up — warn the crew member before recording. If they turn
      // location on and retry, the punch is clean; if they proceed anyway, the
      // carrier is alerted that their location was off.
      if (pos === null) {
        const proceed = confirm(
          'GPS didn’t pick up your location.\n\n' +
          'Your location is off, so we can’t verify you’re on-site. You can still ' +
          (action === 'clock_in' ? 'clock in' : 'clock out') + ', but an alert will be sent to the carrier.\n\n' +
          'Turn on Location Services and try again — or tap OK to continue without it.'
        )
        if (!proceed) { setClocking(''); return }
      }
      const res = await fetchWithRetry(`/api/route/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          lat: pos?.lat, lng: pos?.lng, accuracy: pos?.accuracy,
          locationDenied: pos === null,
        }),
      }, {
        // Each punch is guarded by its own stamp server-side, so replaying a dropped
        // response returns `already` instead of writing a second punch — and the
        // FIRST timestamp is what persists.
        allowMutationRetry: RETRY_SAFE_ACTIONS.has(action),
        onRetry: () => setNetworkMsg('Connection dropped — retrying this punch safely…'),
      })
      const d = await res.json().catch(() => ({}))
      if (d.route) {
        setRoute(d.route)
        if (d.locationOff) setClockWarn('GPS couldn’t verify your location, so an alert was sent to the carrier. Turn on Location Services next time for a clean record.')
      } else if (!res.ok) setErr(d.error || 'Could not record that — please try again.')
    } catch { setErr('Network error — please try again.') }
    finally { setNetworkMsg(''); setClocking('') }
  }

  async function submitComplete() {
    if (offline) { setErr('You’re offline. Reconnect before submitting completion.'); return }
    setBusy('complete'); setErr('')
    try {
      // Completion is NOT in RETRY_SAFE_ACTIONS, so this stays a single attempt.
      const res = await fetchWithRetry(`/api/route/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', note: note.trim() || undefined, photos }),
      }, { allowMutationRetry: RETRY_SAFE_ACTIONS.has('complete') })
      const d = await res.json().catch(() => ({}))
      if (d.route) setRoute(d.route)
      else if (!res.ok) setErr(d.error || 'Could not submit — please try again.')
    } catch { setErr('Network error — please try again.') }
    finally { setBusy('') }
  }

  const wrap = (children: React.ReactNode) => (
    <main style={{ minHeight: '100svh', background: 'var(--bg)', color: 'var(--text)', padding: '28px 18px 48px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        <p style={{ fontWeight: 900, letterSpacing: '-0.03em', fontSize: 22, marginBottom: 18 }}>
          {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
        </p>
        {offline && (
          <div role="status" style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '11px 13px', marginBottom: 14, borderRadius: 10, color: '#fcd34d', border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.08)' }}>
            <WifiOff size={16} aria-hidden="true" />
            <span style={{ fontSize: 13 }}>You’re offline. Your route stays visible, but confirming and clocking wait until you reconnect.</span>
          </div>
        )}
        {networkMsg && <p role="status" aria-live="polite" style={{ color: '#fcd34d', fontSize: 13, marginBottom: 12 }}>{networkMsg}</p>}
        {loadError && route && (
          <div role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '11px 13px', marginBottom: 14, borderRadius: 10, border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.08)' }}>
            <span style={{ fontSize: 13, color: '#fcd34d', flex: '1 1 200px' }}>{loadError} Your route below is still the last known version.</span>
            <button type="button" className="os-tap" onClick={() => void load()} disabled={offline}
              style={{ minHeight: 44, padding: '0 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0, opacity: offline ? .55 : 1, cursor: offline ? 'not-allowed' : 'pointer' }}>
              <RefreshCw size={15} aria-hidden="true" /> Retry
            </button>
          </div>
        )}
        {children}
      </div>
    </main>
  )
  const card = (bg: string, border: string): React.CSSProperties => ({ background: bg, border: `1px solid ${border}`, borderRadius: 18, padding: 22 })

  if (loading) return wrap(<div className="glass-card" style={{ borderRadius: 18, padding: 22, textAlign: 'center', color: 'var(--muted)' }}>Loading your route…</div>)
  // ONLY a real 404 says the link is invalid. This guard used to read
  // `notFound || !route`, so every connection failure produced this card.
  if (notFound) return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <AlertTriangle size={26} color="#f59e0b" />
      <h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Link not found</h1>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>This confirmation link isn’t valid. It may have been mistyped. Contact dispatch at {COMPANY.phoneDisplay}.</p>
    </div>
  )

  // Nothing loaded yet AND the device is offline — say that, not that the route is
  // missing. Reconnecting reloads on its own via the effect above.
  if (!route && offline) return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <WifiOff size={26} color="#fcd34d" />
      <h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>You’re offline</h1>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>
        Your route can’t load without a connection. It will appear on its own as soon as you’re back online — your link is still valid.
      </p>
    </div>
  )

  // Nothing loaded yet and the read failed for a reason that is NOT a 404.
  if (!route) return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <AlertTriangle size={26} color="#f59e0b" />
      <h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Couldn’t load your route</h1>
      <p role="alert" style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>
        {loadError || CONNECTION_ERROR} Your link is still valid — this is a connection problem, not a missing route.
      </p>
      <button type="button" className="os-tap" onClick={() => { setLoading(true); void load().finally(() => setLoading(false)) }}
        style={{ minHeight: 44, marginTop: 14, padding: '0 16px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', cursor: 'pointer' }}>
        <RefreshCw size={15} aria-hidden="true" /> Try again
      </button>
    </div>
  )

  const Details = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
      {([
        { Icon: CalendarDays, label: 'Date', val: fmtDate(route.routeDate) },
        { Icon: Clock, label: 'Report time', val: route.reportTime },
        { Icon: Building2, label: 'Client', val: route.businessName },
        { Icon: Truck, label: 'Vehicle / equipment', val: route.vehicle },
        { Icon: DollarSign, label: 'Your pay', val: route.payRate },   // this crew member's own pay; omitted entirely when the owner disables it
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
  if (route.expired) return wrap(<div style={card('rgba(245,158,11,.08)', 'rgba(245,158,11,.3)')}><AlertTriangle size={26} color="#f59e0b" /><h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>This route link has expired</h1><p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>The route date has passed. If you have questions, contact dispatch at {COMPANY.phoneDisplay}.</p></div>)
  if (route.status === 'cancelled') return wrap(<div style={card('rgba(255,255,255,.04)', 'var(--line)')}><XCircle size={26} color="var(--muted)" /><h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Route cancelled</h1><p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>This route has been cancelled by dispatch. No action is needed.</p></div>)
  if (route.status === 'completed') return wrap(
    <div style={card('rgba(34,197,94,.08)', 'rgba(34,197,94,.3)')}>
      <CheckCircle2 size={28} color="#22c55e" />
      <h1 style={{ fontSize: 20, fontWeight: 800, marginTop: 10 }}>Route completed ✓</h1>
      <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 14 }}>Thanks{route.assignedStaffName ? `, ${route.assignedStaffName.split(' ')[0]}` : ''} — this route is marked done{route.completedAt ? ` on ${new Date(route.completedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.</p>
      {route.completionNote && <p style={{ marginTop: 12, fontSize: 14, padding: 12, borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }}>{route.completionNote}</p>}
      {route.completionPhotos && route.completionPhotos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {route.completionPhotos.map((u, i) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <a key={i} href={u} target="_blank" rel="noopener noreferrer"><img src={u} alt="Completion photo" style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} /></a>
          ))}
        </div>
      )}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}><Details /></div>
    </div>
  )
  if (route.status === 'confirmed') return wrap(
    <div style={card('rgba(34,197,94,.08)', 'rgba(34,197,94,.3)')}>
      <CheckCircle2 size={28} color="#22c55e" />
      <h1 style={{ fontSize: 20, fontWeight: 800, marginTop: 10 }}>You’re confirmed ✓</h1>
      <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 14 }}>
        {route.dispatchReady
          ? `Thanks${route.assignedStaffName ? `, ${route.assignedStaffName.split(' ')[0]}` : ''} — you’re set for this route. Please report on time.`
          : route.dispatchHold === 'equipment'
            ? `Thanks${route.assignedStaffName ? `, ${route.assignedStaffName.split(' ')[0]}` : ''} — your spot is confirmed. Dispatch is assigning the required equipment; you do not need to confirm again.`
            : `Thanks${route.assignedStaffName ? `, ${route.assignedStaffName.split(' ')[0]}` : ''} — your spot is confirmed. Dispatch is finalizing the remaining crew details; you do not need to confirm again.`}
      </p>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}><Details /></div>

      {/* Timeclock — punch in on arrival, out when done. Captures GPS to verify
          you were on-site; if your phone blocks location it still records the time.
          Hidden entirely for crew the owner has opted out of the clock. */}
      {route.timeclock !== false && <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 800, marginBottom: 10 }}>
          <Clock size={16} style={{ color: 'var(--red-glow, #ff6680)' }} /> Timeclock
        </div>
        {clockWarn && (
          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 12, padding: '11px 13px', borderRadius: 11, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.35)' }}>
            <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12.5, color: '#fcd34d', lineHeight: 1.5 }}>{clockWarn}</span>
          </div>
        )}
        {(route.clockInAt || route.clockOutAt) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: route.clockOutAt ? 0 : 12 }}>
            {route.clockInAt && <div style={{ fontSize: 14, color: 'var(--text)' }}>🟢 Clocked in at <b>{fmtClock(route.clockInAt)}</b></div>}
            {route.clockOutAt && <div style={{ fontSize: 14, color: 'var(--text)' }}>🔴 Clocked out at <b>{fmtClock(route.clockOutAt)}</b></div>}
          </div>
        )}
        {!route.clockInAt ? (
          <button onClick={() => clock('clock_in')} disabled={clocking !== '' || offline}
            style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(34,197,94,.4)', background: 'rgba(34,197,94,.1)', color: '#22c55e', fontWeight: 800, fontSize: 14.5, cursor: 'pointer', opacity: clocking === 'clock_in' ? .7 : 1 }}>
            {clocking === 'clock_in' ? 'Locating…' : 'Clock In'}
          </button>
        ) : !route.clockOutAt ? (
          <button onClick={() => clock('clock_out')} disabled={clocking !== '' || offline}
            style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(224,0,42,.4)', background: 'rgba(224,0,42,.1)', color: '#ff6680', fontWeight: 800, fontSize: 14.5, cursor: 'pointer', opacity: clocking === 'clock_out' ? .7 : 1 }}>
            {clocking === 'clock_out' ? 'Locating…' : 'Clock Out'}
          </button>
        ) : null}
        {!route.clockInAt && <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 9 }}>Your location is recorded when you clock in, so dispatch can verify you were on-site.</p>}
      </div>}

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        {!completeMode ? (
          <button onClick={() => setCompleteMode(true)}
            style={{ width: '100%', padding: '13px', borderRadius: 12, border: '1px solid rgba(34,197,94,.4)', background: 'rgba(34,197,94,.1)', color: '#22c55e', fontWeight: 800, fontSize: 14.5, cursor: 'pointer' }}>
            Mark Route Complete
          </button>
        ) : (
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 8 }}>Wrap up this route</div>
            {willClockOut && (
              <p role="status" style={{ fontSize: 12.5, lineHeight: 1.5, color: '#fcd34d', margin: '0 0 10px', padding: '9px 11px', borderRadius: 10, border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.08)' }}>
                If you’re still clocked in, completing this route will clock you out automatically.
              </p>
            )}
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              placeholder="Optional note — how it went, anything dispatch should know…"
              style={{ width: '100%', padding: '11px 12px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 14, resize: 'vertical', fontFamily: 'inherit' }} />
            <label className="file-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '9px 13px', borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)', fontSize: 13.5, fontWeight: 600, cursor: photos.length >= 6 ? 'not-allowed' : 'pointer', color: 'var(--muted)', opacity: photos.length >= 6 ? .5 : 1 }}>
              <Camera size={16} /> {uploading ? 'Uploading…' : photos.length >= 6 ? 'Max 6 photos' : 'Add photo'}
              <input type="file" aria-label="Add a photo to this route" accept="image/*" capture="environment" multiple onChange={onPickPhotos} className="file-input-a11y" disabled={uploading || offline || photos.length >= 6} />
            </label>
            {photos.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {photos.map((u, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="Route photo" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
                    <button onClick={() => setPhotos(p => p.filter((_, j) => j !== i))} aria-label="Remove photo"
                      style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 99, border: 'none', background: '#111', color: '#fff', fontSize: 13, cursor: 'pointer', lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button onClick={submitComplete} disabled={busy === 'complete' || uploading || offline}
                style={{ flex: 1, padding: '13px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 14.5, color: '#fff', background: '#16a34a', cursor: 'pointer', opacity: busy === 'complete' ? .7 : 1 }}>
                {/* ONE label at every width. A clock-out variant read well on a phone
                    but wrapped to two lines at 320 px, and the notice above already
                    carries that message — so the button stays a stable target. */}
                {busy === 'complete' ? 'Submitting…' : 'Mark Route Complete'}
              </button>
              <button onClick={() => { setCompleteMode(false); setErr('') }} disabled={busy === 'complete'}
                style={{ padding: '13px 16px', borderRadius: 12, border: '1px solid var(--line)', fontWeight: 700, fontSize: 14.5, color: 'var(--muted)', background: 'transparent', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
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
        <button onClick={() => act('confirm')} disabled={busy !== '' || offline || !agreed}
          style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 15, color: '#fff', cursor: agreed ? 'pointer' : 'not-allowed', background: agreed ? 'var(--red)' : 'rgba(255,255,255,.1)', opacity: busy === 'confirm' ? .7 : 1 }}>
          {busy === 'confirm' ? 'Confirming…' : 'I Confirm I Will Be There'}
        </button>
        {!declineMode ? (
          <button onClick={() => setDeclineMode(true)} disabled={busy !== '' || offline}
            style={{ width: '100%', padding: '15px', borderRadius: 12, border: '1px solid var(--line)', fontWeight: 700, fontSize: 15, color: 'var(--muted)', background: 'transparent', cursor: 'pointer' }}>
            I Cannot Take This Route
          </button>
        ) : (
          <div style={{ padding: 15, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>Can’t make this one?</div>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 11px' }}>Tell dispatch why so they can plan — your response is logged.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {DECLINE_REASONS.map(rz => (
                <button key={rz} type="button" onClick={() => setDeclineReason(rz)}
                  style={{ padding: '7px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${declineReason === rz ? 'var(--red)' : 'var(--line)'}`,
                    background: declineReason === rz ? 'var(--red)' : 'transparent',
                    color: declineReason === rz ? '#fff' : 'var(--muted)' }}>{rz}</button>
              ))}
            </div>
            <textarea value={declineNote} onChange={e => setDeclineNote(e.target.value)} rows={2}
              placeholder="Add a detail (optional) — e.g. free after 10am, out of town Friday…"
              style={{ width: '100%', marginTop: 11, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 13.5, resize: 'vertical', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button onClick={() => act('decline', [declineReason, declineNote.trim()].filter(Boolean).join(' — '))} disabled={busy !== '' || offline || !declineReason}
                style={{ flex: 1, padding: '13px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 14.5, color: '#fff', background: declineReason ? '#b91c1c' : 'rgba(255,255,255,.1)', cursor: declineReason ? 'pointer' : 'not-allowed', opacity: busy === 'decline' ? .7 : 1 }}>
                {busy === 'decline' ? 'Sending…' : 'Send response'}
              </button>
              <button onClick={() => { setDeclineMode(false); setDeclineReason(''); setDeclineNote(''); setErr('') }} disabled={busy !== ''}
                style={{ padding: '13px 16px', borderRadius: 12, border: '1px solid var(--line)', fontWeight: 700, fontSize: 14.5, color: 'var(--muted)', background: 'transparent', cursor: 'pointer' }}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, textAlign: 'center' }}>Questions? Text or call dispatch at {COMPANY.phoneDisplay}.</p>
    </div>
  )
}
