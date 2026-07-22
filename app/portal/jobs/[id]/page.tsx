'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { upload } from '@vercel/blob/client'
import { AlertTriangle, ArrowLeft, Camera, Check, Clock, MapPin, X } from 'lucide-react'
import { fmtLongDay, mapsUrl, money } from '../../ui'

// One booking job, from the crew member's phone: accept it, clock in and out, and
// send completion photos from the driveway.
//
// Everything here is scoped server-side to the caller's own assignment — this
// screen 404s for a crew member who isn't on the job, and the whole route 404s
// when BOOKING_ASSIGNMENT_ENABLED is off.

type Job = {
  id: string
  number: string
  title: string
  serviceLabel: string
  address: string | null
  date: string
  timeLabel: string | null
  statusLabel: string
  description: string | null
  notes: string | null
  items: string[]
  vehicle: string | null
  me: {
    role: string | null
    payCents: number | null
    confirmedAt: number | null
    declinedAt: number | null
    clockInAt: number | null
    clockOutAt: number | null
  }
  crew: { name: string; role: string | null }[]
  completion: { completedAt: number | null; note: string | null; photos: string[] }
}

const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

// Ask the phone where it is. Best-effort by design: no geolocation, a denied
// prompt, or a timeout all resolve to null rather than reject — a location prompt
// must never block a shift. The server records `locationDenied` and saves the time.
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

