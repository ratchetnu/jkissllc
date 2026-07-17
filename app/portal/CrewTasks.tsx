'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Camera, CheckCircle2, AlertTriangle, Radio, Clock3 } from 'lucide-react'

// The crew dashboard tasks feed (request Part 8): today's tasks, urgent dispatch
// alerts, reminders, and one-tap acknowledgement — plus the daily uniform-photo
// upload that clears the uniform reminder. Everything is one tap.

type Task = {
  id: string; token: string; title: string; message: string; templateId: string
  origin: string; requireAck: boolean; ackOptions: string[]
  ackKind: string | null; completedAt: number | null; sentAt: number
}
type Feed = {
  unread: number
  status: { confirmed: boolean | null; clockIn: string; clockOut: boolean; uniform: boolean; availabilitySubmitted: boolean; onTimeOff: boolean; hasActiveRouteToday: boolean } | null
  tasks: Task[]
  counts: { incomplete: number; completed: number; urgent: number }
}

const ACK_LABEL: Record<string, string> = {
  acknowledged: 'Acknowledged', completed: 'Completed', calling: 'Calling Now', need_help: 'Need Help',
  already_done: 'Already Done', having_issues: 'Having Issues', unable: 'Unable',
}
const ACK_BG: Record<string, string> = {
  completed: '#16a34a', already_done: '#16a34a', acknowledged: '#2563eb', calling: '#E0002A',
  need_help: '#f59e0b', having_issues: '#f59e0b', unable: '#6b7280',
}
const ACK_FG: Record<string, string> = { need_help: '#111', having_issues: '#111' }

type UniformInfo = { uploaded: boolean; status: 'submitted' | 'approved' | 'rejected' | null; at: number | null; reviewNote: string | null }
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

