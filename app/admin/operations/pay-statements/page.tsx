'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FileText, Check, X, Ban, Mail, Plus, Clock, PencilLine } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osField as field, osLabel, Avatar, money, fmtDay, fmtTs } from '../ui'
import HistoricalPayForm from './HistoricalPayForm'
import { historicalReplacementSeed, payCorrectionTimesheetHref, type HistoricalReplacementSeed } from '../../../lib/pay-correction-workflow'

type Staff = { id: string; name: string; active: boolean }
type Statement = {
  id: string; statementNumber: string; staffId: string; staffName: string
  periodStart: string; periodEnd: string; grossCents: number; deductionCents: number; netCents: number
  routeCount: number; status: 'issued' | 'void'; issuedAt: number; emailedAt?: number
  statementSource?: 'operion_generated' | 'historical_manual'; paymentDate?: string
}
type Correction = {
  id: string; staffId: string; staffName?: string; statementNumber?: string; message: string
  periodStart?: string; periodEnd?: string
  status: 'pending' | 'approved' | 'denied'; decidedBy?: string; decisionNote?: string; createdAt: number
}

function mondayOf(d: Date): string {
  const day = (d.getDay() + 6) % 7
  const m = new Date(d); m.setDate(d.getDate() - day)
  return m.toISOString().slice(0, 10)
}

