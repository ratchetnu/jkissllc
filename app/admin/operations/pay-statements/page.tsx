'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, Check, X, Ban, Mail, Plus } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osField as field, osLabel, Avatar, money, fmtDay, fmtTs } from '../ui'

type Staff = { id: string; name: string; active: boolean }
type Statement = {
  id: string; statementNumber: string; staffId: string; staffName: string
  periodStart: string; periodEnd: string; grossCents: number; deductionCents: number; netCents: number
  routeCount: number; status: 'issued' | 'void'; issuedAt: number; emailedAt?: number
}
type Correction = {
  id: string; staffId: string; staffName?: string; statementNumber?: string; message: string
  status: 'pending' | 'approved' | 'denied'; decidedBy?: string; decisionNote?: string; createdAt: number
}

function mondayOf(d: Date): string {
  const day = (d.getDay() + 6) % 7
  const m = new Date(d); m.setDate(d.getDate() - day)
  return m.toISOString().slice(0, 10)
}

function PayStatements() {
  const [tab, setTab] = useState<'statements' | 'corrections'>('statements')
  const [staff, setStaff] = useState<Staff[]>([])
  const [statements, setStatements] = useState<Statement[]>([])
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [forbidden, setForbidden] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

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
      setStaff((s.items ?? []).filter((x: Staff) => x.active))
      setCorrections(c.corrections ?? [])
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { load() }, [load])

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

  async function act(id: string, action: 'email' | 'void') {
    if (action === 'void' && !window.confirm('Void this statement? It frees the period so you can re-issue.')) return
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/pay-statements/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Action failed.'); return }
      await load()
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  async function decideCorrection(id: string, action: 'approve' | 'deny') {
    const note = action === 'deny' ? (window.prompt('Reason (optional):') ?? undefined) : undefined
    setBusy(true)
    try {
      await fetch('/api/admin/pay-corrections', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ id, action, note }),
      })
      await load()
    } finally { setBusy(false) }
  }

  if (forbidden) return (
    <div className="os-card os-rise" style={{ padding: 26, textAlign: 'center' }}>
      <p className="jkos-h" style={{ fontSize: 18 }}>Admins only</p>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Pay statements are restricted to administrators.</p>
    </div>
  )

  const pendingCorr = corrections.filter(c => c.status === 'pending').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Pay Statements</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Generate contractor pay statements from completed work. Figures come from the pay engine — never hand-entered.</p>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {(['statements', 'corrections'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="os-tap"
            style={{ padding: '8px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', textTransform: 'capitalize',
              color: tab === t ? '#fff' : 'var(--muted)', background: tab === t ? 'var(--red)' : 'transparent' }}>
            {t}{t === 'corrections' && pendingCorr > 0 ? ` (${pendingCorr})` : ''}
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
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
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
                    {s.emailedAt && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#86efac' }}>emailed</span>}
                  </div>
                  <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>{fmtDay(s.periodStart)} – {fmtDay(s.periodEnd)} · {s.routeCount} completed job{s.routeCount === 1 ? '' : 's'} · issued {fmtTs(s.issuedAt)}</p>
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

      {tab === 'corrections' && (
        <>
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
                  <button onClick={() => decideCorrection(c.id, 'approve')} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#86efac' }}><Check size={14} style={{ marginRight: 5, verticalAlign: -2 }} />Approve</button>
                  <button onClick={() => decideCorrection(c.id, 'deny')} disabled={busy} className="os-tap" style={{ ...miniBtn, color: '#fca5a5' }}><X size={14} style={{ marginRight: 5, verticalAlign: -2 }} />Deny</button>
                </div>
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