const bigBtn = (tone: string): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  width: '100%', minHeight: 52, borderRadius: 12, fontSize: 15, fontWeight: 800,
  border: `1px solid ${tone}`, background: `${tone}1a`, color: tone, cursor: 'pointer',
})

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/portal/jobs/${id}`, { credentials: 'same-origin' })
    if (res.status === 404) { setGone(true); return }
    if (!res.ok) { setErr('Could not load this job.'); return }
    const d = await res.json()
    setJob(d.job)
  }, [id])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])

  const act = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setErr('')
    try {
      const res = await fetch(`/api/portal/jobs/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) { setErr(d?.message ?? 'That did not work.'); return }
      await load()
    } catch {
      setErr('Network error — try again.')
    } finally {
      setBusy('')
    }
  }

  const punch = async (action: 'clock_in' | 'clock_out') => {
    setBusy(action)
    const pos = await getPosition()
    await act({ action, ...(pos ?? {}), locationDenied: !pos }, action)
  }

  const sendPhotos = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy('photos'); setErr('')
    try {
      const urls: string[] = []
      for (const f of Array.from(files).slice(0, 10)) {
        const blob = await upload(f.name, f, {
          access: 'public',
          handleUploadUrl: '/api/portal/upload',
        })
        urls.push(blob.url)
      }
      await act({ action: 'complete', photos: urls, note: note || undefined }, 'photos')
      setNote('')
    } catch {
      setErr('Upload failed — check your signal and try again.')
      setBusy('')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  if (loading) return <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>
  if (gone) return (
    <div className="os-card" style={{ padding: 20 }}>
      <p style={{ fontSize: 15, fontWeight: 700 }}>Job not found</p>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 6 }}>
        It may have been reassigned. Check My Jobs, or contact dispatch.
      </p>
      <Link href="/portal/jobs" style={{ color: 'var(--red)', fontSize: 13.5, fontWeight: 700, marginTop: 10, display: 'inline-block' }}>
        Back to My Jobs
      </Link>
    </div>
  )
  if (!job) return <p role="alert" style={{ color: '#f87171', fontSize: 14 }}>{err || 'Could not load this job.'}</p>

  const { me } = job
  const accepted = !!me.confirmedAt && !me.declinedAt

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Link href="/portal/jobs" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>
        <ArrowLeft size={15} /> My Jobs
      </Link>

      <div>
        <h1 className="jkos-h" style={{ fontSize: 23 }}>{job.title}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 4 }}>
          {job.serviceLabel} · {job.number}
          {me.role ? ` · ${me.role}` : ''}
        </p>
      </div>

      {/* ── When & where ── */}
      <div className="os-card" style={{ padding: 16 }}>
        <p style={{ fontSize: 15, fontWeight: 700 }}>{job.date ? fmtLongDay(job.date) : 'Date to be scheduled'}</p>
        {job.timeLabel && <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 2 }}>{job.timeLabel}</p>}
        {job.address && (
          <a href={mapsUrl(job.address)} target="_blank" rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--red)', fontSize: 13.5, fontWeight: 600, marginTop: 10, textDecoration: 'none' }}>
            <MapPin size={14} /> {job.address}
          </a>
        )}
        {job.vehicle && <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>Vehicle: {job.vehicle}</p>}
        {typeof me.payCents === 'number' && <p style={{ fontSize: 13.5, fontWeight: 700, marginTop: 8 }}>Your pay: {money(me.payCents)}</p>}
        {job.crew.length > 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>
            With {job.crew.map(c => c.name).join(', ')}
          </p>
        )}
      </div>

      {/* ── The job ── */}
      {(job.description || job.notes || job.items.length > 0) && (
        <div className="os-card" style={{ padding: 16 }}>
          {job.description && <p style={{ fontSize: 13.5, lineHeight: 1.55 }}>{job.description}</p>}
          {job.items.length > 0 && (
            <ul style={{ marginTop: job.description ? 10 : 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6 }}>
              {job.items.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          )}
          {job.notes && (
            <p style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 10, color: '#fcd34d' }}>
              <AlertTriangle size={13} style={{ display: 'inline', verticalAlign: -2, marginRight: 5 }} />
              {job.notes}
            </p>
          )}
        </div>
      )}

      {/* ── Accept / decline ── */}
      {!accepted && !me.declinedAt && (
        <div className="os-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13.5, color: 'var(--muted)' }}>Can you take this job?</p>
          <button type="button" disabled={!!busy} onClick={() => act({ action: 'accept' }, 'accept')} style={bigBtn('#34d399')}>
            <Check size={18} /> {busy === 'accept' ? 'Saving…' : "I'm on it"}
          </button>
          <button type="button" disabled={!!busy} onClick={() => act({ action: 'decline' }, 'decline')}
            style={{ ...bigBtn('#f87171'), minHeight: 44, fontSize: 13.5 }}>
            <X size={16} /> Can&apos;t make it
          </button>
        </div>
      )}

      {me.declinedAt && (
        <div className="os-card" style={{ padding: 16 }}>
          <p style={{ fontSize: 13.5, color: '#f87171', fontWeight: 700 }}>You declined this job.</p>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>Dispatch has been shown this. Tap below if that was a mistake.</p>
          <button type="button" disabled={!!busy} onClick={() => act({ action: 'accept' }, 'accept')}
            style={{ ...bigBtn('#34d399'), minHeight: 44, fontSize: 13.5, marginTop: 10 }}>
            <Check size={16} /> Actually, I can make it
          </button>
        </div>
      )}

      {/* ── Timeclock ── */}
      {accepted && (
        <div className="os-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>Timeclock</p>
          {me.clockInAt && (
            <p style={{ fontSize: 13.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Clock size={14} /> In at {fmtClock(me.clockInAt)}
              {me.clockOutAt && <> · out at {fmtClock(me.clockOutAt)}</>}
            </p>
          )}
          {!me.clockInAt && (
            <button type="button" disabled={!!busy} onClick={() => punch('clock_in')} style={bigBtn('#34d399')}>
              <Clock size={18} /> {busy === 'clock_in' ? 'Clocking in…' : 'Clock in'}
            </button>
          )}
          {me.clockInAt && !me.clockOutAt && (
            <button type="button" disabled={!!busy} onClick={() => punch('clock_out')} style={bigBtn('#fcd34d')}>
              <Clock size={18} /> {busy === 'clock_out' ? 'Clocking out…' : 'Clock out'}
            </button>
          )}
        </div>
      )}

      {/* ── Completion proof ── */}
      {accepted && (
        <div className="os-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>
            Finished photos {job.completion.photos.length > 0 && `· ${job.completion.photos.length}`}
          </p>

          {job.completion.photos.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(74px, 1fr))', gap: 8 }}>
              {job.completion.photos.map((u, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={u} alt={`Completion photo ${i + 1}`}
                  style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
              ))}
            </div>
          )}

          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
            placeholder="Anything dispatch should know?" aria-label="Note for dispatch"
            style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 10, fontSize: 13.5, color: 'var(--text)', resize: 'vertical' }} />

          <input ref={fileRef} type="file" accept="image/*" multiple capture="environment"
            onChange={e => sendPhotos(e.target.files)} style={{ display: 'none' }} id="job-photos" />
          <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()} style={bigBtn('#60a5fa')}>
            <Camera size={18} /> {busy === 'photos' ? 'Sending…' : 'Add finished photos'}
          </button>

          {job.completion.note && (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Last note: {job.completion.note}</p>
          )}
        </div>
      )}

      {err && <p role="alert" style={{ color: '#f87171', fontSize: 13.5 }}>{err}</p>}
    </div>
  )
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>()
  return <JobDetail id={id} />
}
