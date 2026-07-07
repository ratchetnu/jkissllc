'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MapPin, Clock, CalendarDays, Truck, DollarSign, User, Phone, FileText, ChevronLeft, Send, CheckCircle2, XCircle, Link2, Sparkles } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { statusOf, Avatar, scoreColor, fmtLongDay, fmtTs, mapsUrl } from '../ui'

type Audit = { at: number; actor: string; action: string }
type Event = { at: number; type: string }
type Op = {
  token: string; routeNumber: string; status: string
  businessName: string; reportAddress: string; reportTime: string; routeDate: string
  vehicle?: string; payRate?: string; description?: string; specialNotes?: string; contactPerson?: string; contactPhone?: string
  assignedStaffId?: string; assignedStaffName?: string; smsStatus?: string; smsError?: string
  linkOpenedAt?: number; confirmedAt?: number; declinedAt?: number; declineReason?: string
  completedAt?: number; completionNote?: string; completionPhotos?: string[]
  audit?: Audit[]; events?: Event[]
}
type Staff = { id: string; name: string; phone?: string; active: boolean }
type Stats = Record<string, { score: number | null }>

function Detail({ token }: { token: string }) {
  const router = useRouter()
  const [op, setOp] = useState<Op | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [stats, setStats] = useState<Stats>({})
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      const found = (r.items || []).find((x: Op) => x.token === token)
      if (!found) setNotFound(true); else setOp(found)
      setStats(r.stats || {}); setStaff((s.items || []).filter((x: Staff) => x.active))
    } catch { setNotFound(true) } finally { setLoading(false) }
  }, [token])
  useEffect(() => { load() }, [load])

  async function patch(body: Record<string, unknown>, tag: string) {
    setBusy(tag); setMsg('')
    try {
      const res = await fetch(`/api/admin/routes/${token}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      const d = await res.json()
      if (!res.ok) setMsg(d.error || 'Action failed.')
      else if (d.smsWarning) setMsg(`Text not sent: ${d.smsWarning}`)
      setReassigning(false); await load()
    } catch { setMsg('Network error.') } finally { setBusy('') }
  }

  const timeline = useMemo(() => {
    if (!op) return []
    const items: { at: number; text: string }[] = [
      ...(op.audit || []).map(a => ({ at: a.at, text: a.action })),
      ...(op.events || []).filter(e => e.type === 'link_opened').map(e => ({ at: e.at, text: 'Opened the confirmation link' })),
    ]
    return items.sort((a, b) => a.at - b.at)
  }, [op])

  if (loading) return <div className="os-card" style={{ padding: 22 }}><div className="skeleton" style={{ width: '50%', height: 20, borderRadius: 8 }} /><div className="skeleton" style={{ width: '80%', height: 13, borderRadius: 6, marginTop: 12 }} /></div>
  if (notFound || !op) return (
    <div className="os-card" style={{ padding: 26, textAlign: 'center' }}>
      <p className="jkos-h" style={{ fontSize: 18 }}>Operation not found</p>
      <Link href="/admin/operations" className="btn os-tap" style={{ borderRadius: 999, marginTop: 16, display: 'inline-flex' }}>Back to Operations</Link>
    </div>
  )
  const chip = statusOf(op.status)
  const canComplete = op.status === 'confirmed'
  const live = !['completed', 'cancelled'].includes(op.status)

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <button onClick={() => router.back()} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', marginBottom: 14 }}><ChevronLeft size={16} /> Operations</button>

      {msg && <div className="os-card" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 13.5, color: '#fcd34d' }}>{msg}</div>}

      {/* Header */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 10px', borderRadius: 99, background: chip.bg, color: chip.fg }}>{chip.label}</span>
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{op.routeNumber}</span>
        </div>
        <h1 className="jkos-h" style={{ fontSize: 26, marginTop: 10 }}>{op.businessName}</h1>
        <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 14, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarDays size={15} /> {fmtLongDay(op.routeDate)}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={15} /> {op.reportTime}</span>
        </div>

        {/* Availability response */}
        {op.confirmedAt && <p style={{ fontSize: 13, color: '#86efac', marginTop: 10 }}>✓ Confirmed available · {fmtTs(op.confirmedAt)}</p>}
        {op.declinedAt && <p style={{ fontSize: 13, color: '#fca5a5', marginTop: 10 }}>✗ Not available{op.declineReason ? ` — ${op.declineReason}` : ''} · {fmtTs(op.declinedAt)}</p>}
      </div>

      {/* Details */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row Icon={MapPin} label="Report to" val={op.reportAddress} href={mapsUrl(op.reportAddress)} />
        <Row Icon={Truck} label="Equipment" val={op.vehicle || 'Box truck'} />
        {op.payRate && <Row Icon={DollarSign} label="Pay" val={op.payRate} />}
        {op.contactPerson && <Row Icon={User} label="On-site contact" val={`${op.contactPerson}${op.contactPhone ? ` · ${op.contactPhone}` : ''}`} />}
        {(op.description || op.specialNotes) && <Row Icon={FileText} label="Instructions" val={[op.description, op.specialNotes].filter(Boolean).join(' · ')} />}
      </div>

      {/* Assigned + reassign */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>Assigned to</div>
          {live && <button onClick={() => setReassigning(r => !r)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>{op.assignedStaffId ? 'Reassign' : 'Assign'}</button>}
        </div>
        {op.assignedStaffName
          ? <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 10 }}>
              <Avatar name={op.assignedStaffName} />
              <div><div style={{ fontWeight: 700, fontSize: 15.5 }}>{op.assignedStaffName}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{op.smsStatus === 'failed' ? <span style={{ color: '#f87171' }}>text failed</span> : op.smsStatus === 'no_phone' ? <span style={{ color: '#f87171' }}>no phone on file</span> : 'confirmation text sent'}</div></div>
            </div>
          : <p style={{ marginTop: 10, color: '#fcd34d', fontWeight: 600, fontSize: 14 }}>Unassigned</p>}

        {reassigning && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {staff.map(s => (
              <button key={s.id} onClick={() => patch({ action: 'assign', staffId: s.id }, 'assign')} disabled={busy !== ''} className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 11, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                <Avatar name={s.name} size={38} />
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14.5 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Reliability <b style={{ color: scoreColor(stats[s.id]?.score) }}>{stats[s.id]?.score ?? 'new'}</b>{!s.phone && <span style={{ color: '#fca5a5' }}> · no phone</span>}</div></div>
                <Send size={15} style={{ color: 'var(--muted)' }} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Activity timeline */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 14 }}>Activity</div>
        <div style={{ position: 'relative', paddingLeft: 20 }}>
          <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 2, background: 'var(--line)' }} />
          {timeline.map((t, i) => (
            <div key={i} style={{ position: 'relative', paddingBottom: i === timeline.length - 1 ? 0 : 16 }}>
              <div style={{ position: 'absolute', left: -20, top: 3, width: 10, height: 10, borderRadius: 99, background: i === timeline.length - 1 ? 'var(--red)' : 'var(--muted)', border: '2px solid var(--bg)' }} />
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t.text}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtTs(t.at)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      {live && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {op.assignedStaffId && <button onClick={() => patch({ action: 'resend' }, 'resend')} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}><Send size={15} /> Resend text</button>}
          {canComplete && <button onClick={() => patch({ action: 'status', status: 'completed' }, 'complete')} disabled={busy !== ''} className="btn os-tap" style={{ borderRadius: 11, height: 40, background: '#16a34a' }}><CheckCircle2 size={16} /> Mark complete</button>}
          <button onClick={() => { if (op.assignedStaffId) { navigator.clipboard?.writeText(`${location.origin}/route/${op.token}`); setMsg('Confirmation link copied.') } }} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}><Link2 size={15} /> Copy link</button>
          {op.status === 'confirmed' && <button onClick={() => patch({ action: 'status', status: 'no_show' }, 'noshow')} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40, color: '#fca5a5' }}>No-show</button>}
          <button onClick={() => { if (confirm('Cancel this operation?')) patch({ action: 'status', status: 'cancelled' }, 'cancel') }} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40, color: '#f87171', marginLeft: 'auto' }}><XCircle size={15} /> Cancel</button>
        </div>
      )}
    </div>
  )
}

function Row({ Icon, label, val, href }: { Icon: typeof MapPin; label: string; val: string; href?: string }) {
  return (
    <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
      <Icon size={16} style={{ color: 'var(--red-glow)', flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--muted)' }}>{label}</div>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{val}</div>
        {href && <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Open in Maps →</a>}
      </div>
    </div>
  )
}

export default function OperationDetailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  return <OperationsShell><Detail token={token} /></OperationsShell>
}
