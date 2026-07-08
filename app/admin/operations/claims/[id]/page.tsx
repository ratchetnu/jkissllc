'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ChevronLeft, Building2, CalendarDays, FileText, Users, Lock, Play, Pause,
  HandCoins, Undo2, ShieldOff, Paperclip, Trash2, CheckCircle2,
} from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import {
  ClaimChip, CLAIM_TYPE_LABEL, RESP_COLOR, Avatar, money, moneyOrDash, fmtDay, fmtTs,
  osField, osLabel, osMiniBtn, profitColor,
} from '../../ui'
import {
  patchClaim, remainingCents, recoveredCents, assignedTotal,
  type Claim, type ClaimAssignment,
} from '../useClaims'

type Staff = { id: string; name: string; role?: string; photoUrl?: string; active: boolean }

const STATUSES = ['new', 'under_review', 'waiting_customer', 'disputed', 'approved', 'deduction_active', 'paid', 'closed', 'waived'] as const

function Detail({ id }: { id: string }) {
  const router = useRouter()
  const [claim, setClaim] = useState<Claim | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [assigning, setAssigning] = useState(false)

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        fetch(`/api/admin/claims?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()),
      ])
      if (!c.claim) setNotFound(true); else setClaim(c.claim)
      setStaff((s.items || []).filter((x: Staff) => x.active))
    } catch { setNotFound(true) } finally { setLoading(false) }
  }, [id])
  useEffect(() => { load() }, [load])

  const act = useCallback(async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setMsg('')
    const err = await patchClaim(id, body)
    if (err) setMsg(err)
    setAssigning(false)
    await load()
    setBusy('')
  }, [id, load])

  async function remove() {
    if (!confirm('Delete this claim? Its history goes with it.')) return
    setBusy('delete')
    let res = await fetch(`/api/admin/claims/${id}`, { method: 'DELETE', credentials: 'same-origin' })
    if (res.status === 409) {
      const d = await res.json()
      if (!confirm(d.message)) { setBusy(''); return }
      res = await fetch(`/api/admin/claims/${id}?confirm=1`, { method: 'DELETE', credentials: 'same-origin' })
    }
    if (res.ok) router.push('/admin/operations/claims')
    else { setMsg('Could not delete the claim.'); setBusy('') }
  }

  const owed = useMemo(() => claim?.assignments.reduce((s, a) => s + remainingCents(a), 0) ?? 0, [claim])
  const collected = useMemo(() => claim?.assignments.reduce((s, a) => s + recoveredCents(a), 0) ?? 0, [claim])

  if (loading) return <p style={{ color: 'var(--muted)' }}>Loading…</p>
  if (notFound || !claim) return <p style={{ color: 'var(--muted)' }}>That claim no longer exists.</p>

  const absorbed = Math.max(0, claim.totalCents - assignedTotal(claim))
  const settled = claim.status === 'closed' || claim.status === 'waived'
  const snap = claim.snapshot

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <button onClick={() => router.back()} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', marginBottom: 14 }}>
        <ChevronLeft size={16} /> Claims
      </button>

      {msg && <div className="os-card" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 13.5, color: '#fcd34d' }}>{msg}</div>}

      {/* Header */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <ClaimChip status={claim.status} />
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{claim.claimNumber}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{CLAIM_TYPE_LABEL[claim.claimType]}</span>
          <span className="tabular-nums" style={{ marginLeft: 'auto', fontSize: 26, fontWeight: 900, letterSpacing: '-.02em' }}>{money(claim.totalCents)}</span>
        </div>
        <h1 className="jkos-h" style={{ fontSize: 24, marginTop: 10 }}>{claim.businessName}</h1>
        <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarDays size={15} /> {fmtDay(claim.claimDate)}</span>
          <span>Reported {fmtDay(claim.reportedDate)}</span>
          {claim.routeNumber && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{claim.routeNumber}</span>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <Fig label="Recovered" value={money(collected)} tone={collected ? '#86efac' : undefined} />
          <Fig label="Still owed" value={money(owed)} tone={owed ? '#fca5a5' : undefined} />
          <Fig label="J KISS absorbs" value={money(absorbed)} tone={profitColor(absorbed ? -absorbed : 0)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <label htmlFor="cl-status" style={osLabel}>Status</label>
          <select id="cl-status" value={claim.status} disabled={busy !== ''} onChange={e => act({ action: 'status', status: e.target.value }, 'status')}
            style={{ ...osField, width: 'auto', flex: 1, height: 38, fontSize: 13.5, cursor: 'pointer' }}>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      </div>

      {/* What happened */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}><FileText size={14} /> What happened</div>
        <p style={{ fontSize: 14.5, lineHeight: 1.55 }}>{claim.description}</p>
        {claim.internalNotes && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
            <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}><Lock size={12} /> Internal — not shown to crew or client</div>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>{claim.internalNotes}</p>
          </div>
        )}
        {claim.resolutionNotes && (
          <p style={{ marginTop: 12, fontSize: 13.5, color: 'var(--muted)' }}><b style={{ color: 'var(--text)' }}>Resolution:</b> {claim.resolutionNotes}</p>
        )}
      </div>

      {/* Frozen snapshot */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}><Building2 size={14} /> At the time of the claim</div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Frozen when the claim was opened. Re-pricing the client or re-crewing the route later never changes these.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
          <Fig label="Route earned" value={moneyOrDash(snap.businessPriceCents)} />
          <Fig label="Crew paid" value={moneyOrDash(snap.routePayoutCents)} />
          <Fig label="Route profit" value={moneyOrDash(snap.routeProfitCents)} tone={profitColor(snap.routeProfitCents)} />
        </div>
        {snap.routeToken && (
          <Link href={`/admin/operations/${snap.routeToken}`} style={{ display: 'inline-block', marginTop: 12, fontSize: 13, fontWeight: 700, color: 'var(--red)', textDecoration: 'none' }}>
            View {snap.routeNumber} →
          </Link>
        )}
        {snap.crew.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <div style={{ ...osLabel, marginBottom: 8 }}>Crew on the route</div>
            {snap.crew.map(c => (
              <div key={c.staffId} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', fontSize: 13.5 }}>
                <Avatar name={c.name} size={26} />
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                {c.role && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{c.role}</span>}
                <span className="tabular-nums" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{moneyOrDash(c.payCents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Responsibility */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
          <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7 }}><Users size={14} /> Who&apos;s responsible</div>
          {!settled && (
            <button onClick={() => setAssigning(v => !v)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>
              {assigning ? 'Cancel' : claim.assignments.length ? 'Edit split' : '+ Assign crew'}
            </button>
          )}
        </div>

        {assigning && <SplitEditor claim={claim} staff={staff} busy={busy !== ''} onSave={act} />}

        {!assigning && claim.assignments.length === 0 && (
          <p style={{ marginTop: 10, color: '#fcd34d', fontWeight: 600, fontSize: 14 }}>No one is responsible yet — J KISS absorbs the full {money(claim.totalCents)}.</p>
        )}

        {!assigning && claim.assignments.map(a => (
          <Responsibility key={a.staffId} a={a} busy={busy} settled={settled} onAct={act} />
        ))}
      </div>

      <Attachments claim={claim} busy={busy !== ''} onAct={act} />

      {/* Timeline */}
      <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ ...osLabel, marginBottom: 12 }}>History</div>
        {[...claim.audit].reverse().map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 11, padding: '7px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <span className="tabular-nums" style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 100, flexShrink: 0 }}>{fmtTs(e.at)}</span>
            <span style={{ fontSize: 13.5 }}>{e.action}{e.note ? <span style={{ color: 'var(--muted)' }}> — {e.note}</span> : null}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 30 }}>
        {!settled && (
          <button onClick={() => act({ action: 'close', resolutionNotes: prompt('Resolution notes (optional):') || undefined }, 'close')} disabled={busy !== ''}
            className="btn os-tap" style={{ borderRadius: 12, height: 42, flex: 1, justifyContent: 'center' }}>
            <CheckCircle2 size={16} /> Close claim
          </button>
        )}
        <button onClick={remove} disabled={busy !== ''} className="btn-ghost os-tap" style={{ borderRadius: 12, height: 42, color: '#fca5a5' }}>
          <Trash2 size={15} /> Delete
        </button>
      </div>
    </div>
  )
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div style={{ ...osLabel, fontSize: 10 }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 16.5, fontWeight: 800, marginTop: 3, color: tone || 'var(--text)' }}>{value}</div>
    </div>
  )
}

// ── One person's responsibility + their deduction plan ───────────────────────
function Responsibility({ a, busy, settled, onAct }: {
  a: ClaimAssignment; busy: string; settled: boolean
  onAct: (b: Record<string, unknown>, tag: string) => Promise<void>
}) {
  const left = remainingCents(a)
  const paid = recoveredCents(a)
  const pct = a.responsibilityCents ? Math.round((paid / a.responsibilityCents) * 100) : 0
  const [open, setOpen] = useState(false)
  const disabled = busy !== '' || settled

  const start = () => {
    const weekly = prompt(`Weekly deduction for ${a.name}? (e.g. 50)`, a.weeklyDeductionCents ? (a.weeklyDeductionCents / 100).toFixed(2) : '')
    if (!weekly) return
    onAct({ action: 'start_deduction', staffId: a.staffId, weekly }, `start-${a.staffId}`)
  }

  return (
    <div style={{ marginTop: 12, padding: 13, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <Avatar name={a.name} size={38} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>
            {a.name}
            {a.role && <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 12 }}> · {a.role}</span>}
            <span style={{ fontWeight: 700, fontSize: 11.5, color: RESP_COLOR[a.status], marginLeft: 7 }}>{a.status}</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {money(a.responsibilityCents)}{a.responsibilityPct ? ` · ${a.responsibilityPct}%` : ''}
            {a.status === 'active' && a.weeklyDeductionCents ? ` · ${money(a.weeklyDeductionCents)}/wk` : ''}
            {a.nextDeductionOn && a.status === 'active' ? ` · next ${fmtDay(a.nextDeductionOn)}` : ''}
          </div>
        </div>
        <div className="tabular-nums" style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15.5, fontWeight: 800, color: left ? '#fca5a5' : '#86efac' }}>{money(left)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{left ? 'left' : 'settled'}</div>
        </div>
      </div>

      {/* Progress */}
      <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,.07)', marginTop: 11, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: '#86efac', transition: 'width .3s var(--os-ease)' }} />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>{money(paid)} recovered of {money(a.responsibilityCents)}{a.pausedReason ? ` · paused: ${a.pausedReason}` : ''}{a.waivedReason ? ` · waived: ${a.waivedReason}` : ''}</div>

      {!settled && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 11 }}>
          {a.status !== 'completed' && a.status !== 'waived' && (
            a.status === 'active'
              ? <button onClick={() => onAct({ action: 'pause_deduction', staffId: a.staffId, reason: prompt('Why pause it?') || undefined }, `pause-${a.staffId}`)} disabled={disabled} style={osMiniBtn} className="os-tap"><Pause size={12} /> Pause</button>
              : <button onClick={start} disabled={disabled} style={{ ...osMiniBtn, color: '#86efac' }} className="os-tap"><Play size={12} /> {a.status === 'paused' ? 'Resume' : 'Start deduction'}</button>
          )}
          {a.status === 'active' && <button onClick={start} disabled={disabled} style={osMiniBtn} className="os-tap">Change weekly</button>}
          {left > 0 && (
            <>
              <button onClick={() => { const amt = prompt(`How much did ${a.name} pay?`); if (amt) onAct({ action: 'payment', staffId: a.staffId, amount: amt, note: 'cash' }, `pay-${a.staffId}`) }} disabled={disabled} style={osMiniBtn} className="os-tap"><HandCoins size={12} /> Record payment</button>
              <button onClick={() => { const r = prompt(`Waive ${a.name}'s remaining ${money(left)}? Reason:`); if (r !== null) onAct({ action: 'waive', staffId: a.staffId, reason: r || undefined }, `waive-${a.staffId}`) }} disabled={disabled} style={{ ...osMiniBtn, color: '#fca5a5' }} className="os-tap"><ShieldOff size={12} /> Waive</button>
            </>
          )}
          <button onClick={() => {
            const amt = prompt('Adjustment amount?')
            if (!amt) return
            const dir = confirm('OK = credit (reduce what they owe)\nCancel = debit (put money back on what they owe)') ? 'credit' : 'debit'
            const reason = prompt('Reason for the adjustment?')
            if (!reason) { alert('An adjustment needs a reason.'); return }
            onAct({ action: 'adjust', staffId: a.staffId, amount: amt, direction: dir, reason }, `adj-${a.staffId}`)
          }} disabled={disabled} style={osMiniBtn} className="os-tap"><Undo2 size={12} /> Adjust</button>
        </div>
      )}

      {a.ledger.length > 0 && (
        <>
          <button onClick={() => setOpen(o => !o)} className="os-tap" style={{ ...osMiniBtn, marginTop: 11, background: 'none', border: 'none', padding: 0, color: 'var(--muted)' }}>
            {open ? 'Hide' : 'Show'} {a.ledger.length} ledger entr{a.ledger.length === 1 ? 'y' : 'ies'}
          </button>
          {open && (
            <div className="os-expand" style={{ marginTop: 8 }}>
              {a.ledger.map(e => (
                <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <span className="tabular-nums" style={{ color: 'var(--muted)', minWidth: 78 }}>{e.periodDate}</span>
                  <span style={{ flex: 1, color: 'var(--muted)' }}>{e.kind}{e.note ? ` — ${e.note}` : ''}</span>
                  <span className="tabular-nums" style={{ fontWeight: 700, color: e.direction === 'credit' ? '#86efac' : '#fca5a5' }}>
                    {e.direction === 'credit' ? '−' : '+'}{money(e.amountCents)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Split editor ─────────────────────────────────────────────────────────────
function SplitEditor({ claim, staff, busy, onSave }: {
  claim: Claim; staff: Staff[]; busy: boolean
  onSave: (b: Record<string, unknown>, tag: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'equal' | 'percent' | 'dollar'>('equal')
  const [picked, setPicked] = useState<Record<string, string>>(
    () => Object.fromEntries(claim.assignments.map(a => [a.staffId, (a.responsibilityCents / 100).toFixed(2)])),
  )
  // Crew who ran the route come first — they're who this is usually about.
  const ordered = useMemo(() => {
    const onRoute = new Set(claim.snapshot.crew.map(c => c.staffId))
    return [...staff].sort((a, b) => Number(onRoute.has(b.id)) - Number(onRoute.has(a.id)) || a.name.localeCompare(b.name))
  }, [staff, claim.snapshot.crew])

  const ids = Object.keys(picked)
  const preview = useMemo(() => {
    if (!ids.length) return 0
    if (mode === 'equal') return claim.totalCents
    if (mode === 'percent') return ids.reduce((s, i) => s + Math.round(claim.totalCents * (Number(picked[i]) || 0) / 100), 0)
    return ids.reduce((s, i) => s + Math.round((Number(picked[i]) || 0) * 100), 0)
  }, [ids, mode, picked, claim.totalCents])
  const over = preview > claim.totalCents

  const toggle = (id: string) => setPicked(p => {
    const n = { ...p }
    if (id in n) delete n[id]; else n[id] = ''
    return n
  })

  return (
    <div className="os-expand" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 7, marginBottom: 12 }}>
        {(['equal', 'percent', 'dollar'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} className="os-tap"
            style={{ flex: 1, padding: '9px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${mode === m ? 'var(--red)' : 'var(--line)'}`, background: mode === m ? 'var(--red)' : 'transparent', color: mode === m ? '#fff' : 'var(--muted)' }}>
            {m === 'equal' ? 'Equal split' : m === 'percent' ? 'By %' : 'By amount'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {ordered.map(s => {
          const on = s.id in picked
          const onRoute = claim.snapshot.crew.some(c => c.staffId === s.id)
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 9, borderRadius: 11, border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'rgba(220,38,38,.06)' : 'transparent' }}>
              <input type="checkbox" checked={on} onChange={() => toggle(s.id)} aria-label={`Hold ${s.name} responsible`} style={{ width: 17, height: 17, accentColor: 'var(--red)', cursor: 'pointer' }} />
              <Avatar name={s.name} photoUrl={s.photoUrl} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.role}{onRoute ? ' · ran this route' : ''}</div>
              </div>
              {on && mode !== 'equal' && (
                <input value={picked[s.id]} onChange={e => setPicked(p => ({ ...p, [s.id]: e.target.value }))} inputMode="decimal"
                  placeholder={mode === 'percent' ? '%' : '$'} aria-label={`${s.name}'s ${mode === 'percent' ? 'percentage' : 'amount'}`}
                  className="tabular-nums" style={{ ...osField, width: 88, height: 36, padding: '6px 9px', fontSize: 13.5 }} />
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontSize: 13 }}>
        <span style={{ color: 'var(--muted)' }}>Assigned {money(preview)} of {money(claim.totalCents)}</span>
        <span style={{ color: over ? '#fca5a5' : 'var(--muted)' }}>
          {over ? 'More than the claim' : `J KISS absorbs ${money(claim.totalCents - preview)}`}
        </span>
      </div>

      <button
        onClick={() => onSave({
          action: 'responsibility', mode,
          members: ids.map(i => ({ staffId: i, value: mode === 'equal' ? undefined : Number(picked[i]) || 0 })),
        }, 'split')}
        disabled={busy || !ids.length || over}
        className="btn os-tap" style={{ borderRadius: 11, height: 42, width: '100%', justifyContent: 'center', marginTop: 12, opacity: busy || !ids.length || over ? .5 : 1 }}>
        Save responsibility
      </button>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 9 }}>Assigning does not deduct anything. Start a weekly plan below when you&apos;re ready.</p>
    </div>
  )
}

// ── Attachments ──────────────────────────────────────────────────────────────
function Attachments({ claim, busy, onAct }: {
  claim: Claim; busy: boolean
  onAct: (b: Record<string, unknown>, tag: string) => Promise<void>
}) {
  const live = claim.attachments.filter(a => !a.removedAt)
  return (
    <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7 }}><Paperclip size={14} /> Evidence</div>
        <button onClick={() => {
          const url = prompt('Paste the photo, video or document URL (https):')
          if (!url) return
          const kind = /\.(mp4|mov|webm)$/i.test(url) ? 'video' : /\.(pdf|docx?|xlsx?)$/i.test(url) ? 'document' : 'photo'
          onAct({ action: 'attach', kind, url, name: prompt('Label (optional):') || undefined }, 'attach')
        }} disabled={busy} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Add</button>
      </div>

      {live.length === 0 ? <p style={{ fontSize: 13.5, color: 'var(--muted)' }}>No photos or documents attached.</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {live.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', minWidth: 56 }}>{a.kind}</span>
              <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || a.url}</a>
              <button onClick={() => { if (confirm('Remove this attachment? The claim history keeps a record that it existed.')) onAct({ action: 'detach', attachmentId: a.id }, 'detach') }}
                disabled={busy} aria-label="Remove attachment" className="os-tap" style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer' }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <OperationsShell><Detail id={id} /></OperationsShell>
}