function PayStatements() {
  const [tab, setTab] = useState<'statements' | 'prior-pay' | 'corrections'>('statements')
  const [staff, setStaff] = useState<Staff[]>([])
  const [statements, setStatements] = useState<Statement[]>([])
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [forbidden, setForbidden] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingCorrection, setEditingCorrection] = useState<Correction | null>(null)
  const [historicalInitial, setHistoricalInitial] = useState<HistoricalReplacementSeed | undefined>()
  const [correctionStatement, setCorrectionStatement] = useState<Statement | null>(null)
  const [correctionResolution, setCorrectionResolution] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const correctionWorkspace = useRef<HTMLDivElement>(null)

  const today = new Date().toISOString().slice(0, 10)
  const [staffId, setStaffId] = useState('')
  const [start, setStart] = useState(mondayOf(new Date()))
  const [end, setEnd] = useState(today)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/pay-statements', { credentials: 'same-origin' })
      if (res.status === 403) { setForbidden(true); return }
      const d = await res.json()
      setStatements(d.statements ?? [])
      const [s, c] = await Promise.all([
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
        fetch('/api/admin/pay-corrections', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      ])
      setStaff(s.items ?? [])
      setCorrections(c.corrections ?? [])
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!editingCorrection) return
    const frame = requestAnimationFrame(() => correctionWorkspace.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [editingCorrection])
  useEffect(() => {
    if (!editingCorrection) {
      setCorrectionStatement(null)
      setCorrectionResolution('idle')
      return
    }
    const params = new URLSearchParams({ resolveCorrection: '1', staffId: editingCorrection.staffId })
    if (editingCorrection.statementNumber) params.set('statementNumber', editingCorrection.statementNumber)
    if (editingCorrection.periodStart) params.set('periodStart', editingCorrection.periodStart)
    if (editingCorrection.periodEnd) params.set('periodEnd', editingCorrection.periodEnd)
    const controller = new AbortController()
    setCorrectionResolution('loading')
    fetch(`/api/admin/pay-statements?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async res => ({ res, data: await res.json() }))
      .then(({ res, data }) => {
        if (!res.ok || !data.ok) throw new Error(data.error ?? 'Could not resolve current statement.')
        setCorrectionStatement(data.statement ?? null)
        setCorrectionResolution('ready')
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setCorrectionStatement(null)
        setCorrectionResolution('error')
      })
    return () => controller.abort()
  }, [editingCorrection])

  async function generate() {
    if (!staffId) { setErr('Pick a crew member.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/admin/pay-statements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ staffId, periodStart: start, periodEnd: end }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not generate.'); return }
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  async function act(id: string, action: 'email' | 'void'): Promise<boolean> {
    if (action === 'void' && !window.confirm('Void this statement? It frees the period so you can re-issue.')) return false
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/pay-statements/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Action failed.'); return false }
      if (action === 'void') {
        setCorrectionStatement(current => current?.id === id ? { ...current, status: 'void' } : current)
      }
      await load()
      return true
    } catch { setErr('Connection error — try again.'); return false } finally { setBusy(false) }
  }

  async function decideCorrection(correction: Correction, action: 'approve' | 'deny') {
    const note = action === 'deny' ? (window.prompt('Reason (optional):') ?? undefined) : undefined
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/admin/pay-corrections', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ id: correction.id, action, note }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setErr(data.error ?? 'Could not review the correction.'); return }
      await load()
      if (action === 'approve') {
        setEditingCorrection(data.correction)
      }
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  function openManualReplacement(correction: Correction, statement?: Statement) {
    setHistoricalInitial(historicalReplacementSeed(correction, statement))
    setTab('prior-pay')
  }

  if (forbidden) return (
    <div className="os-card os-rise" style={{ padding: 26, textAlign: 'center' }}>
      <p className="jkos-h" style={{ fontSize: 18 }}>Admins only</p>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Pay statements are restricted to administrators.</p>
    </div>
  )

  const pendingCorr = corrections.filter(c => c.status === 'pending').length
  const correctionStart = editingCorrection?.periodStart ?? correctionStatement?.periodStart
  const correctionEnd = editingCorrection?.periodEnd ?? correctionStatement?.periodEnd
  const timesheetHref = editingCorrection ? payCorrectionTimesheetHref(editingCorrection, correctionStatement ?? undefined) : '/admin/operations/timesheets'
  const replacementBlocked = correctionResolution !== 'ready' || correctionStatement?.status === 'issued'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Pay Statements</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Issue statements from completed Operion work or record prior pay without recreating old jobs.</p>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {(['statements', 'prior-pay', 'corrections'] as const).map(t => (
          <button key={t} onClick={() => { if (t === 'prior-pay') setHistoricalInitial(undefined); setTab(t) }} className="os-tap"
            style={{ padding: '8px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', textTransform: 'capitalize',
              color: tab === t ? '#fff' : 'var(--muted)', background: tab === t ? 'var(--red)' : 'transparent' }}>
            {t === 'prior-pay' ? 'Add prior pay' : t}{t === 'corrections' && pendingCorr > 0 ? ` (${pendingCorr})` : ''}
          </button>
        ))}
      </div>

      {err && <div className="os-card" style={{ padding: '11px 15px', color: '#fca5a5', fontSize: 14 }}>{err}</div>}

      {tab === 'statements' && (
        <>
          <div className="os-card os-rise" style={{ padding: 20 }}>
            <div style={{ ...osLabel, marginBottom: 12 }}>Generate a statement</div>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) auto', alignItems: 'end' }}>
              <div>
                <label style={osLabel}>Crew member</label>
                <select value={staffId} onChange={e => setStaffId(e.target.value)} style={{ ...field, marginTop: 6 }}>
                  <option value="">Select…</option>
                  {staff.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div><label style={osLabel}>From</label><input type="date" value={start} onChange={e => setStart(e.target.value)} style={{ ...field, marginTop: 6 }} /></div>
              <div><label style={osLabel}>To</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} style={{ ...field, marginTop: 6 }} /></div>
              <button onClick={generate} disabled={busy} className="btn os-tap" style={{ borderRadius: 12, height: 44, gap: 7, justifyContent: 'center' }}><Plus size={16} /> Generate</button>
            </div>
          </div>

          {statements.length === 0 && <div className="os-card" style={{ padding: 18 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>No statements yet.</p></div>}
          {statements.map(s => (
            <div key={s.id} className="os-card" style={{ padding: 16, opacity: s.status === 'void' ? 0.55 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar name={s.staffName} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Link href={`/admin/operations/pay-statements/${s.id}`} style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', textDecoration: 'none' }}>{s.staffName}</Link>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.statementNumber}</span>
                    {s.status === 'void' && <span style={{ fontSize: 10.5, fontWeight: 800, color: '#fca5a5' }}>VOID</span>}
                    {s.statementSource === 'historical_manual' && <span style={{ fontSize: 10.5, fontWeight: 800, color: '#93c5fd' }}>HISTORICAL</span>}
                    {s.emailedAt && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#86efac' }}>emailed</span>}
                  </div>
                  <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>{fmtDay(s.periodStart)} – {fmtDay(s.periodEnd)} · {s.statementSource === 'historical_manual' ? `prior pay${s.paymentDate ? ` · paid ${fmtDay(s.paymentDate)}` : ''}` : `${s.routeCount} completed job${s.routeCount === 1 ? '' : 's'}`} · issued {fmtTs(s.issuedAt)}</p>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <p className="jkos-h tabular-nums" style={{ fontSize: 18 }}>{money(s.netCents)}</p>
                  <p style={{ fontSize: 11, color: 'var(--muted)' }}>net</p>
                </div>
              </div>
              {s.status === 'issued' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <Link href={`/admin/operations/pay-statements/${s.id}`} className="os-tap" style={miniBtn}><FileText size={13} style={{ marginRight: 5, verticalAlign: -2 }} />View / Print</Link>
                  <button onClick={() => act(s.id, 'email')} disabled={busy} className="os-tap" style={miniBtn}><Mail size={13} style={{ marginRight: 5, verticalAlign: -2 }} />Email</button>
                  <button onClick={() => act(s.id, 'void')} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#fca5a5' }}><Ban size={13} style={{ marginRight: 5, verticalAlign: -2 }} />Void</button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {tab === 'prior-pay' && <HistoricalPayForm key={editingCorrection?.id ?? 'new'} staff={staff} initial={historicalInitial} onCreated={async () => { await load(); setHistoricalInitial(undefined); setEditingCorrection(null); setTab('statements') }} />}

      {tab === 'corrections' && (
        <>
          {editingCorrection && (
            <div ref={correctionWorkspace} className="os-card os-rise" style={{ padding: 20, borderColor: 'rgba(134,239,172,.45)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <Check size={18} color="#86efac" />
                <h2 className="jkos-h" style={{ fontSize: 18 }}>Correction approved — make the change</h2>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 7 }}>
                {editingCorrection.staffName ?? 'Crew member'}{correctionStart && correctionEnd ? ` · ${fmtDay(correctionStart)} – ${fmtDay(correctionEnd)}` : ''}{editingCorrection.statementNumber ? ` · ${editingCorrection.statementNumber}` : ''}
              </p>
              <p style={{ fontSize: 14, marginTop: 10 }}>“{editingCorrection.message}”</p>
              <div style={{ padding: '11px 13px', borderRadius: 10, background: 'rgba(255,255,255,.04)', marginTop: 14, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.5 }}>
                Issued pay stubs stay immutable. Correct the source first, then void and replace the old stub so the original remains in the audit history.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                <Link href={timesheetHref} className="os-tap" style={{ ...miniBtn, color: '#93c5fd' }}><Clock size={14} style={{ marginRight: 5 }} />Correct recorded hours</Link>
                {correctionStatement && <Link href={`/admin/operations/pay-statements/${correctionStatement.id}`} className="os-tap" style={miniBtn}><FileText size={14} style={{ marginRight: 5 }} />Open current stub</Link>}
                {correctionStatement?.status === 'issued' && <button onClick={() => act(correctionStatement.id, 'void')} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#fca5a5' }}><Ban size={14} style={{ marginRight: 5 }} />Void current stub</button>}
                <button disabled={replacementBlocked} title={replacementBlocked ? 'Operion must verify that the current stub is void first.' : undefined} onClick={() => { setStaffId(editingCorrection.staffId); if (correctionStart) setStart(correctionStart); if (correctionEnd) setEnd(correctionEnd); setTab('statements') }} className="os-tap" style={{ ...miniBtn, opacity: replacementBlocked ? 0.5 : 1 }}><PencilLine size={14} style={{ marginRight: 5 }} />Regenerate from corrected work</button>
                <button disabled={replacementBlocked} title={replacementBlocked ? 'Operion must verify that the current stub is void first.' : undefined} onClick={() => openManualReplacement(editingCorrection, correctionStatement ?? undefined)} className="os-tap" style={{ ...miniBtn, opacity: replacementBlocked ? 0.5 : 1 }}><Plus size={14} style={{ marginRight: 5 }} />Enter corrected pay manually</button>
              </div>
              {correctionResolution === 'loading' && <p role="status" style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 10 }}>Checking the current stub…</p>}
              {correctionResolution === 'error' && <p role="alert" style={{ color: '#fca5a5', fontSize: 11.5, marginTop: 10 }}>The current stub could not be verified. Replacement actions are blocked; refresh and try again.</p>}
              {correctionStatement?.status === 'issued' && <p style={{ color: '#fcd34d', fontSize: 11.5, marginTop: 10 }}>Void {correctionStatement.statementNumber} before issuing its replacement; Operion will block overlapping live stubs.</p>}
            </div>
          )}
          {corrections.length === 0 && <div className="os-card" style={{ padding: 18 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>No correction requests.</p></div>}
          {corrections.map(c => (
            <div key={c.id} className="os-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{c.staffName ?? 'Crew'}</span>
                {c.statementNumber && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{c.statementNumber}</span>}
                <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
                  color: c.status === 'pending' ? '#fcd34d' : c.status === 'approved' ? '#86efac' : '#fca5a5',
                  background: c.status === 'pending' ? 'rgba(252,211,77,.14)' : c.status === 'approved' ? 'rgba(134,239,172,.14)' : 'rgba(248,113,113,.14)' }}>{c.status}</span>
              </div>
              <p style={{ fontSize: 14, marginTop: 6 }}>“{c.message}”</p>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{fmtTs(c.createdAt)}{c.decidedBy ? ` · ${c.decidedBy}` : ''}{c.decisionNote ? ` · ${c.decisionNote}` : ''}</p>
              {c.status === 'pending' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={() => decideCorrection(c, 'approve')} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#86efac' }}><Check size={14} style={{ marginRight: 5, verticalAlign: -2 }} />Approve &amp; correct</button>
                  <button onClick={() => decideCorrection(c, 'deny')} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#fca5a5' }}><X size={14} style={{ marginRight: 5, verticalAlign: -2 }} />Deny</button>
                </div>
              )}
              {c.status === 'approved' && (
                <button onClick={() => setEditingCorrection(c)} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#93c5fd', marginTop: 12 }}><PencilLine size={14} style={{ marginRight: 5 }} />Continue correction</button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

const miniBtn: React.CSSProperties = { padding: '7px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }

export default function PayStatementsPage() {
  return <OperationsShell><PayStatements /></OperationsShell>
}
