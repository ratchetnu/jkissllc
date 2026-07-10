'use client'

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ChevronLeft, Building2, CalendarDays, FileText, Users, Lock, Play, Pause,
  HandCoins, Undo2, ShieldOff, Paperclip, Trash2, CheckCircle2,
} from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import {
  ClaimChip, CLAIM_TYPE_LABEL, RESP_COLOR, Avatar, money, moneyOrDash, fmtDay, fmtTs,
  osField, osLabel, osMiniBtn, profitColor, MoneyInput, looksLikeMoney,
} from '../../ui'
import {
  patchClaim, remainingCents, recoveredCents, assignedTotal,
  type Claim, type ClaimAssignment,
} from '../useClaims'
import ClaimGuardAssist from '../ClaimGuardAssist'
import ClaimDocuments from '../ClaimDocuments'
import { uploadEvidence } from '../evidence'

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
  const [editing, setEditing] = useState(false)

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
          <span>Reported {fmtDay(claim.reportedDate)}{claim.reportedBy ? ` by ${claim.reportedBy}` : ''}</span>
          {claim.routeNumber && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{claim.routeNumber}</span>}
          {claim.responseDeadline && <span style={{ color: '#fcd34d', fontWeight: 600 }}>Response due {fmtDay(claim.responseDeadline)}</span>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <Fig label="Recovered" value={money(collected)} tone={collected ? '#86efac' : undefined} />
          <Fig label="Still owed" value={money(owed)} tone={owed ? '#fca5a5' : undefined} />
          <Fig label="J KISS absorbs" value={money(absorbed)} tone={profitColor(absorbed ? -absorbed : 0)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <label htmlFor="cl-status" style={osLabel}>Status</label>
          <select id="cl-status" value={claim.status} disabled={busy !== ''}
            onChange={e => {
              const s = e.target.value
              // A settling status closes out the recovery — confirm it, like the
              // dedicated Waive/Close buttons do. Cancelling snaps the controlled
              // select back to the real status.
              const settling = s === 'paid' || s === 'waived' || s === 'closed'
              if (!settling || confirm(`Set this claim to “${s.replace(/_/g, ' ')}”? This closes out the recovery.`)) act({ action: 'status', status: s }, 'status')
            }}
            style={{ ...osField, width: 'auto', flex: 1, height: 38, fontSize: 13.5, cursor: 'pointer' }}>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <button onClick={() => setEditing(v => !v)} disabled={busy !== ''} className="os-tap"
            style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {editing && <ClaimEditor claim={claim} busy={busy !== ''} onSave={act} onDone={() => setEditing(false)} />}

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

      {/* ClaimGuard Assist — recommended next step + document for this claim type */}
      <ClaimGuardAssist claimType={claim.claimType} responseDeadline={claim.responseDeadline} refCode={claim.claimNumber} amountCents={claim.totalCents} />

      {/* Native documents — crew-responsibility / acknowledgment paperwork built from
          this claim's own data (complements the outbound ClaimGuard links above). */}
      <ClaimDocuments claim={claim} />

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
            // Explicit word, not an OK/Cancel confirm — OK=credit/Cancel=debit was an
            // inverted-meaning trap where one wrong click moved money the wrong way.
            const dirInput = prompt('Type "credit" to REDUCE what they owe, or "debit" to ADD to what they owe:', 'credit')
            if (dirInput === null) return
            const dir = dirInput.trim().toLowerCase()
            if (dir !== 'credit' && dir !== 'debit') { alert('Please type either "credit" or "debit".'); return }
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

// ── Edit the facts of a claim ────────────────────────────────────────────────
// Wired to PATCH action:'update'. The frozen snapshot (route/pricing at claim time)
// is never editable here — only the claim's own facts. Correcting a mis-typed claim
// type also re-points ClaimGuard Assist at the right playbook, so a wrong pick is no
// longer a delete-and-recreate (which would burn the claim number and audit trail).
function ClaimEditor({ claim, busy, onSave, onDone }: {
  claim: Claim; busy: boolean
  onSave: (b: Record<string, unknown>, tag: string) => Promise<void>
  onDone: () => void
}) {
  const [claimType, setClaimType] = useState(claim.claimType)
  const [claimDate, setClaimDate] = useState(claim.claimDate)
  const [reportedDate, setReportedDate] = useState(claim.reportedDate)
  const [reportedBy, setReportedBy] = useState(claim.reportedBy ?? '')
  const [responseDeadline, setResponseDeadline] = useState(claim.responseDeadline ?? '')
  const [total, setTotal] = useState((claim.totalCents / 100).toFixed(2))
  const [description, setDescription] = useState(claim.description)
  const [internalNotes, setInternalNotes] = useState(claim.internalNotes ?? '')
  const [businessContact, setBusinessContact] = useState(claim.businessContact ?? '')
  const [resolutionNotes, setResolutionNotes] = useState(claim.resolutionNotes ?? '')
  const [saving, setSaving] = useState(false)

  const totalInvalid = total.trim() !== '' && !looksLikeMoney(total)
  const canSave = !busy && !saving && !totalInvalid && total.trim() !== '' && description.trim() !== '' && reportedDate >= claimDate

  async function save() {
    setSaving(true)
    await onSave({
      action: 'update',
      claimType, claimDate, reportedDate,
      reportedBy: reportedBy.trim(), responseDeadline: responseDeadline.trim(),
      total, description: description.trim(),
      internalNotes: internalNotes.trim(), businessContact: businessContact.trim(),
      resolutionNotes: resolutionNotes.trim(),
    }, 'update')
    setSaving(false)
    onDone()
  }

  return (
    <div className="os-card os-expand" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ ...osLabel, marginBottom: 12 }}>Edit claim details</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label htmlFor="ce-type" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Type</label>
            <select id="ce-type" value={claimType} onChange={e => setClaimType(e.target.value as Claim['claimType'])} style={{ ...osField, cursor: 'pointer' }}>
              <optgroup label="Claimed against us (recover from crew)">
                <option value="property_damage">Property Damage</option>
                <option value="vehicle_damage">Vehicle Damage</option>
                <option value="cargo_damage">Cargo Damage</option>
                <option value="lost_item">Lost / Missing Item</option>
                <option value="injury">Injury</option>
                <option value="service_failure">Service Failure</option>
              </optgroup>
              <optgroup label="We're disputing (recover from them)">
                <option value="chargeback">Chargeback</option>
                <option value="unfair_deduction">Unfair Deduction</option>
                <option value="detention">Detention</option>
                <option value="accessorial_dispute">Accessorial Dispute</option>
                <option value="late_delivery">Late Delivery</option>
                <option value="non_payment">Non-Payment</option>
              </optgroup>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label htmlFor="ce-total" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Claim amount</label>
            <MoneyInput value={total} onChange={setTotal} invalid={totalInvalid} aria-label="Claim amount" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label htmlFor="ce-cd" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Date it happened</label>
            <input id="ce-cd" type="date" value={claimDate} onChange={e => setClaimDate(e.target.value)} style={osField} />
          </div>
          <div>
            <label htmlFor="ce-rd" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Date reported</label>
            <input id="ce-rd" type="date" value={reportedDate} min={claimDate} onChange={e => setReportedDate(e.target.value)} style={osField} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label htmlFor="ce-by" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Who reported it</label>
            <input id="ce-by" value={reportedBy} onChange={e => setReportedBy(e.target.value)} placeholder="Driver, client contact, broker…" style={osField} />
          </div>
          <div>
            <label htmlFor="ce-dl" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Response deadline <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— optional</span></label>
            <input id="ce-dl" type="date" value={responseDeadline} min={claimDate} onChange={e => setResponseDeadline(e.target.value)} style={osField} />
          </div>
        </div>

        <div>
          <label htmlFor="ce-contact" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Business contact <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— who to reach about this</span></label>
          <input id="ce-contact" value={businessContact} onChange={e => setBusinessContact(e.target.value)} placeholder="Name / phone / email" style={osField} />
        </div>

        <div>
          <label htmlFor="ce-desc" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>What happened</label>
          <textarea id="ce-desc" value={description} onChange={e => setDescription(e.target.value)} rows={3} style={{ ...osField, resize: 'vertical' }} />
        </div>

        <div>
          <label htmlFor="ce-notes" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Internal notes <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— never shown to crew or client</span></label>
          <textarea id="ce-notes" value={internalNotes} onChange={e => setInternalNotes(e.target.value)} rows={2} style={{ ...osField, resize: 'vertical' }} />
        </div>

        {(claim.status === 'closed' || claim.status === 'waived' || resolutionNotes) && (
          <div>
            <label htmlFor="ce-res" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Resolution notes</label>
            <textarea id="ce-res" value={resolutionNotes} onChange={e => setResolutionNotes(e.target.value)} rows={2} style={{ ...osField, resize: 'vertical' }} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button onClick={onDone} className="btn-ghost os-tap" style={{ borderRadius: 12, height: 42, flex: 1, justifyContent: 'center' }}>Cancel</button>
        <button onClick={save} disabled={!canSave} className="btn os-tap" style={{ borderRadius: 12, height: 42, flex: 1, justifyContent: 'center', opacity: canSave ? 1 : .5 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ── Attachments ──────────────────────────────────────────────────────────────
function Attachments({ claim, busy, onAct }: {
  claim: Claim; busy: boolean
  onAct: (b: Record<string, unknown>, tag: string) => Promise<void>
}) {
  const live = claim.attachments.filter(a => !a.removedAt)
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    if (fileInput.current) fileInput.current.value = ''
    if (!picked.length) return
    setUploading(true); setUploadErr('')
    for (const file of picked) {
      try {
        const ev = await uploadEvidence(file)
        await onAct({ action: 'attach', kind: ev.kind, url: ev.url, name: ev.name }, 'attach')
      } catch { setUploadErr('One file failed to upload — check the connection and try again.') }
    }
    setUploading(false)
  }

  return (
    <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7 }}><Paperclip size={14} /> Evidence</div>
        <label className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', cursor: (busy || uploading) ? 'wait' : 'pointer' }}>
          {uploading ? 'Uploading…' : '+ Add'}
          <input ref={fileInput} type="file" accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt" capture="environment" multiple onChange={onPick} disabled={busy || uploading} style={{ display: 'none' }} />
        </label>
      </div>
      {uploadErr && <p style={{ fontSize: 12.5, color: '#fca5a5', marginBottom: 8 }}>{uploadErr}</p>}

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
