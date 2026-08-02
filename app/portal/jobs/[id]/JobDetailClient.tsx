'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { uploadPresigned } from '@vercel/blob/client'
import { AlertTriangle, ArrowLeft, Camera, Check, Clock, MapPin, WifiOff, X } from 'lucide-react'
import { fmtLongDay, mapsUrl, money } from '../../ui'
import { fetchWithRetry } from '../../network'
import { useConnectivity } from '../../useConnectivity'

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

type PendingCompletion = {
  files: File[]
  urls: Array<string | null>
  requestId: string
  note?: string
}

const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

async function crewCompletionBlobPath(filename: string): Promise<string> {
  const res = await fetch(`/api/portal/upload?filename=${encodeURIComponent(filename)}`, { credentials: 'same-origin' })
  const body = await res.json() as { pathname?: string; error?: string; message?: string }
  if (!res.ok || !body.pathname) throw new Error(body.message ?? body.error ?? 'Unable to prepare photo upload')
  return body.pathname
}

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

const RETRY_SAFE_ACTIONS = new Set(['accept', 'decline', 'clock_in', 'clock_out'])

// One id, shared by the read-only note and the locked picker via aria-describedby,
// so the element that explains the lock is the same element both controls point at.
const PENDING_LOCK_ID = 'completion-pending-lock'

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [networkMsg, setNetworkMsg] = useState('')
  const [note, setNote] = useState('')
  const [pendingPhotoCount, setPendingPhotoCount] = useState(0)
  const [photoRetryReady, setPhotoRetryReady] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingCompletionRef = useRef<PendingCompletion | null>(null)
  const { offline } = useConnectivity()

  const load = useCallback(async () => {
    setErr('')
    try {
      const res = await fetchWithRetry(
        `/api/portal/jobs/${id}`,
        { credentials: 'same-origin' },
        { onRetry: () => setNetworkMsg('Connection is shaky — retrying…') },
      )
      if (res.status === 404) { setGone(true); return }
      if (!res.ok) { setErr('Could not load this job.'); return }
      const d = await res.json()
      setJob(d.job)
      setNetworkMsg('')
    } catch {
      setErr('Could not load this job. Check your connection and try again.')
    }
  }, [id])

  useEffect(() => {
    if (!offline) void load().finally(() => setLoading(false))
  }, [offline, load])

  const act = async (body: Record<string, unknown>, tag: string): Promise<boolean> => {
    if (offline) {
      setErr('You’re offline. Reconnect before saving this action.')
      setNetworkMsg('')
      setBusy('')
      return false
    }
    setBusy(tag); setErr(''); setNetworkMsg('')
    try {
      const res = await fetchWithRetry(
        `/api/portal/jobs/${id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        },
        {
          // Only these four actions are proven idempotent on the server. An explicit
          // allowlist keeps every future mutation single-attempt by default.
          allowMutationRetry:
            typeof body.action === 'string' && RETRY_SAFE_ACTIONS.has(body.action),
          onRetry: () => setNetworkMsg('Connection dropped — retrying this action safely…'),
        },
      )
      const d = await res.json().catch(() => null)
      if (!res.ok) { setErr(d?.message ?? 'That did not work.'); return false }
      await load()
      return true
    } catch {
      setErr('Network error — try again.')
      return false
    } finally {
      setNetworkMsg('')
      setBusy('')
    }
  }

  const punch = async (action: 'clock_in' | 'clock_out') => {
    setBusy(action)
    const pos = await getPosition()
    await act({ action, ...(pos ?? {}), locationDenied: !pos }, action)
  }

  const submitPendingPhotos = async () => {
    const pending = pendingCompletionRef.current
    if (!pending) return
    if (offline) {
      setErr('You’re offline. Your selected photos are kept on this page — reconnect, then retry.')
      setPhotoRetryReady(true)
      return
    }

    setBusy('photos'); setErr('')
    setPhotoRetryReady(false)
    try {
      // Preserve each successful Blob URL immediately. A later failure retries
      // only unfinished files rather than uploading the successful ones again.
      for (let index = 0; index < pending.files.length; index++) {
        if (pending.urls[index]) continue
        const f = pending.files[index]
        const pathname = await crewCompletionBlobPath(f.name)
        const blob = await uploadPresigned(pathname, f, {
          access: 'public',
          handleUploadUrl: '/api/portal/upload',
        })
        pending.urls[index] = blob.url
      }
      const saved = await act({
        action: 'complete',
        photos: pending.urls.filter((url): url is string => !!url),
        note: pending.note,
        requestId: pending.requestId,
      }, 'photos')
      if (saved) {
        pendingCompletionRef.current = null
        setPendingPhotoCount(0)
        setPhotoRetryReady(false)
        setNote('')
        if (fileRef.current) fileRef.current.value = ''
      } else {
        setPhotoRetryReady(true)
      }
    } catch (e) {
      // "Check your signal" is wrong — and wastes the crew member's time — when the
      // deployment simply cannot mint an upload token. The broker returns a stable
      // code for that case; surface it as something only the office can fix.
      const cause = e instanceof Error ? e.message : String(e ?? '')
      setErr(/blob_store_(not_configured|mismatch)/.test(cause)
        ? 'Photo uploads aren’t set up yet. Tell the office — retrying won’t help.'
        : 'Upload paused. Your selected photos are kept on this page — check your signal and retry.')
      setPhotoRetryReady(true)
      setBusy('')
    }
  }

  const sendPhotos = async (files: FileList | null) => {
    if (!files?.length) return
    // The picker is disabled while an attempt is pending; this is the programmatic
    // backstop. Replacing the pending attempt here would orphan Blob URLs that have
    // already uploaded under the current request id, so a stray change event must
    // not start a second attempt. Read the ref, not the render state — the ref is
    // authoritative before React re-renders.
    if (pendingCompletionRef.current) return
    const selected = Array.from(files).slice(0, 10)
    pendingCompletionRef.current = {
      files: selected,
      urls: Array<string | null>(selected.length).fill(null),
      requestId: crypto.randomUUID(),
      note: note.trim() || undefined,
    }
    setPendingPhotoCount(selected.length)
    setPhotoRetryReady(false)
    await submitPendingPhotos()
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
  if (!job) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {offline && (
        <div role="status" className="os-card" style={{ padding: '11px 13px', display: 'flex', gap: 9, alignItems: 'center', color: '#fcd34d', border: '1px solid rgba(245,158,11,.35)' }}>
          <WifiOff size={16} /> <span style={{ fontSize: 13 }}>You’re offline. Reconnect to load this job.</span>
        </div>
      )}
      <p role="alert" style={{ color: '#f87171', fontSize: 14 }}>{err || 'Could not load this job.'}</p>
      <button type="button" onClick={() => void load()} disabled={offline}
        className="os-tap" style={{ minHeight: 44, alignSelf: 'flex-start', padding: '9px 13px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700, opacity: offline ? .55 : 1, cursor: offline ? 'not-allowed' : 'pointer' }}>
        Try again
      </button>
    </div>
  )

  const { me } = job
  const accepted = !!me.confirmedAt && !me.declinedAt
  const actionDisabled = !!busy || offline
  // A pending completion attempt is IMMUTABLE. Its note and its file list were
  // captured with the request id that identifies it, and a retry replays exactly
  // that request. Leaving the note or the picker live would let a crew member make
  // an edit that looks accepted and is then silently dropped when the original
  // request id is replayed, or abandon Blob URLs that already uploaded. The
  // controls come back on success (state is cleared) or on navigation (remount).
  const photosPending = pendingPhotoCount > 0
  const actionBtn = (tone: string): React.CSSProperties => ({
    ...bigBtn(tone),
    opacity: actionDisabled ? .55 : 1,
    cursor: actionDisabled ? 'not-allowed' : 'pointer',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Link href="/portal/jobs" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>
        <ArrowLeft size={15} /> My Jobs
      </Link>

      {offline && (
        <div role="status" className="os-card" style={{ padding: '11px 13px', display: 'flex', gap: 9, alignItems: 'center', color: '#fcd34d', border: '1px solid rgba(245,158,11,.35)' }}>
          <WifiOff size={16} /> <span style={{ fontSize: 13 }}>You’re offline. Job details stay visible, but actions wait until you reconnect.</span>
        </div>
      )}
      {networkMsg && <p role="status" aria-live="polite" style={{ color: '#fcd34d', fontSize: 13 }}>{networkMsg}</p>}

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
          <button type="button" disabled={actionDisabled} onClick={() => act({ action: 'accept' }, 'accept')} style={actionBtn('#34d399')}>
            <Check size={18} /> {busy === 'accept' ? 'Saving…' : "I'm on it"}
          </button>
          <button type="button" disabled={actionDisabled} onClick={() => act({ action: 'decline' }, 'decline')}
            style={{ ...actionBtn('#f87171'), minHeight: 44, fontSize: 13.5 }}>
            <X size={16} /> Can&apos;t make it
          </button>
        </div>
      )}

      {me.declinedAt && (
        <div className="os-card" style={{ padding: 16 }}>
          <p style={{ fontSize: 13.5, color: '#f87171', fontWeight: 700 }}>You declined this job.</p>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>Dispatch has been shown this. Tap below if that was a mistake.</p>
          <button type="button" disabled={actionDisabled} onClick={() => act({ action: 'accept' }, 'accept')}
            style={{ ...actionBtn('#34d399'), minHeight: 44, fontSize: 13.5, marginTop: 10 }}>
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
            <button type="button" disabled={actionDisabled} onClick={() => punch('clock_in')} style={actionBtn('#34d399')}>
              <Clock size={18} /> {busy === 'clock_in' ? 'Clocking in…' : 'Clock in'}
            </button>
          )}
          {me.clockInAt && !me.clockOutAt && (
            <button type="button" disabled={actionDisabled} onClick={() => punch('clock_out')} style={actionBtn('#fcd34d')}>
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

          {/* readOnly, NOT disabled. `disabled` drops the field out of the tab order
              and strips its interactive affordance from the accessibility tree, so a
              screen-reader user would find the note simply gone with no explanation.
              readOnly keeps it focusable, announced, and readable while still
              refusing edits — and the PENDING_LOCK_ID paragraph below says why. */}
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
            readOnly={photosPending}
            aria-describedby={photosPending ? PENDING_LOCK_ID : undefined}
            placeholder="Anything dispatch should know?" aria-label="Note for dispatch"
            style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 10, fontSize: 13.5, color: 'var(--text)', resize: 'vertical', opacity: photosPending ? .55 : 1, cursor: photosPending ? 'not-allowed' : 'auto' }} />

          {/* ALWAYS rendered while an attempt is pending — deliberately not gated on
              `photoRetryReady`, so the lock is explained during the first in-flight
              upload too, not only after a failure. */}
          {photosPending && (
            <p id={PENDING_LOCK_ID} style={{ color: 'var(--muted)', fontSize: 12 }}>
              This note and photo set are locked to the pending upload and will be sent with it.
              Reload the page to start over with a different note or different photos.
            </p>
          )}

          {photoRetryReady && pendingPhotoCount > 0 && (
            <div role="status" style={{ padding: 12, borderRadius: 10, border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.08)' }}>
              <p style={{ color: '#fcd34d', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                {pendingPhotoCount} selected {pendingPhotoCount === 1 ? 'photo is' : 'photos are'} kept on this page.
              </p>
              <button type="button" className="os-tap" onClick={() => void submitPendingPhotos()}
                disabled={actionDisabled}
                style={{ minHeight: 44, width: '100%', borderRadius: 10, border: '1px solid #f59e0b', background: 'rgba(245,158,11,.14)', color: '#fcd34d', fontWeight: 800, opacity: actionDisabled ? .55 : 1, cursor: actionDisabled ? 'not-allowed' : 'pointer' }}>
                {busy === 'photos' ? 'Retrying…' : 'Retry upload'}
              </button>
              {/* The way out of an unrecoverable attempt is named by the always-rendered
                  lock description below the note — which is linked to both controls by
                  aria-describedby — so it is deliberately not repeated here. */}
            </div>
          )}

          {/* `.file-input-a11y` + `.file-label` — the house upload pattern. The input
              is visually hidden but STILL FOCUSABLE and still in the tab order;
              `display:none` (what this was) drops it from the accessibility tree
              entirely, so keyboard and screen-reader users can never open the picker
              (WCAG 2.1.1). `.file-label:focus-within` puts the focus ring on the
              visible label. Same shape as every other upload in the app — see
              app/globals.css and scripts/wizard-a11y.test.ts. */}
          <label className="file-label"
            style={{ ...actionBtn('#60a5fa'), opacity: actionDisabled || photosPending ? .55 : 1, cursor: actionDisabled || photosPending ? 'not-allowed' : 'pointer' }}>
            <Camera size={18} /> {busy === 'photos' ? 'Sending…' : photosPending ? 'Photos waiting to send' : 'Add finished photos'}
            <input ref={fileRef} type="file" accept="image/*" multiple capture="environment"
              aria-label="Add finished photos of this job" className="file-input-a11y"
              disabled={actionDisabled || photosPending}
              aria-describedby={photosPending ? PENDING_LOCK_ID : undefined}
              onChange={e => void sendPhotos(e.target.files)} />
          </label>

          {job.completion.note && (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Last note: {job.completion.note}</p>
          )}
        </div>
      )}

      {err && <p role="alert" style={{ color: '#f87171', fontSize: 13.5 }}>{err}</p>}
    </div>
  )
}

// The BOOKING_ASSIGNMENT_ENABLED gate lives in the server component that renders
// this (./page.tsx), so with the flag off the route 404s before any of this ships.
export default function JobDetailClient() {
  const { id } = useParams<{ id: string }>()
  return <JobDetail id={id} />
}
