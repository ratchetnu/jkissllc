'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MapPin, Clock, CalendarDays, Truck, User, FileText, ChevronLeft, Send, CheckCircle2, XCircle, Link2, Plus, X, Lock, ShieldAlert } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { invalidateOps } from '../useOps'
import { statusOf, Avatar, scoreColor, fmtLongDay, fmtTs, mapsUrl, money, moneyOrDash, profitColor, MoneyInput, centsToInput, looksLikeMoney, osLabel, ClaimChip } from '../ui'
import NewClaim from '../claims/NewClaim'
import { useClaims } from '../claims/useClaims'

type Audit = { at: number; actor: string; action: string }
type Event = { at: number; type: string }
type Assignee = {
  staffId: string; name: string; phone?: string; role?: string; pay?: string; token: string
  payCents?: number; paySource?: 'crew_business' | 'crew_default' | 'manual'
  smsStatus?: string; smsSentAt?: number; confirmedAt?: number; declinedAt?: number; declineReason?: string
  confirmedVia?: 'link' | 'verbal'; verbalNote?: string
  clockInAt?: number; clockInLat?: number; clockInLng?: number; clockInAccuracy?: number; clockInLocationDenied?: boolean
  clockOutAt?: number; clockOutLat?: number; clockOutLng?: number; clockOutAccuracy?: number; clockOutLocationDenied?: boolean
}
type Financials = { businessPriceCents?: number; priceSource: 'contract' | 'manual' | 'none'; snapshotAt: number }
type Op = {
  token: string; routeNumber: string; status: string
  businessName: string; reportAddress: string; reportTime: string; routeDate: string
  vehicle?: string; payRate?: string; description?: string; specialNotes?: string; contactPerson?: string; contactPhone?: string
  requiresHelper?: boolean
  assignees?: Assignee[]
  financials?: Financials
  completedAt?: number; completionNote?: string; completionPhotos?: string[]
  audit?: Audit[]; events?: Event[]
}
type Staff = { id: string; name: string; phone?: string; role?: string; active: boolean }
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
  const [addPay, setAddPay] = useState('')
  const [msg, setMsg] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // Confirm the action actually happened — the high-frequency buttons (send, assign,
  // complete…) used to give zero feedback on success, so the owner couldn't tell a
  // tap landed and would re-send. Green banner, auto-clears.
  function flashOk(text: string) {
    setOkMsg(text)
    window.setTimeout(() => setOkMsg(m => (m === text ? '' : m)), 2600)
  }
  const [claiming, setClaiming] = useState(false)
  const { claims } = useClaims()
  const routeClaims = useMemo(() => claims.filter(c => c.routeToken === token), [claims, token])

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

  // A 409 with `warning` means the server refused to save silently — crew pay
  // exceeds what the route earns. Ask, then retry with the acknowledgement.
  async function patch(body: Record<string, unknown>, tag: string) {
    setBusy(tag); setMsg(''); setOkMsg('')
    try {
      const send = (b: Record<string, unknown>) =>
        fetch(`/api/admin/routes/${token}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) })

      let res = await send(body)
      let d = await res.json()

      if (res.status === 409 && d.warning === 'pay_exceeds_price') {
        if (!confirm(d.message)) { setBusy(''); return }
        res = await send({ ...body, acknowledgeWarning: true })
        d = await res.json()
      }

      if (!res.ok) setMsg(d.error || 'Action failed.')
      else if (d.smsWarning) setMsg(`Text not sent: ${d.smsWarning}`)
      else flashOk(okFor(String(body.action ?? '')))
      if (res.ok) invalidateOps() // Home/List show fresh state on return
      setReassigning(false); await load()
    } catch { setMsg('Network error.') } finally { setBusy('') }
  }

  // Friendly success line per action, so the green flash names what happened.
  function okFor(action: string): string {
    switch (action) {
      case 'send': return 'Text sent to the crew.'
      case 'resend': return 'Text re-sent.'
      case 'assign': return 'Crew member added.'
      case 'unassign': return 'Crew member removed.'
      case 'confirm': return 'Marked confirmed.'
      case 'unconfirm': return 'Confirmation undone.'
      case 'money': return 'Saved.'
      case 'status': return 'Status updated.'
      default: return 'Done.'
    }
  }

  // They said yes in person or on the phone. The prompt doubles as a mis-tap guard;
  // cancelling it records nothing.
  async function confirmVerbally(a: Assignee) {
    const note = prompt(`Mark ${a.name} as confirmed?\n\nUse this when they told you directly that they're taking this route. Optional note (e.g. "called at 6am"):`, '')
    if (note === null) return
    await patch({ action: 'confirm', staffId: a.staffId, note: note.trim() || undefined }, `ok-${a.staffId}`)
  }

  // Mark the whole route confirmed in one tap — confirms every assigned crew member
  // who hasn't already confirmed or declined. Recorded as a verbal confirmation
  // (owner's word), never a forged disclaimer signature. One prompt, one note, one
  // reload — not a per-person hunt.
  async function confirmRoute() {
    const pending = (op?.assignees ?? []).filter(a => !a.confirmedAt && !a.declinedAt)
    if (!pending.length) return
    const who = pending.length === 1 ? pending[0].name : `all ${pending.length} crew`
    const note = prompt(`Mark ${who} confirmed for this route?\n\nUse this when they told you directly they're taking it. Optional note (e.g. "confirmed by phone"):`, '')
    if (note === null) return
    setBusy('confirmroute'); setMsg('')
    // Sequential so the server rolls up route status cleanly after each. One crew
    // failing must NOT skip the rest — confirm everyone we can, then report.
    let failed = 0
    for (const a of pending) {
      try {
        const res = await fetch(`/api/admin/routes/${token}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'confirm', staffId: a.staffId, note: note.trim() || undefined }) })
        if (!res.ok) failed++
      } catch { failed++ }
    }
    invalidateOps() // Home/List show fresh state on return
    await load()
    if (failed) setMsg(`Confirmed ${pending.length - failed} of ${pending.length}. Try the rest from each crew member's ✓.`)
    else flashOk(pending.length === 1 ? 'Route confirmed.' : `All ${pending.length} crew confirmed.`)
    setBusy('')
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
      {okMsg && <div className="os-card os-rise" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 13.5, color: '#86efac', border: '1px solid rgba(34,197,94,.3)' }}>✓ {okMsg}</div>}

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
      </div>

      {/* Details */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row Icon={MapPin} label="Report to" val={op.reportAddress} href={mapsUrl(op.reportAddress)} />
        <Row Icon={Truck} label="Equipment" val={op.vehicle || 'Box truck'} />
        {op.contactPerson && <Row Icon={User} label="On-site contact" val={`${op.contactPerson}${op.contactPhone ? ` · ${op.contactPhone}` : ''}`} />}
        {(op.description || op.specialNotes) && <Row Icon={FileText} label="Instructions" val={[op.description, op.specialNotes].filter(Boolean).join(' · ')} />}
      </div>

      {/* Money — admin only */}
      <RouteMoney op={op} onPatch={patch} busy={busy} />

      {/* Crew */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>Crew</div>
          {live && <button onClick={() => setReassigning(r => !r)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>{reassigning ? 'Done' : '+ Add crew'}</button>}
        </div>

        {(() => {
          if (!op.requiresHelper) return null
          const roles = (op.assignees ?? []).map(a => (a.role || '').toLowerCase())
          // Two drivers = a driver + a helper: a spare driver fills the helper seat.
          const drivers = roles.filter(x => x.includes('driver')).length
          const hasHelper = roles.some(x => x.includes('helper'))
          const miss = [drivers === 0 && 'a driver', (!hasHelper && drivers < 2) && 'a helper'].filter(Boolean)
          return miss.length ? <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(196,181,253,.1)', border: '1px solid rgba(196,181,253,.3)', color: '#c4b5fd', fontSize: 13, fontWeight: 600 }}>This client needs a driver + helper — still missing {miss.join(' and ')}.</div> : null
        })()}

        {(op.assignees ?? []).length === 0 && !reassigning && <p style={{ marginTop: 10, color: '#fcd34d', fontWeight: 600, fontSize: 14 }}>No crew assigned yet</p>}

        {(op.assignees ?? []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {(op.assignees ?? []).map(a => {
              // A verbal confirm is shown as such — it's the owner's word, not the
              // contractor's signed acceptance, and the difference matters later.
              const st = a.confirmedAt
                ? { t: a.confirmedVia === 'verbal' ? `✓ Confirmed by phone${a.verbalNote ? ` — ${a.verbalNote}` : ''}` : '✓ Confirmed', c: '#86efac' }
                : a.declinedAt ? { t: `✗ Not available${a.declineReason ? ` — ${a.declineReason}` : ''}`, c: '#fca5a5' } : a.smsStatus === 'failed' ? { t: 'text failed', c: '#f87171' } : a.smsSentAt ? 'texted · awaiting reply' : 'not texted yet'
              const stt = typeof st === 'string' ? { t: st, c: 'var(--muted)' } : st
              return (
                <div key={a.staffId} style={{ padding: 11, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                  <Avatar name={a.name} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Truncate rather than wrap, so a long name + role + pay can't push
                        into the action icons or grow the card on a narrow phone. */}
                    <div style={{ fontWeight: 700, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}{a.role ? <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 12 }}> · {a.role}</span> : null}{a.payCents != null ? <span className="tabular-nums" style={{ color: '#86efac', fontSize: 12, fontWeight: 700 }}> · {money(a.payCents)}</span> : null}</div>
                    <div style={{ fontSize: 12, color: stt.c, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stt.t}</div>
                  </div>
                  {live && (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {/* Talked to them? Record it. Undo only what the owner recorded —
                          a link confirmation is the contractor's own and stays put. */}
                      {!a.confirmedAt && (
                        <button onClick={() => confirmVerbally(a)} disabled={busy !== ''} title={`${a.name} told you they're taking it`} className="os-tap" style={{ ...iconBtn, color: '#86efac' }}><CheckCircle2 size={14} /></button>
                      )}
                      {a.confirmedAt && a.confirmedVia === 'verbal' && (
                        <button onClick={() => patch({ action: 'unconfirm', staffId: a.staffId }, `nook-${a.staffId}`)} disabled={busy !== ''} title="Undo verbal confirmation" className="os-tap" style={{ ...iconBtn, color: '#fcd34d' }}><XCircle size={14} /></button>
                      )}
                      <button onClick={() => { navigator.clipboard?.writeText(`${location.origin}/route/${a.token}`); setMsg(`${a.name}'s link copied.`) }} title="Copy link" className="os-tap" style={iconBtn}><Link2 size={14} /></button>
                      <button onClick={() => patch({ action: 'send', staffId: a.staffId }, `send-${a.staffId}`)} disabled={busy !== ''} title={a.smsSentAt ? 'Resend text' : 'Send text'} className="os-tap" style={iconBtn}><Send size={14} /></button>
                      <button onClick={() => patch({ action: 'unassign', staffId: a.staffId }, `rm-${a.staffId}`)} disabled={busy !== ''} title="Remove" className="os-tap" style={{ ...iconBtn, color: '#fca5a5' }}><X size={14} /></button>
                    </div>
                  )}
                </div>
                <ClockStrip a={a} />
                </div>
              )
            })}
          </div>
        )}

        {reassigning && (
          <div style={{ marginTop: 14 }}>
            <input value={addPay} onChange={e => setAddPay(e.target.value)} placeholder="Pay for the next person added (optional, e.g. $175)" style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 13.5, outline: 'none', marginBottom: 10 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {staff.filter(s => !(op.assignees ?? []).some(a => a.staffId === s.id)).map(s => (
                <button key={s.id} onClick={() => patch({ action: 'assign', staffId: s.id, pay: addPay || undefined }, `add-${s.id}`)} disabled={busy !== ''} className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 11, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                  <Avatar name={s.name} size={38} />
                  <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14.5 }}>{s.name}{s.role ? <span style={{ color: 'var(--muted)', fontWeight: 500, fontSize: 12 }}> · {s.role}</span> : null}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>Reliability <b style={{ color: scoreColor(stats[s.id]?.score) }}>{stats[s.id]?.score ?? 'new'}</b>{!s.phone && <span style={{ color: '#fca5a5' }}> · no phone</span>}</div></div>
                  <Plus size={15} style={{ color: 'var(--muted)' }} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Claims — only once the route has run. Opening one from here copies the
          business, crew and financial snapshot across; nothing is re-typed. */}
      {op.status === 'completed' && (
        <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7 }}><ShieldAlert size={14} /> Claims</div>
            <button onClick={() => setClaiming(true)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>+ New claim</button>
          </div>
          {routeClaims.length === 0
            ? <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--muted)' }}>No damage claims against this route.</p>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 11 }}>
                {routeClaims.map(c => (
                  <Link key={c.id} href={`/admin/operations/claims/${c.id}`} className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', textDecoration: 'none', color: 'inherit' }}>
                    <ClaimChip status={c.status} size="sm" />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{c.claimNumber}</span>
                    <span style={{ flex: 1, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</span>
                    <span className="tabular-nums" style={{ fontWeight: 800, fontSize: 14 }}>{money(c.totalCents)}</span>
                  </Link>
                ))}
              </div>
            )}
        </div>
      )}

      {claiming && (
        <NewClaim
          routeToken={op.token}
          routeLabel={`${op.routeNumber} · ${op.businessName}`}
          onClose={() => setClaiming(false)}
        />
      )}

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

      {/* Route-level actions (send/remove are per-person on the crew card above) */}
      {live && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(op.assignees ?? []).some(a => !a.confirmedAt && !a.declinedAt) && <button onClick={confirmRoute} disabled={busy !== ''} title="They told you they're taking it — mark the route confirmed" className="btn os-tap" style={{ borderRadius: 11, height: 40, background: '#16a34a' }}><CheckCircle2 size={16} /> Mark confirmed</button>}
          {(op.assignees ?? []).some(a => a.phone && !a.smsSentAt) && <button onClick={() => patch({ action: 'send' }, 'sendall')} disabled={busy !== ''} className="btn os-tap" style={{ borderRadius: 11, height: 40 }}><Send size={15} /> Text all crew</button>}
          {canComplete && <button onClick={() => patch({ action: 'status', status: 'completed' }, 'complete')} disabled={busy !== ''} className="btn os-tap" style={{ borderRadius: 11, height: 40, background: '#16a34a' }}><CheckCircle2 size={16} /> Mark complete</button>}
          {op.status === 'confirmed' && <button onClick={() => { if (confirm("Mark this route as a no-show? It counts against the crew member's reliability score.")) patch({ action: 'status', status: 'no_show' }, 'noshow') }} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40, color: '#fca5a5' }}>No-show</button>}
          <button onClick={() => { if (confirm('Cancel this operation?')) patch({ action: 'status', status: 'cancelled' }, 'cancel') }} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40, color: '#f87171', marginLeft: 'auto' }}><XCircle size={15} /> Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── Route money (ADMIN ONLY) ─────────────────────────────────────────────────
// Business charge, each crew member's pay, total labour payout, estimated profit.
// None of this is on the public confirmation page — the crew see only their own
// pay, and only if the owner enabled it in Settings.
function RouteMoney({ op, onPatch, busy }: { op: Op; onPatch: (b: Record<string, unknown>, tag: string) => Promise<void>; busy: string }) {
  const [editing, setEditing] = useState(false)
  const [price, setPrice] = useState(centsToInput(op.financials?.businessPriceCents))
  const [pays, setPays] = useState<Record<string, string>>(() =>
    Object.fromEntries((op.assignees ?? []).map(a => [a.staffId, centsToInput(a.payCents)])))
  const [err, setErr] = useState('')

  // Re-seed the form from the live route whenever we're NOT mid-edit. The initial
  // useState only runs at mount, so a crew member added AFTER the card mounted would
  // otherwise have no `pays` entry — and Save maps over the live assignees, sending
  // that member's auto-resolved pay as a blank "clear" and silently wiping it.
  useEffect(() => {
    if (editing) return
    setPrice(centsToInput(op.financials?.businessPriceCents))
    setPays(Object.fromEntries((op.assignees ?? []).map(a => [a.staffId, centsToInput(a.payCents)])))
  }, [op, editing])

  const frozen = op.status === 'completed' || op.status === 'cancelled'
  const crew = (op.assignees ?? []).filter(a => !a.declinedAt)
  const revenue = op.financials?.businessPriceCents ?? null
  const payout = crew.reduce((s, a) => s + (a.payCents ?? 0), 0)
  const unpriced = crew.filter(a => a.payCents == null).length
  const profit = revenue == null ? null : revenue - payout

  const priceInvalid = price.trim() !== '' && !looksLikeMoney(price)
  const payInvalid = Object.values(pays).some(v => v.trim() !== '' && !looksLikeMoney(v))
  const invalid = priceInvalid || payInvalid

  async function save() {
    if (invalid) { setErr('Amounts must be positive dollar values.'); return }
    if (!price.trim()) { setErr('Enter what this route charges the client.'); return }
    setErr('')
    // A filled field sets the pay; blanking a field that HAD a pay clears it
    // (server unsets it); a field that was already empty stays a no-op.
    const crewPay = (op.assignees ?? []).map(a => {
      const v = (pays[a.staffId] ?? '').trim()
      if (v) return { staffId: a.staffId, pay: v }
      if (a.payCents != null) return { staffId: a.staffId, clear: true }
      return null
    }).filter(Boolean)
    await onPatch({ action: 'money', businessPrice: price.trim(), crewPay }, 'money')
    setEditing(false)
  }

  return (
    <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
        <div style={{ ...osLabel, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Lock size={11} /> Money · admin only
        </div>
        {!editing && !frozen && <button onClick={() => setEditing(true)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>}
      </div>

      {frozen && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 13, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
          <Lock size={13} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>This route is {op.status}. It keeps the price and pay it ran at — changing a rate elsewhere won&rsquo;t touch it.</div>
        </div>
      )}

      {!editing ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))', gap: 8, marginBottom: crew.length ? 14 : 0 }}>
            <Tile label="Business charge" val={moneyOrDash(revenue)} />
            <Tile label="Labour payout" val={money(payout)} tone={payout > 0 ? '#fca5a5' : undefined} />
            <Tile label="Est. profit" val={moneyOrDash(profit)} tone={profitColor(profit)} />
          </div>

          {revenue == null && (
            <p style={{ fontSize: 12.5, color: '#fcd34d', marginBottom: crew.length ? 12 : 0 }}>
              No contract rate for {op.businessName}. Set one on the business, or price this route by hand.
            </p>
          )}
          {unpriced > 0 && (
            <p style={{ fontSize: 12.5, color: '#fcd34d', marginBottom: crew.length ? 12 : 0 }}>
              {unpriced} crew member{unpriced === 1 ? ' has' : 's have'} no pay set — profit above is optimistic.
            </p>
          )}

          {crew.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {crew.map(a => (
                <div key={a.staffId} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13.5 }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.name}{a.role ? <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {a.role}</span> : null}
                  </span>
                  {a.paySource === 'manual' && <span style={{ fontSize: 10, fontWeight: 800, padding: '1px 7px', borderRadius: 99, background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>custom</span>}
                  <span className="tabular-nums" style={{ fontWeight: 700, color: a.payCents == null ? '#fcd34d' : 'var(--text)' }}>{a.payCents == null ? 'not set' : money(a.payCents)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>What {op.businessName} pays for this route</div>
            <MoneyInput value={price} onChange={setPrice} invalid={priceInvalid} aria-label="Business charge" disabled={busy !== ''} />
          </div>
          {crew.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>Crew pay for this route</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {crew.map(a => (
                  <div key={a.staffId} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ flex: 1, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                    <div style={{ width: 130 }}>
                      <MoneyInput value={pays[a.staffId] ?? ''} onChange={v => setPays(p => ({ ...p, [a.staffId]: v }))} invalid={!!(pays[a.staffId] ?? '').trim() && !looksLikeMoney(pays[a.staffId] ?? '')} aria-label={`Pay for ${a.name}`} disabled={busy !== ''} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>{err}</p>}
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button onClick={save} disabled={busy !== '' || invalid} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center', opacity: busy !== '' || invalid ? .55 : 1 }}>{busy === 'money' ? 'Saving…' : 'Save money'}</button>
            <button onClick={() => { setEditing(false); setErr(''); setPrice(centsToInput(op.financials?.businessPriceCents)); setPays(Object.fromEntries((op.assignees ?? []).map(a => [a.staffId, centsToInput(a.payCents)]))) }} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}

function Tile({ label, val, tone }: { label: string; val: string; tone?: string }) {
  return (
    <div style={{ padding: '11px 12px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div className="tabular-nums" style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-.02em', color: tone || 'var(--text)' }}>{val}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

const pinUrl = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
const clockTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const dur = (a: number, b: number) => {
  const mins = Math.max(0, Math.round((b - a) / 60000))
  const h = Math.floor(mins / 60), m = mins % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

// The owner's proof of where/when the crew worked. Each punch links straight to a
// Google Maps pin at the captured coordinates — tap it, tap the report address
// above, and it's obvious whether they were on-site. "Location off" means the
// crew member clocked in but their phone withheld GPS: a fact worth seeing, not a
// silent gap.
function ClockStrip({ a }: { a: Assignee }) {
  if (!a.clockInAt && !a.clockOutAt) return null
  const punch = (label: string, at: number, lat?: number, lng?: number, acc?: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
      <span style={{ fontWeight: 800, color: 'var(--muted)', width: 30 }}>{label}</span>
      <span className="tabular-nums" style={{ fontWeight: 700 }}>{clockTime(at)}</span>
      {lat != null && lng != null ? (
        <a href={pinUrl(lat, lng)} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--red)', fontWeight: 700 }}>
          <MapPin size={12} /> Verify pin{acc != null ? ` · ±${Math.round(acc)}m` : ''}
        </a>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#fcd34d', fontWeight: 700 }}>
          <ShieldAlert size={12} /> Location off
        </span>
      )}
    </div>
  )
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        <Clock size={12} /> Timeclock
        {a.clockInAt && a.clockOutAt && <span style={{ color: '#86efac', letterSpacing: 0, textTransform: 'none' }}>· {dur(a.clockInAt, a.clockOutAt)} on site</span>}
      </div>
      {a.clockInAt && punch('IN', a.clockInAt, a.clockInLat, a.clockInLng, a.clockInAccuracy)}
      {a.clockOutAt && punch('OUT', a.clockOutAt, a.clockOutLat, a.clockOutLng, a.clockOutAccuracy)}
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