export default function CrewTasks() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [uniform, setUniform] = useState<UniformInfo | null>(null)
  const [busy, setBusy] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const load = useCallback(async () => {
    try { const r = await fetch('/api/portal/tasks', { credentials: 'same-origin' }); if (r.ok) setFeed(await r.json()) } catch { /* ignore */ }
  }, [])
  // Kept as a .then chain (not await) so setUniform runs in an async callback, not
  // synchronously in the effect body.
  const loadUniform = useCallback(() => {
    fetch('/api/portal/uniform', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setUniform({ uploaded: !!d.uploaded, status: d.status ?? null, at: d.at ?? null, reviewNote: d.reviewNote ?? null }))
      .catch(() => setUniform({ uploaded: false, status: null, at: null, reviewNote: null }))
  }, [])
  useEffect(() => { load(); loadUniform() }, [load, loadUniform])

  async function ack(t: Task, kind: string) {
    setBusy(t.id)
    try { await fetch('/api/portal/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ instanceId: t.id, kind }) }); await load() }
    finally { setBusy('') }
  }

  async function uploadUniform(file: File) {
    setUploading(true)
    try {
      const dataUrl = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(file) })
      const r = await fetch('/api/portal/uniform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ image: dataUrl }) })
      if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'Upload failed'); return }
      await Promise.all([load(), Promise.resolve(loadUniform())])
    } finally { setUploading(false) }
  }

  if (!feed) return null
  const { status, tasks, counts } = feed
  const pending = tasks.filter(t => t.requireAck && !t.ackKind)
  const urgent = pending.filter(t => t.origin === 'dispatch')
  const normal = pending.filter(t => t.origin !== 'dispatch')
  const done = tasks.filter(t => t.ackKind || t.completedAt)

  // Uniform state (from the dedicated fetch): only relevant on a working day.
  const uniformDay = !!status?.hasActiveRouteToday && !status?.onTimeOff
  const uStatus: 'loading' | 'none' | 'submitted' | 'approved' | 'rejected' =
    !uniform ? 'loading' : !uniform.uploaded ? 'none' : (uniform.status ?? 'submitted')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Urgent alerts */}
      {urgent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {urgent.map(t => (
            <div key={t.id} className="os-card os-rise" style={{ padding: 16, border: '1px solid rgba(224,0,42,.4)', background: 'linear-gradient(135deg, rgba(224,0,42,.14), transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Radio size={16} style={{ color: '#fca5a5' }} />
                <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: '#fca5a5' }}>Urgent · Dispatch</span>
              </div>
              <p style={{ fontWeight: 800, fontSize: 16 }}>{t.title}</p>
              <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 3 }}>{t.message}</p>
              <AckRow t={t} busy={busy} onAck={ack} />
            </div>
          ))}
        </div>
      )}

      {/* Uniform photo — upload, awaiting review, rejected→resubmit. Approved shows
          only as the status chip below. */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={e => { const f = e.target.files?.[0]; if (f) uploadUniform(f) }} />
      {uniformDay && uStatus === 'none' && (
        <div className="os-card os-rise" style={{ padding: 16, border: '1px solid rgba(245,158,11,.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(245,158,11,.15)', color: '#fcd34d', flexShrink: 0 }}><Camera size={20} /></div>
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 800, fontSize: 15 }}>Upload today&apos;s uniform photo</p>
              <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Before you begin your route.</p>
            </div>
          </div>
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="cc-action os-tap" style={{ width: '100%', marginTop: 12, background: '#f59e0b', color: '#111' }}>
            <Camera size={17} /> {uploading ? 'Uploading…' : 'Take / choose photo'}
          </button>
        </div>
      )}
      {uniformDay && uStatus === 'rejected' && (
        <div className="os-card os-rise" style={{ padding: 16, border: '1px solid rgba(248,113,113,.4)', background: 'linear-gradient(135deg, rgba(248,113,113,.12), transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(248,113,113,.16)', color: '#fca5a5', flexShrink: 0 }}><AlertTriangle size={20} /></div>
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 800, fontSize: 15 }}>Please resubmit your uniform photo</p>
              {uniform?.reviewNote && <p style={{ fontSize: 12.5, color: '#fca5a5', marginTop: 2 }}>{uniform.reviewNote}</p>}
            </div>
          </div>
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="cc-action os-tap" style={{ width: '100%', marginTop: 12, background: '#E0002A', color: '#fff' }}>
            <Camera size={17} /> {uploading ? 'Uploading…' : 'Retake photo'}
          </button>
        </div>
      )}
      {uniformDay && uStatus === 'submitted' && (
        <div className="os-card" style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 11 }}>
          <Clock3 size={17} style={{ color: '#fcd34d', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 13.5, fontWeight: 700 }}>Uniform photo submitted{uniform?.at ? ` · ${fmtTime(uniform.at)}` : ''}</p>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>Awaiting review.</p>
          </div>
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 9, padding: '6px 11px', cursor: 'pointer' }}>
            {uploading ? '…' : 'Replace'}
          </button>
        </div>
      )}

      {/* Today's status chips */}
      {status?.hasActiveRouteToday && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip ok={status.confirmed === true} label={status.confirmed ? 'Route confirmed' : 'Confirm route'} />
          <Chip ok={status.clockIn === 'in' || status.clockIn === 'out'} label={status.clockIn === 'out' ? 'Clocked out' : status.clockIn === 'in' ? 'Clocked in' : 'Clock in'} />
          <Chip
            ok={uStatus === 'approved'}
            warn={uStatus === 'rejected'}
            label={uStatus === 'approved' ? 'Uniform ✓' : uStatus === 'rejected' ? 'Uniform — redo' : uStatus === 'submitted' ? 'Uniform — pending' : 'Uniform'}
          />
        </div>
      )}

      {/* Today's tasks */}
      {(normal.length > 0 || done.length > 0) && (
        <div className="os-card os-rise" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Bell size={16} style={{ color: 'var(--muted)' }} />
            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: 'var(--muted)' }}>Today&apos;s tasks</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>{counts.completed} done · {counts.incomplete} left</span>
          </div>
          {normal.length === 0 && done.length > 0 && (
            <div style={{ textAlign: 'center', padding: '10px 0' }}><CheckCircle2 size={26} style={{ color: '#86efac' }} /><p style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>All caught up</p></div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {normal.map(t => (
              <div key={t.id} style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
                <p style={{ fontWeight: 700, fontSize: 15 }}>{t.title}</p>
                <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 2 }}>{t.message}</p>
                <AckRow t={t} busy={busy} onAck={ack} />
              </div>
            ))}
            {done.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: .6 }}>
                <CheckCircle2 size={16} style={{ color: '#86efac', flexShrink: 0 }} />
                <span style={{ fontSize: 14, textDecoration: 'line-through' }}>{t.title}</span>
                {t.ackKind && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>{ACK_LABEL[t.ackKind] || t.ackKind}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AckRow({ t, busy, onAck }: { t: Task; busy: string; onAck: (t: Task, kind: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      {t.ackOptions.map(k => (
        <button key={k} onClick={() => onAck(t, k)} disabled={!!busy} className="cc-action os-tap"
          style={{ flex: '1 1 auto', minWidth: 120, padding: '0 16px', background: ACK_BG[k] || '#2a2a2e', color: ACK_FG[k] || '#fff', opacity: busy === t.id ? .6 : 1 }}>
          {busy === t.id ? '…' : (ACK_LABEL[k] || k)}
        </button>
      ))}
    </div>
  )
}

function Chip({ ok, label, warn = false }: { ok: boolean; label: string; warn?: boolean }) {
  const border = ok ? 'rgba(34,197,94,.4)' : warn ? 'rgba(248,113,113,.45)' : 'var(--line)'
  const bg = ok ? 'rgba(34,197,94,.12)' : warn ? 'rgba(248,113,113,.12)' : 'transparent'
  const fg = ok ? '#86efac' : warn ? '#fca5a5' : 'var(--muted)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, border: `1px solid ${border}`, background: bg, color: fg }}>
      {ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {label}
    </span>
  )
}
